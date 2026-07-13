using System.IO;
using Unity.CodeEditor;
using UnityEditor;
using UnityEngine;

namespace Unterm.Editor
{
    /// <summary>
    /// The file extensions the Unterm code editor claims, user-editable under
    /// "Preferences &gt; Unterm &gt; Code Editor" (semicolon-separated; dots and
    /// case don't matter). The VSCode/Rider packages gate opening on Unity's C#
    /// project-generation extension settings because for them "openable" means
    /// "part of the generated project" — Unterm generates no .csproj at all, so
    /// borrowing a generation setting it never runs would be misleading; it keeps
    /// its own list instead. The default covers Unity's code/text formats plus the
    /// docs, configs and native-plugin sources an agent transcript typically links.
    /// </summary>
    internal static class UntermOpenExtensions
    {
        private const string Key = "Unterm.CodeEditor.OpenExtensions";

        public const string Default =
            "cs;uxml;uss;shader;compute;cginc;hlsl;glslinc;template;raytrace;" +
            "asmdef;asmref;rsp;json;log;txt;xml;md;markdown;yml;yaml;toml;ini;cfg;csv;tsv;properties;" +
            "js;ts;py;rs;lua;sh;bat;ps1;c;h;cc;cpp;hpp;mm;m;swift;java;kt;gradle;pro;plist;html;css;" +
            "gitignore;gitattributes";

        public static string Value
        {
            get => EditorPrefs.GetString(Key, Default);
            set => EditorPrefs.SetString(Key, value);
        }

        /// Whether `ext` (no dot) is in the configured list. Parses on each call —
        /// this sits behind user clicks, never a per-frame path.
        public static bool Contains(string ext)
        {
            foreach (var e in Value.Split(';'))
                if (string.Equals(e.Trim().TrimStart('.'), ext,
                        System.StringComparison.OrdinalIgnoreCase))
                    return true;
            return false;
        }
    }

    /// <summary>
    /// Registers the Unterm code editor as a selectable "External Script Editor"
    /// (Preferences &gt; External Tools). When Unterm is chosen, every script open
    /// Unity routes through the configured editor lands in
    /// <see cref="UntermCodeEditorWindow"/> — double-click, compile-error jump,
    /// "Open C# Project", and the agent transcript's path clicks (which go through
    /// <c>CodeEditor.Editor.CurrentCodeEditor.OpenProject</c>). This replaces the old
    /// OnOpenAsset hijack + preference toggle with Unity's standard mechanism.
    /// </summary>
    [InitializeOnLoad]
    internal sealed class UntermExternalCodeEditor : IExternalCodeEditor
    {
        // One-shot hint: the next OpenProject should open a Markdown file in preview
        // (rendered) rather than edit mode. Set by the transcript / preview link
        // flow just before it routes through the generic OpenProject, and consumed
        // (cleared) here — so only a link click in a rendered view prefers preview,
        // while a Project-window double-click (which also lands in OpenProject) opens
        // in edit mode. A different selected external editor never reads it.
        internal static bool NextOpenPrefersPreview;

        // Unity's package id, used to recognize our stored selection by identity
        // rather than an exact path (see TryGetInstallationForPath).
        private const string PackageId = "dev.tnayuki.unterm";

        // The "installation path" Unity stores as the selected editor. Unterm is
        // in-editor (no executable), but Unity's dropdown only lists installations
        // whose path exists on disk. The compiled assembly is real and stable within
        // a project, and unlike a package.json path it remains valid when Unterm is
        // embedded under another package's Editor/ThirdParty subtree. The identity
        // fallback below still recognizes selections made by standalone upstream
        // package versions that used package.json as their installation path.
        internal static readonly string EditorKey =
            Path.GetFullPath(typeof(UntermExternalCodeEditor).Assembly.Location);

        static UntermExternalCodeEditor()
        {
            try
            {
                CodeEditor.Register(new UntermExternalCodeEditor());
                // After a package update the stored selection still points at the
                // PREVIOUS cache path (a git/UPM install resolves to
                // `Library/PackageCache/dev.tnayuki.unterm@<hash>/`, and `<hash>`
                // changes each update). Opens still route here — the current-editor
                // resolution matches by identity — but Unity's Preferences dropdown
                // compares exact paths, so it would show Unterm as unselected. Refresh
                // the stored path to the current one so the dropdown stays correct.
                // Deferred so it runs once the editor is settled, not mid-registration.
                EditorApplication.delayCall += RefreshSelectionIfOurs;
            }
            catch (System.Exception e)
            {
                Debug.LogError("[Unterm] External editor registration failed: " + e);
            }
        }

        // If the selected external editor is a previous build of THIS package (its
        // cache path changed on update), re-store the current path so the selection
        // is recognized exactly, not just by identity. No-op when it's already current
        // or when the user has chosen a different editor.
        private static void RefreshSelectionIfOurs()
        {
            try
            {
                // Unity stores the selection under this pref (see CodeEditor's own
                // CurrentEditorPath); read it directly to avoid an internal API.
                string stored = EditorPrefs.GetString("kScriptsDefaultApp", string.Empty);
                if (stored != EditorKey && IdentifiesPackage(stored))
                    CodeEditor.SetExternalScriptEditor(EditorKey);
            }
            catch (System.Exception e)
            {
                Debug.LogWarning("[Unterm] External editor selection refresh failed: " + e);
            }
        }

        public CodeEditor.Installation[] Installations { get; } =
        {
            new CodeEditor.Installation { Name = "Unterm Code Editor", Path = EditorKey },
        };

        public bool TryGetInstallationForPath(string editorPath, out CodeEditor.Installation installation)
        {
            // Match the current path OR any package.json belonging to this package.
            // Unity stores the selected editor as the path it had when chosen; after a
            // package update relocates the package (the UPM cache folder's `@<hash>`
            // changes), that stored path no longer equals `EditorKey`. Keying only off
            // the exact string would then make Unity treat Unterm as unselected and
            // silently route script / Markdown opens to another editor (or the OS).
            // Recognizing it by identity keeps the selection across updates.
            if (editorPath == EditorKey || IdentifiesPackage(editorPath))
            {
                installation = Installations[0];
                return true;
            }
            installation = default;
            return false;
        }

        // Whether `editorPath` is this package's `package.json`, wherever it currently
        // resolves — embedded (`.../dev.tnayuki.unterm/package.json`) or UPM-cached
        // (`.../dev.tnayuki.unterm@<hash>/package.json`).
        private static bool IdentifiesPackage(string editorPath)
        {
            if (string.IsNullOrEmpty(editorPath)) return false;
            if (!string.Equals(Path.GetFileName(editorPath), "package.json",
                    System.StringComparison.OrdinalIgnoreCase))
                return false;
            string dir = Path.GetFileName(Path.GetDirectoryName(editorPath) ?? "");
            return dir == PackageId
                || dir.StartsWith(PackageId + "@", System.StringComparison.Ordinal);
        }

        public void Initialize(string editorInstallationPath) { }

        // Unterm highlights with tree-sitter and completes with in-process Roslyn, so
        // it needs no generated .sln/.csproj — syncing is a no-op.
        public void SyncIfNeeded(string[] addedFiles, string[] deletedFiles, string[] movedFiles,
            string[] movedFromFiles, string[] importedFiles) { }

        public void SyncAll() { }

        public void OnGUI()
        {
            EditorGUILayout.HelpBox(
                "Unterm opens scripts in its in-editor code editor (tree-sitter highlighting, " +
                "Roslyn completion). No external application or solution files are used.",
                MessageType.None);
        }

        public bool OpenProject(string filePath = "", int line = -1, int column = -1)
        {
            if (string.IsNullOrEmpty(filePath))
            {
                // "Open C# Project" with no specific file: just surface the editor.
                UntermCodeEditorWindow.OpenEmpty();
                return true;
            }
            if (!File.Exists(filePath)) return false;
            // Consume the one-shot preview hint (only meaningful for Markdown).
            bool preview = NextOpenPrefersPreview;
            NextOpenPrefersPreview = false;
            // Only claim files we consider code/text. Scenes, prefabs, materials and
            // other binary/asset opens Unity routes through here must fall through
            // (return false) so Unity's own handler opens them — otherwise a scene
            // double-click would land in the text editor.
            if (!HandlesExtension(filePath)) return false;
            UntermCodeEditorWindow.OpenPath(filePath, line, preview);
            return true;
        }

        // Decides which double-clicked assets Unterm claims: the extension list
        // configured under Preferences &gt; Unterm (<see cref="UntermOpenExtensions"/>).
        // Anything else — scenes, prefabs, materials, other assets — is declined so
        // Unity opens it with its native handler. The transcript path-click flow
        // (<see cref="UntermCodeEditorWindow.OpenFromAgent"/>) reaches this through
        // <see cref="OpenProject"/> and falls back to Unity's own open on decline.
        internal static bool HandlesExtension(string filePath)
        {
            string ext = Path.GetExtension(filePath).TrimStart('.');
            return ext.Length > 0 && UntermOpenExtensions.Contains(ext);
        }
    }
}
