using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Text.RegularExpressions;
using Unity.CodeEditor;
using UnityEditor;
using UnityEditor.ShortcutManagement;
using UnityEngine;

namespace Unterm.Editor
{
    /// <summary>
    /// User-configurable code-editor settings, persisted in <see cref="EditorPrefs"/>
    /// (shared across projects, like the editor's other preferences). Surfaced in
    /// "Preferences ▸ Unterm" and applied to each native editor as it opens.
    /// </summary>
    internal static class UntermCodeEditorPrefs
    {
        private const string UndoLimitKey = "Unterm.CodeEditor.UndoLimit";

        /// Default retained undo steps (mirrors the native default).
        public const int DefaultUndoLimit = 500;

        /// Cap on retained undo steps (0 = unlimited). A line operation can hold a
        /// whole replaced block, so this bounds the editor's memory over a long
        /// session.
        public static int UndoLimit
        {
            get => Mathf.Max(0, EditorPrefs.GetInt(UndoLimitKey, DefaultUndoLimit));
            set => EditorPrefs.SetInt(UndoLimitKey, Mathf.Max(0, value));
        }
    }

    /// <summary>
    /// A syntax-highlighted code editor window. A single native "EditorView" (the
    /// `editorview` module — an InputBox in code-editor mode: tree-sitter
    /// highlighting + a line-number gutter) owns the editing surface; this
    /// <see cref="EditorWindow"/> is a thin host that lays it out, blits its
    /// texture, forwards raw input, drives the OS clipboard + hidden IME field,
    /// and reads/writes the file on disk.
    ///
    /// The view lives in a process-global native registry, so unsaved edits
    /// survive C# domain reloads (re-adopted by a serialized id). It is opened by
    /// right-clicking a script asset, from Window ▸ Unterm ▸ Code Editor, or — when
    /// enabled in Preferences — by double-clicking a file.
    /// </summary>
    public sealed class UntermCodeEditorWindow : EditorWindow, IHasCustomMenu
    {
        private const string InputControl = "UntermCodeEditorInput";

        private UntermNative _native;
        private string _status = "";

        // The EditorView lives in the native plugin (survives reloads), referenced
        // by a stable id we serialize and re-adopt.
        [SerializeField] private long _editorId;
        private static bool s_reloading;
        private ulong Eid => (ulong)_editorId;

        // The file being edited and its on-disk line ending. Buffer text is kept LF
        // internally; we restore the original ending on save.
        [SerializeField] private string _filePath = "";
        [SerializeField] private bool _crlf;
        [SerializeField] private string _langToken = "";
        [SerializeField] private bool _dirty;
        // The native editor's document version (see unterm_editor_edit_serial) as of
        // the last load/save. `_dirty` is recomputed by comparing the live version to
        // this — undo/redo restore versions, so undoing back to the saved state reads
        // clean, with no second copy of the buffer (just this u64).
        [SerializeField] private ulong _savedSerial;
        private double _lastExtCheck; // throttle for the on-disk change poll
        private double _lastDiffPoll;
        private const double ExternalCheckInterval = 1.0;
        private const double DiffPollInterval = 0.05;
        // A background git-base fetch is in flight (kicked by SetPath/RefreshDiff);
        // poll it at a bounded cadence while the editor is focused.

        // Editing surface texture (zero-copy wrap of the native MTLTexture).
        private Texture2D _tex;
        private readonly Dictionary<IntPtr, Texture2D> _surfaceTextures =
            new Dictionary<IntPtr, Texture2D>();
        private int _surfaceTextureW, _surfaceTextureH;

        // Last size/theme pushed to native, so RenderView (which runs per
        // keystroke/drag/scroll) skips those P/Invokes when nothing changed.
        // Reset in LoadNative so a fresh or re-adopted view is always sent both.
        private uint _sentW, _sentH;
        private float _sentPpp;
        private Color _sentBg;
        private bool _sentDark;
        private bool _themeSent;

        // IME: a hidden IMGUI field at the caret drives composition + plain typing;
        // committed text is flushed into the native editor each Repaint.
        private string _imeBuffer = "";
        private string _lastPreedit = "";
        private bool _composing;
        private bool _prevComposing;
        private bool _composeJustEnded;
        private bool _refocus;
        private GUIStyle _imeHidden;
        private bool _mouseDragging;

        // Markdown preview: a read-only rendered view of the LIVE buffer (unsaved
        // edits included), served by the native EditorView's document-mode panel.
        // Only offered for Markdown files. Serialized so a domain reload keeps the
        // mode; re-applied to the native view in LoadNative.
        [SerializeField] private bool _preview;
        // Preview click-to-open: the file-path token under the press, opened on a
        // release that didn't drag (a drag is a text selection instead).
        private bool _pvMoved;
        private string _pvDownToken = "";

        // Find / replace / goto bar overlay.
        private enum BarMode { None, Find, Replace, Goto }
        private BarMode _bar = BarMode.None;
        private string _findText = "", _replaceText = "", _gotoText = "";
        private bool _findCase;
        private string _findStatus = "";
        private bool _focusBar;
        private const string FindField = "UntermFindField";
        private const float ScrollbarWidth = 13f;

        // Shortcut hints for menu labels, with a space between each modifier and key.
#if UNITY_EDITOR_OSX
        private const string KCmd = "⌘", KAlt = "⌥", KShift = "⇧", KSep = " ";
#else
        private const string KCmd = "Ctrl", KAlt = "Alt", KShift = "Shift", KSep = " + ";
#endif

        // Last on-disk modification time, to detect external edits.
        [SerializeField] private long _fileTicks;

        // Autocomplete popup (Stage 1: C# keywords + identifiers already in the
        // buffer; semantic/Roslyn member completion is a later stage).
        private bool _complOpen;
        private List<string> _complItems = new List<string>();   // insert text (bare names)
        private List<string> _complLabels = new List<string>();  // display text (name + type/sig)
        private List<char> _complKinds = new List<char>();       // kind tag per item (for coloring)
        // Caret screen position (POINTS, top-left) + scale, cached each OnGUI so the
        // native popup can be (re)shown from EditorApplication.update where
        // GUIToScreenPoint is unavailable.
        private float _popupAnchorX, _popupAnchorY, _popupScale = 1f;
        private float _popupAnchorTopY; // caret TOP (points); the signature hint anchors above it
        // Member-completion cache: the full member list for a given member-access, so
        // typing more of the member name filters in C# instead of re-running Roslyn.
        private List<(string insert, string label, char kind)> _memberCache;
        private int _memberAnchor = -1; // doc offset of the word's start
        // Completion mode the cache/request is for: 0 = general (scope), 1 = member
        // (after `.`), 2 = attribute (after `[`).
        private int _cacheMode;
        // Background Roslyn request in flight (so typing never blocks on analysis).
        // The work runs on the shared UntermCompletionWorker thread.
        private long _pendingSeq;       // 0 = none in flight
        private int _pendingAnchor;
        private int _pendingMode;
        private int _complSel;
        private int _complScroll; // popup view offset (top index); wheel moves this
        private int _complPrefixLen;
        private const int ComplRows = 10; // visible popup rows (matches native MAX_ROWS)
        // Signature help (parameter hints), computed on UntermSignatureWorker.
        private long _sigSeq;             // 0 = none in flight
        private int _sigReqOff = -1;      // caret offset the in-flight/last request was for
        private UntermRoslynCompletion.SigHelp _sig;
        private bool _sigOpen;
        private static readonly string[] s_csKeywords =
        {
            "abstract", "as", "async", "await", "base", "bool", "break", "byte", "case",
            "catch", "char", "checked", "class", "const", "continue", "decimal", "default",
            "delegate", "do", "double", "else", "enum", "event", "explicit", "extern",
            "false", "finally", "fixed", "float", "for", "foreach", "get", "goto", "if",
            "implicit", "in", "int", "interface", "internal", "is", "lock", "long",
            "nameof", "namespace", "new", "null", "object", "operator", "out", "override",
            "params", "partial", "private", "protected", "public", "readonly", "ref",
            "return", "sbyte", "sealed", "set", "short", "sizeof", "stackalloc", "static",
            "string", "struct", "switch", "this", "throw", "true", "try", "typeof", "uint",
            "ulong", "unchecked", "unsafe", "ushort", "using", "value", "var", "virtual",
            "void", "volatile", "when", "while", "yield",
        };

        // --- opening -----------------------------------------------------------

        [MenuItem("Window/Unterm/Code Editor")]
        public static void OpenEmpty()
        {
            var w = CreateWindow<UntermCodeEditorWindow>();
            w.titleContent = UntermWindowTitle.Create("Code Editor", UntermWindowTitle.CodeEditorIcon, w.titleContent);
            w.minSize = new Vector2(320, 200);
            w.Show();
            w.Focus();
        }

        [MenuItem("Assets/Open in Unterm Code Editor", false, 19)]
        private static void OpenSelected()
        {
            var path = AssetDatabase.GetAssetPath(Selection.activeObject);
            if (!string.IsNullOrEmpty(path)) OpenPath(path);
        }

        [MenuItem("Assets/Open in Unterm Code Editor", true)]
        private static bool OpenSelectedValidate()
        {
            var path = AssetDatabase.GetAssetPath(Selection.activeObject);
            return !string.IsNullOrEmpty(path) && File.Exists(path) && !Directory.Exists(path);
        }

        // Open a file path clicked in the Claude Code transcript. `root` resolves a
        // project-relative path (the agent often reports paths relative to its
        // working directory). The transcript underlines every existing file, so any
        // click must land somewhere: the configured script editor first (when Unterm
        // is selected in External Tools, code/text files open here), then Unity's
        // asset pipeline for anything the editor declined (a scene loads, a prefab
        // opens in prefab mode, an image in its associated app), and the OS default
        // app for files outside the asset database. No-op only for missing files.
        public static void OpenFromAgent(string path, string root)
        {
            if (string.IsNullOrEmpty(path)) return;
            if (!Path.IsPathRooted(path) && !string.IsNullOrEmpty(root))
                path = Path.Combine(root, path);
            if (Directory.Exists(path) || !File.Exists(path)) return;
            string full = Path.GetFullPath(path);
            // A link clicked in a rendered view (the agent transcript or a Markdown
            // preview) is a reading action, so a linked Markdown file opens in
            // preview by default. The hint is honored only by Unterm's OpenProject
            // (a different selected external editor ignores it and opens normally);
            // clear it afterwards so it can't leak into a later, unrelated open.
            UntermExternalCodeEditor.NextOpenPrefersPreview = IsMarkdownPath(full);
            try
            {
                if (CodeEditor.Editor.CurrentCodeEditor?.OpenProject(full, -1, -1) == true)
                    return;
            }
            finally
            {
                UntermExternalCodeEditor.NextOpenPrefersPreview = false;
            }
            string rel = FileUtil.GetProjectRelativePath(full.Replace('\\', '/'));
            var asset = string.IsNullOrEmpty(rel) ? null : AssetDatabase.LoadMainAssetAtPath(rel);
            if (asset != null) AssetDatabase.OpenAsset(asset);
            else EditorUtility.OpenWithDefaultApp(full);
        }

        // Reuse an already-open window for the same file; otherwise a new one. `line`
        // is 1-based (-1 = none) and jumps the caret once the editor is ready.
        // `preview` opens a new Markdown window rendered rather than in edit mode; an
        // already-open window keeps whatever mode it's in (it may be mid-edit).
        internal static void OpenPath(string path, int line = -1, bool preview = false)
        {
            string full = Path.GetFullPath(path);
            foreach (var w in Resources.FindObjectsOfTypeAll<UntermCodeEditorWindow>())
            {
                if (!string.IsNullOrEmpty(w._filePath) &&
                    Path.GetFullPath(w._filePath) == full)
                {
                    w.Focus();
                    w.RequestGoto(line);
                    return;
                }
            }
            // Open as a TAB in the central editing area, not a floating window.
            // CreateWindow(desiredDockNextTo) only "attempts" docking and is ignored
            // for arbitrary types, so dock explicitly via the internal DockArea.
            var win = CreateInstance<UntermCodeEditorWindow>();
            win.minSize = new Vector2(320, 200);
            DockIntoCenter(win);
            // Set the preview intent before LoadFile: LoadFile applies it (gated to
            // Markdown via CanPreview) once the native view is ready.
            win._preview = preview;
            win.LoadFile(path);
            win._pendingLine = line; // applied once the native editor is ready
            win.Focus();
        }

        // Jump the caret to a 1-based line (-1 = none). Deferred to OnEditorUpdate
        // when the native editor isn't ready yet (a freshly opened window).
        private int _pendingLine = -1;
        private void RequestGoto(int line)
        {
            if (line <= 0) return;
            if (_native != null && _editorId != 0)
            {
                _native.EditorGotoLine(Eid, (uint)(line - 1));
                Repaint();
            }
            else
            {
                _pendingLine = line;
            }
        }

        // Dock `win` as a tab into the central editing area. Unity 6.3: the target's
        // EditorWindow.m_Parent is a HostView (a DockArea when docked); call
        // DockArea.AddTab(EditorWindow, bool). Distinguishing the dock LOCATION uses
        // on-screen position (EditorWindow.position is in screen coords).
        private static readonly FieldInfo ParentField =
            typeof(EditorWindow).GetField("m_Parent", BindingFlags.Instance | BindingFlags.NonPublic);

        private static void DockIntoCenter(EditorWindow win)
        {
            object dock = CenterDockArea();
            if (dock == null) { win.Show(); return; } // no dock area at all: float
            var addTab = dock.GetType().GetMethod(
                "AddTab", new[] { typeof(EditorWindow), typeof(bool) });
            addTab.Invoke(dock, new object[] { win, true });
        }

        // The DockArea at the center of the layout — the main editing area — chosen
        // by screen position so a file docks there, not in a side panel
        // (Hierarchy/Inspector) or a right-docked Claude Code window. Only windows
        // ACTUALLY docked (m_Parent is a DockArea) are considered;
        // Resources.FindObjectsOfTypeAll also returns unparented instances.
        private static object CenterDockArea()
        {
            var cands = new List<(EditorWindow w, object dock)>();
            Rect union = default;
            bool any = false;
            foreach (var w in Resources.FindObjectsOfTypeAll<EditorWindow>())
            {
                if (w == null || w is UntermCodeEditorWindow) continue;
                Rect r = w.position;
                if (r.width < 1f || r.height < 1f) continue;
                object dock = ParentField.GetValue(w);
                if (dock == null || dock.GetType().Name != "DockArea") continue;
                cands.Add((w, dock));
                union = any ? RectUnion(union, r) : r;
                any = true;
            }
            if (cands.Count == 0) return null;

            Vector2 center = union.center;
            object centerDock = null, largestDock = null;
            float bestArea = 0f, centerArea = 0f;
            foreach (var (w, dock) in cands)
            {
                Rect r = w.position;
                float a = r.width * r.height;
                if (a > bestArea) { bestArea = a; largestDock = dock; }
                if (r.Contains(center) && a > centerArea) { centerArea = a; centerDock = dock; }
            }
            return centerDock ?? largestDock;
        }

        private static Rect RectUnion(Rect a, Rect b)
        {
            float x = Mathf.Min(a.xMin, b.xMin);
            float y = Mathf.Min(a.yMin, b.yMin);
            float xMax = Mathf.Max(a.xMax, b.xMax);
            float yMax = Mathf.Max(a.yMax, b.yMax);
            return new Rect(x, y, xMax - x, yMax - y);
        }

        // Extension -> tree-sitter language token (null = no grammar / plain). We
        // bundle C# and Markdown grammars; others fall through to plain.
        private static string LangTokenFor(string path)
        {
            switch (Path.GetExtension(path).ToLowerInvariant())
            {
                case ".cs": return "cs";
                case ".md":
                case ".markdown": return "md";
                default: return null;
            }
        }

        // Whether `path` is a Markdown file (the preview toggle is offered only then).
        internal static bool IsMarkdownPath(string path)
        {
            switch (Path.GetExtension(path ?? "").ToLowerInvariant())
            {
                case ".md":
                case ".markdown": return true;
                default: return false;
            }
        }

        private bool CanPreview =>
            _native != null && _native.EditorPreviewSupported && IsMarkdownPath(_filePath);

        // Flip Markdown preview on/off. Preview is read-only, so it also drops the
        // completion popup / signature hint and closes the find bar.
        private void TogglePreview()
        {
            if (!CanPreview && !_preview) return;
            SetPreview(!_preview);
        }

        private void SetPreview(bool on)
        {
            if (_native == null || _editorId == 0) return;
            _preview = on && CanPreview;
            _native.EditorSetPreview(Eid, _preview);
            if (_preview)
            {
                CloseCompletion();
                CloseSignatureHelp();
                if (_bar != BarMode.None) CloseBar();
            }
            else
            {
                _refocus = true; // hand focus back to the editing surface
                // Diff polling paused while previewing: re-read HEAD + index now so
                // the gutter reflects any commits / staging done in the meantime.
                _native.EditorRefreshDiff(Eid);
            }
            UpdateTitle();
            RenderView();
            Repaint();
        }

        // Decide the line ending to preserve: keep the file's if it has one
        // (CRLF if any \r\n present, else LF), otherwise the OS default.
        private static bool DetectCrlf(string text)
        {
            if (text.Contains("\r\n")) return true;
            if (text.IndexOf('\n') >= 0) return false;
            return Environment.NewLine == "\r\n";
        }

        private void LoadFile(string path)
        {
            _filePath = path;
            string text = "";
            try { text = File.ReadAllText(path); }
            catch (Exception e) { _status = "read failed: " + e.Message; }
            _crlf = DetectCrlf(text);
            text = text.Replace("\r\n", "\n").Replace("\r", "\n");
            _langToken = LangTokenFor(path) ?? "";
            // Warm Roslyn off the typing path so the first `.` doesn't stall.
            if (_langToken == "cs")
                EditorApplication.delayCall += UntermRoslynCompletion.Warmup;
            // (line ending decided above; _crlf maintains the file's, else OS default)
            _fileTicks = File.Exists(path) ? File.GetLastWriteTimeUtc(path).Ticks : 0;
            _dirty = false;
            UpdateTitle();
            if (_native != null && _editorId != 0)
            {
                _native.EditorSetLanguage(Eid, _langToken);
                _native.EditorSetText(Eid, text);
                if (UntermDebuggerPrefs.Enabled)
                    _native.EditorSetBreakpoints(Eid, UntermBreakpoints.For(_filePath)); // restore dots
                _savedSerial = _native.EditorEditSerial(Eid); // baseline: just-loaded = clean
                _native.EditorSetPath(Eid, _filePath); // fetch git texts for diff gutter markers
                // A non-Markdown file can't be previewed: drop the mode carried over
                // from a previously-open Markdown file in this window.
                if (_preview && !CanPreview) _preview = false;
                _native.EditorSetPreview(Eid, _preview);
                RenderView();
                Repaint();
            }
        }

        // --- lifecycle ---------------------------------------------------------

        private static string ProjectRoot =>
            Directory.GetParent(Application.dataPath)?.FullName ?? Application.dataPath;

        private void OnEnable()
        {
            s_reloading = false;
            AssemblyReloadEvents.beforeAssemblyReload += OnBeforeReload;
            EditorApplication.update += OnEditorUpdate;
            wantsMouseMove = true; // hover over a gutter diff marker shows its peek tooltip
            // New/untitled buffer: default to the OS line ending until a file is
            // loaded (which then maintains that file's ending).
            if (string.IsNullOrEmpty(_filePath)) _crlf = Environment.NewLine == "\r\n";
            // `_dirty` is serialized and survives a domain reload, but `hasUnsavedChanges`
            // is reset to false by Unity on reload. Re-sync it, or MarkDirty()'s
            // `if (_dirty) return` would keep the unsaved indicator off forever after
            // the first recompile.
            hasUnsavedChanges = _dirty;
            if (_dirty && !string.IsNullOrEmpty(_filePath))
                saveChangesMessage = $"{Path.GetFileName(_filePath)} has unsaved changes.";
            LoadNative();
            // Re-derive dirty from the native version now the view is adopted (the
            // serialized flag is just the pre-reload display value).
            MarkDirty();
            UpdateTitle();
            UntermDebuggerPrefs.Changed += OnDebuggerPrefChanged;
            // The debugger toggling a breakpoint (while we run) writes the store; refresh
            // this file's dots when that happens.
            UntermBreakpoints.Changed += OnBreakpointsChanged;
        }

        // Debugging toggled in Preferences: re-apply the gutter mode (dot column) and
        // show/clear this file's breakpoint dots immediately.
        private void OnDebuggerPrefChanged()
        {
            if (_native == null || _editorId == 0) return;
            _native.EditorSetBpGutter(Eid, UntermDebuggerPrefs.Enabled);
            OnBreakpointsChanged();
        }

        // The shared store changed on disk (debugger-side toggle): re-apply this file's
        // dots. No-op'd cheaply when the file/line set is unchanged.
        private void OnBreakpointsChanged()
        {
            if (_native == null || _editorId == 0) return;
            _native.EditorSetBreakpoints(Eid,
                UntermDebuggerPrefs.Enabled && !string.IsNullOrEmpty(_filePath)
                    ? UntermBreakpoints.For(_filePath)
                    : Array.Empty<uint>());
            RenderView();
            Repaint();
        }

        private void OnBeforeReload()
        {
            // A domain reload (recompile) re-adopts the native view by id, so live
            // edits survive without a snapshot; only `s_reloading` needs to carry that
            // intent to OnDisable. We deliberately persist NO buffer content: an editor
            // restart reopens the file fresh from disk, carrying over neither clean nor
            // unsaved edits (Unity's unsaved-changes prompt handles saving on quit).
            s_reloading = true;
        }

        private void OnDisable()
        {
            UntermDebuggerPrefs.Changed -= OnDebuggerPrefChanged;
            UntermBreakpoints.Changed -= OnBreakpointsChanged;
            AssemblyReloadEvents.beforeAssemblyReload -= OnBeforeReload;
            EditorApplication.update -= OnEditorUpdate;
            _native?.PopupHide();
            _native?.PopupSigHide();
            Teardown(keepView: s_reloading);
        }

        private void OnFocus()
        {
            _refocus = true;
            if (_native != null && _editorId != 0) { _native.EditorSetFocus(Eid, true); RenderView(); Repaint(); }
#if UNITY_EDITOR_WIN
            Input.imeCompositionMode = IMECompositionMode.On;
#endif
            // Returning to the window: pick up edits made to the file externally, and
            // re-fetch the git base (a commit / branch switch may have happened away).
            if (_native != null && _editorId != 0)
            {
                CheckExternalChange();
                if (!_preview) _native.EditorRefreshDiff(Eid);
                _lastExtCheck = EditorApplication.timeSinceStartup;
                _lastDiffPoll = 0d;
            }
        }

        private void OnLostFocus()
        {
            if (_native != null && _editorId != 0) { _native.EditorSetFocus(Eid, false); RenderView(); Repaint(); }
#if UNITY_EDITOR_WIN
            Input.imeCompositionMode = IMECompositionMode.Auto;
#endif
            // The popup is a floating panel; don't leave it on screen when the editor
            // isn't focused.
            CloseCompletion();
            CloseSignatureHelp();
        }

        private void LoadNative()
        {
            try
            {
                UntermWindow.EnsureNativeImageLoaded();
                _native = new UntermNative();
                _native.Load(UntermWindow.PluginPath);

                var (w, h) = CurrentSize();
                float ppp = EditorGUIUtility.pixelsPerPoint;

                // New or re-adopted view: force the next RenderView to push size
                // and theme (the change-gates otherwise carry "already sent" state
                // from a previous view into this one).
                _sentW = _sentH = 0; _sentPpp = 0f; _themeSent = false;

                // Adopt our own native view only if no OTHER live window already
                // owns this id. Native editor ids are recycled (alloc = max id + 1, so
                // closing the top one frees its number), so a window restored with a
                // stale serialized `_editorId` can land on an id now owned by a
                // DIFFERENT file's editor — driving the same view, its buffer shows the
                // other file. On a collision we build a fresh view seeded from THIS
                // window's own snapshot/file (never the sibling's buffer).
                ulong oldEid = Eid;
                bool collision = _editorId != 0 && AnyOtherWindowOwns(oldEid);
                bool reAdopt = _editorId != 0 && _native.EditorExists(oldEid) && !collision;
                if (!reAdopt)
                {
                    _editorId = (long)_native.EditorCreate(w, h, ppp);
                    ApplyTheme();
                    _native.EditorSetUndoLimit(Eid, UntermCodeEditorPrefs.UndoLimit);
                    _native.EditorSetLanguage(Eid, _langToken ?? "");
                    // Restart / collision: the native view is gone, so reopen this
                    // window's own file fresh from disk. No buffer content is carried
                    // across a restart (clean or unsaved alike), so there's never a
                    // stale snapshot to diff against on the next external-change poll.
                    if (!string.IsNullOrEmpty(_filePath) && File.Exists(_filePath))
                        LoadFile(_filePath); // fresh from disk; sets _savedSerial clean + _fileTicks now
                    else
                        _savedSerial = _native.EditorEditSerial(Eid); // untitled / file gone → empty, clean
                }
                else
                {
                    // Re-adopted across a domain reload: a fetch that was in flight
                    // delivered unpolled. Kick a fresh one (also picking up commits
                    // made mid-compile).
                    _native.EditorRefreshDiff(Eid);
                }

                // Sync the breakpoint gutter to the current pref for BOTH fresh and
                // re-adopted views (a re-adopted native view keeps its old flag, which
                // would otherwise leave the gutter/dots out of sync after a reload).
                _native.EditorSetBpGutter(Eid, UntermDebuggerPrefs.Enabled);
                if (UntermDebuggerPrefs.Enabled && !string.IsNullOrEmpty(_filePath))
                    _native.EditorSetBreakpoints(Eid, UntermBreakpoints.For(_filePath));

                // Re-apply preview mode after a reload / re-adopt (the serialized flag
                // is the intent; a re-adopted native view keeps its own, which may drift).
                if (_preview && !CanPreview) _preview = false;
                _native.EditorSetPreview(Eid, _preview);

                _refocus = true;
                RenderView();
                _status = "ready";
            }
            catch (Exception e)
            {
                _status = "load failed: " + e.Message;
                Debug.LogError("[Unterm] " + e);
                Teardown(keepView: false);
            }
        }

        private void Teardown(bool keepView)
        {
            ClearSurfaceTextureCache();

            var native = _native;
            _native = null;
            if (!keepView)
            {
                ulong eid = Eid;
                bool ownedElsewhere = AnyOtherWindowOwns(eid);
                if (native != null && eid != 0 && !ownedElsewhere)
                    native.EditorDestroy(eid);
                _editorId = 0;
                native?.Dispose();
            }
        }

        private bool AnyOtherWindowOwns(ulong eid)
        {
            if (eid == 0) return false;
            foreach (var w in Resources.FindObjectsOfTypeAll<UntermCodeEditorWindow>())
                if (w != this && (ulong)w._editorId == eid) return true;
            return false;
        }

        // --- sizing / rendering ------------------------------------------------

        private (uint, uint) CurrentSize()
        {
            float ppp = EditorGUIUtility.pixelsPerPoint;
            uint w = (uint)Mathf.Max(1, Mathf.RoundToInt(position.width * ppp));
            uint h = (uint)Mathf.Max(1, Mathf.RoundToInt(position.height * ppp));
            return (w, h);
        }

        private void ApplyTheme()
        {
            if (_native == null || _editorId == 0) return;
            Color bg = GetEditorBackground();
            bool dark = EditorGUIUtility.isProSkin;
            if (_themeSent && bg == _sentBg && dark == _sentDark) return;
            _sentBg = bg; _sentDark = dark; _themeSent = true;
            Color32 fg = dark
                ? new Color32(210, 210, 214, 255)
                : new Color32(32, 32, 32, 255);
            // Native clears in linear space; the sRGB target re-encodes on store.
            _native.EditorSetTheme(Eid, bg.linear, fg, dark);
        }

        private void RenderView()
        {
            if (_native == null || _editorId == 0) return;
            float ppp = EditorGUIUtility.pixelsPerPoint;
            var (w, h) = CurrentSize();
            if (w != _sentW || h != _sentH || ppp != _sentPpp)
            {
                _sentW = w; _sentH = h; _sentPpp = ppp;
                _native.EditorResize(Eid, w, h, ppp);
            }
            ApplyTheme();
            _native.EditorRender(Eid);
            UploadSurface((int)w, (int)h);
        }

        private void UploadSurface(int iw, int ih)
        {
            IntPtr texPtr = _native.EditorRawTexture(Eid);
            if (texPtr == IntPtr.Zero) return;

            if (_surfaceTextureW != iw || _surfaceTextureH != ih)
            {
                ClearSurfaceTextureCache();
                _surfaceTextureW = iw;
                _surfaceTextureH = ih;
            }
            if (!_surfaceTextures.TryGetValue(texPtr, out var tex) || tex == null)
            {
                tex = Texture2D.CreateExternalTexture(iw, ih, TextureFormat.RGBA32, false, false, texPtr);
                tex.filterMode = FilterMode.Bilinear;
                tex.hideFlags = HideFlags.HideAndDontSave;
                _surfaceTextures[texPtr] = tex;
            }
            _tex = tex;
        }

        private void ClearSurfaceTextureCache()
        {
            foreach (var texture in _surfaceTextures.Values)
            {
                if (texture != null) DestroyImmediate(texture);
            }
            _surfaceTextures.Clear();
            _tex = null;
            _surfaceTextureW = _surfaceTextureH = 0;
        }

        // The internal method resolves once and the color it returns depends only
        // on the skin, so both are cached — the reflective lookup + Invoke used to
        // run on every RenderView (every keystroke/drag/scroll).
        private static System.Reflection.MethodInfo s_bgMethod;
        private static bool s_bgLooked;
        private static Color s_bgColor;
        private static bool s_bgDark, s_bgValid;

        private static Color GetEditorBackground()
        {
            bool dark = EditorGUIUtility.isProSkin;
            if (s_bgValid && s_bgDark == dark) return s_bgColor;
            if (!s_bgLooked)
            {
                s_bgLooked = true;
                var m = typeof(EditorGUIUtility).GetMethod(
                    "GetDefaultBackgroundColor",
                    System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static);
                if (m != null && m.ReturnType == typeof(Color)) s_bgMethod = m;
            }
            s_bgColor = s_bgMethod != null
                ? (Color)s_bgMethod.Invoke(null, null)
                : EditorGUIUtility.isProSkin
                    ? (Color)new Color32(40, 40, 40, 255)
                    : (Color)new Color32(220, 220, 220, 255);
            s_bgDark = dark;
            s_bgValid = true;
            return s_bgColor;
        }

        // --- GUI ---------------------------------------------------------------

        private void OnGUI()
        {
            if (Event.current.type == EventType.Layout)
            {
                bool now = !string.IsNullOrEmpty(Input.compositionString);
                _composeJustEnded = _prevComposing && !now;
                _prevComposing = now;
                _composing = now;
            }

            HandleKeys();

            // Re-render on resize.
            var (cw, ch) = CurrentSize();
            if (_native != null && _editorId != 0 &&
                (_tex == null || _tex.width != (int)cw || _tex.height != (int)ch))
            {
                RenderView();
            }

            var rect = new Rect(0, 0, position.width, position.height);

            if (Event.current.type == EventType.ScrollWheel && rect.Contains(Event.current.mousePosition)
                && _native != null && _editorId != 0)
            {
                var we = Event.current;
                if (_complOpen && _complItems.Count > 0 && Mathf.Abs(we.delta.y) > 0.01f)
                {
                    // Popup is open: the wheel scrolls the VIEW (offset) only, leaving
                    // the selection put (the panel passes mouse events through to here).
                    int vis = Mathf.Min(_complItems.Count, ComplRows);
                    int maxScroll = Mathf.Max(0, _complItems.Count - vis);
                    int dir = we.delta.y > 0 ? 1 : -1;
                    _complScroll = Mathf.Clamp(_complScroll + dir, 0, maxScroll);
                    PushCompletions();
                    we.Use();
                }
                else
                {
                    float ppp = EditorGUIUtility.pixelsPerPoint;
                    if (Mathf.Abs(we.delta.x) > 0.01f) _native.EditorScrollH(Eid, we.delta.x * 24f * ppp);
                    if (Mathf.Abs(we.delta.y) > 0.01f) _native.EditorScroll(Eid, we.delta.y * 24f * ppp);
                    RenderView();
                    Repaint();
                    we.Use();
                }
            }

            HandleMouse(rect);

            if (_tex != null)
            {
                // Native frame is top-down; Texture2D samples bottom-up, so flip V.
                GUI.DrawTextureWithTexCoords(rect, _tex, new Rect(0, 1, 1, -1));
                DrawScrollbar(rect);
            }
            else
            {
                EditorGUI.LabelField(rect, _status, EditorStyles.centeredGreyMiniLabel);
            }

            DrawBar();

            // Preview is read-only: no hidden IME field (its commit would mutate the
            // buffer) and no focus grab.
            if (!_preview)
            {
                DrawImeField(rect);
                SyncIme();
                // Don't steal focus from the find bar's field while it's open.
                if (_bar == BarMode.None && _refocus && Event.current.type == EventType.Repaint)
                {
                    EditorGUI.FocusTextInControl(InputControl);
                    _refocus = false;
                }
            }
        }

        private void HandleMouse(Rect rect)
        {
            if (_native == null || _editorId == 0) return;
            var e = Event.current;
            // Leave clicks on the find bar / scrollbar to their own controls.
            if (_bar != BarMode.None && e.mousePosition.y < BarHeight()) return;
            if (e.type == EventType.MouseDown && e.mousePosition.x >= rect.xMax - ScrollbarWidth
                && HasOverflow(rect)) return;
            float ppp = EditorGUIUtility.pixelsPerPoint;
            float lx = (e.mousePosition.x - rect.x) * ppp;
            float ly = (e.mousePosition.y - rect.y) * ppp;

            // Preview: read-only text selection + click-to-open file paths; none of
            // the editing / gutter / breakpoint / hover-tooltip handling applies.
            if (_preview) { HandlePreviewMouse(rect, e, lx, ly); return; }

            switch (e.type)
            {
                case EventType.MouseDown when e.button == 0 && rect.Contains(e.mousePosition):
                    // Gutter clicks with debugging enabled: the thin left diff-marker
                    // lane (~8px) keeps its Stage/Revert menu; the rest of the gutter
                    // (breakpoint column + line numbers) toggles a breakpoint.
                    if (UntermDebuggerPrefs.Enabled
                        && lx < _native.EditorGutterWidth(Eid) && !string.IsNullOrEmpty(_filePath))
                    {
                        if (lx < 8f * ppp)
                        {
                            int laneHunk = _native.EditorHunkAt(Eid, lx, ly);
                            if (laneHunk >= 0) { ShowHunkMenu(laneHunk); e.Use(); break; }
                        }
                        uint bpLine = _native.EditorLineAtY(Eid, ly);
                        var set = UntermBreakpoints.Toggle(_filePath, (int)bpLine);
                        _native.EditorSetBreakpoints(Eid, set);
                        RenderView(); Repaint(); e.Use();
                        break;
                    }
                    CloseCompletion(); // a click dismisses the popup
                    // A click on a gutter diff marker opens its Stage/Revert menu
                    // instead of moving the caret (VS Code-style).
                    int hunk = _native.EditorHunkAt(Eid, lx, ly);
                    if (hunk >= 0) { ShowHunkMenu(hunk); e.Use(); break; }
                    byte kind = e.clickCount >= 3 ? (byte)3 : e.clickCount == 2 ? (byte)2 : (byte)0;
                    _native.EditorMouse(Eid, lx, ly, kind);
                    _mouseDragging = true;
                    _refocus = true;
                    RenderView(); Repaint(); e.Use();
                    break;
                case EventType.MouseDrag when _mouseDragging:
                    _native.EditorMouse(Eid, lx, ly, 1);
                    RenderView(); Repaint(); e.Use();
                    break;
                case EventType.MouseUp when _mouseDragging:
                    _mouseDragging = false; e.Use();
                    break;
                case EventType.MouseMove when rect.Contains(e.mousePosition):
                    ForwardHover(rect, e.mousePosition, ppp);
                    break;
                case EventType.Repaint:
                    // Windows Unity often doesn't deliver MouseMove events, so the
                    // hover tooltip never fires there. Fall back to polling the mouse
                    // on Repaint (OnEditorUpdate forces repaints while the pointer is
                    // over this window). Deduped by position, so it's cheap.
                    ForwardHover(rect, e.mousePosition, ppp);
                    break;
                case EventType.ContextClick when rect.Contains(e.mousePosition):
                    ShowContextMenu();
                    e.Use();
                    break;
            }
        }

        // Mouse in Markdown preview: drag selects text; a click (no drag) on an
        // underlined file-path token opens it (the same targets the transcript
        // opens); a context click offers copy / select-all / exit.
        private void HandlePreviewMouse(Rect rect, Event e, float lx, float ly)
        {
            switch (e.type)
            {
                case EventType.MouseDown when e.button == 0 && rect.Contains(e.mousePosition):
                    _pvDownToken = _native.EditorPreviewTokenAt(Eid, lx, ly) ?? "";
                    _pvMoved = false;
                    _native.EditorMouse(Eid, lx, ly, 0); // begin selection
                    _mouseDragging = true;
                    RenderView(); Repaint(); e.Use();
                    break;
                case EventType.MouseDrag when _mouseDragging:
                    _pvMoved = true;
                    _native.EditorMouse(Eid, lx, ly, 1); // extend selection
                    RenderView(); Repaint(); e.Use();
                    break;
                case EventType.MouseUp when _mouseDragging:
                    _mouseDragging = false;
                    if (!_pvMoved && !string.IsNullOrEmpty(_pvDownToken))
                        OpenFromAgent(_pvDownToken, Path.GetDirectoryName(_filePath) ?? "");
                    _pvDownToken = "";
                    e.Use();
                    break;
                case EventType.ContextClick when rect.Contains(e.mousePosition):
                    ShowPreviewContextMenu();
                    e.Use();
                    break;
            }
        }

        private void ShowPreviewContextMenu()
        {
            var menu = new GenericMenu();
            menu.AddItem(new GUIContent("Copy"), false, () =>
            {
                string s = _native.EditorCopy(Eid);
                if (!string.IsNullOrEmpty(s)) EditorGUIUtility.systemCopyBuffer = s;
            });
            menu.AddItem(new GUIContent("Select All"), false, () =>
            {
                _native.EditorSelectAll(Eid); RenderView(); Repaint();
            });
            menu.AddSeparator("");
            menu.AddItem(new GUIContent($"Edit (exit preview)   {KCmd}{KSep}{KShift}{KSep}V"), false, () => SetPreview(false));
            menu.ShowAsContext();
        }

        private Vector2 _lastHoverPos = new Vector2(float.NaN, float.NaN);

        // Show/hide the diff-peek tooltip for the pointer at `pos`. Deduped by
        // position so repeated Repaint polls (the Windows hover fallback) and macOS
        // MouseMove events both funnel here without spamming the native call.
        private void ForwardHover(Rect rect, Vector2 pos, float ppp)
        {
            if (pos == _lastHoverPos) return;
            _lastHoverPos = pos;
            // Outside the surface → a far off-gutter point so native clears any tooltip.
            float lx = 1e6f, ly = 1e6f;
            if (rect.Contains(pos)) { lx = (pos.x - rect.x) * ppp; ly = (pos.y - rect.y) * ppp; }
            if (_native.EditorHover(Eid, lx, ly)) { RenderView(); Repaint(); }
        }

        // Stage/Unstage/Revert menu for the git-diff hunk under a clicked gutter
        // marker. Stage and Unstage write the git index; the 1s diff poll picks up
        // the change and flips the marker solid/hollow. Three states: unstaged →
        // Stage; exactly staged → Unstage; partially staged (staged, then edited
        // further) → BOTH (Stage updates the staged version to the current content,
        // Unstage drops it back to HEAD).
        private void ShowHunkMenu(int hunk)
        {
            var menu = new GenericMenu();
            bool staged = _native.EditorHunkStaged(Eid, hunk);
            bool hasStaged = _native.EditorHunkHasStaged(Eid, hunk);
            // Staged-only: the change lives in the index and the buffer is already at
            // HEAD, so reverting the buffer would be a visible no-op — offer Unstage only.
            bool stagedOnly = _native.EditorHunkStagedOnly(Eid, hunk);
            // Plain "Stage / Unstage / Revert", like Zed's hunk buttons (VS Code says
            // "Stage Change") — the clicked marker makes the target obvious.
            if (!staged)
                menu.AddItem(new GUIContent("Stage"), false, () =>
                {
                    _status = _native.EditorStageHunk(Eid, hunk) ? "Staged hunk" : "Stage failed (not a git repo?)";
                    RenderView(); Repaint();
                });
            if (hasStaged)
                menu.AddItem(new GUIContent("Unstage"), false, () =>
                {
                    _status = _native.EditorUnstageHunk(Eid, hunk) ? "Unstaged hunk" : "Unstage failed";
                    RenderView(); Repaint();
                });
            if (!stagedOnly)
                menu.AddItem(new GUIContent("Revert"), false, () =>
                {
                    // Restores the hunk to its HEAD content (one undo step), then
                    // saves the file — VS Code's Revert Change does exactly this
                    // (buffer edit + document.save()), so the revert lands on disk
                    // immediately. Note this also writes any other unsaved edits in
                    // the file, same as VS Code. Undo re-dirties as usual.
                    _native.EditorRevertHunk(Eid, hunk);
                    Save();
                });
            menu.ShowAsContext();
        }

        private void ShowContextMenu()
        {
            var menu = new GenericMenu();
            menu.AddItem(new GUIContent("Cut"), false, () =>
            {
                string s = _native.EditorCut(Eid);
                if (!string.IsNullOrEmpty(s)) EditorGUIUtility.systemCopyBuffer = s;
                MarkDirty(); RenderView(); Repaint();
            });
            menu.AddItem(new GUIContent("Copy"), false, () =>
            {
                string s = _native.EditorCopy(Eid);
                if (!string.IsNullOrEmpty(s)) EditorGUIUtility.systemCopyBuffer = s;
            });
            menu.AddItem(new GUIContent("Paste"), false, () =>
            {
                _native.EditorInsert(Eid, EditorGUIUtility.systemCopyBuffer);
                MarkDirty(); RenderView(); Repaint();
            });
            menu.AddItem(new GUIContent("Select All"), false, () =>
            {
                _native.EditorSelectAll(Eid); RenderView(); Repaint();
            });
            menu.AddSeparator("");
            menu.AddItem(new GUIContent($"Find…   {KCmd}{KSep}F"), false, () => OpenBar(BarMode.Find));
            menu.AddItem(new GUIContent($"Replace…   {KCmd}{KSep}{KAlt}{KSep}F"), false, () => OpenBar(BarMode.Replace));
            menu.AddItem(new GUIContent($"Go to Line…   {KCmd}{KSep}L"), false, () => OpenBar(BarMode.Goto));
            menu.AddItem(new GUIContent($"Toggle Comment   {KCmd}{KSep}∕"), false, () =>
            {
                _native.EditorToggleComment(Eid); MarkDirty(); RenderView(); Repaint();
            });
            if (CanPreview)
            {
                menu.AddSeparator("");
                menu.AddItem(new GUIContent($"Preview Markdown   {KCmd}{KSep}{KShift}{KSep}V"), false, TogglePreview);
            }
            menu.AddSeparator("");
            menu.AddItem(new GUIContent($"Save   {KCmd}{KSep}S"), false, Save);
            menu.ShowAsContext();
        }

        // The window tab's "⋮" dropdown — so Find / Replace / Go to Line and the
        // shortcuts are discoverable without knowing the key combos.
        public void AddItemsToMenu(GenericMenu menu)
        {
            if (_native == null || _editorId == 0) return;
            if (CanPreview || _preview)
            {
                menu.AddItem(new GUIContent($"Preview Markdown   {KCmd}{KSep}{KShift}{KSep}V"), _preview, TogglePreview);
                menu.AddSeparator("");
            }
            menu.AddItem(new GUIContent($"Find…   {KCmd}{KSep}F"), false, () => OpenBar(BarMode.Find));
            menu.AddItem(new GUIContent($"Replace…   {KCmd}{KSep}{KAlt}{KSep}F"), false, () => OpenBar(BarMode.Replace));
            menu.AddItem(new GUIContent($"Go to Line…   {KCmd}{KSep}L"), false, () => OpenBar(BarMode.Goto));
            menu.AddItem(new GUIContent($"Toggle Comment   {KCmd}{KSep}∕"), false, () =>
            {
                _native.EditorToggleComment(Eid); MarkDirty(); RenderView(); Repaint();
            });
            menu.AddItem(new GUIContent($"Save   {KCmd}{KSep}S"), false, Save);
        }

        private void HandleKeys()
        {
            if (_native == null || _editorId == 0) return;
            var e = Event.current;
            if (e.type != EventType.KeyDown) return;

            // Find / replace / goto bar: while open, Esc closes and Enter triggers;
            // every other key is left for the bar's text field.
            if (_bar != BarMode.None)
            {
                if (e.keyCode == KeyCode.Escape) { CloseBar(); e.Use(); return; }
                if (e.keyCode == KeyCode.Return || e.keyCode == KeyCode.KeypadEnter)
                {
                    if (_bar == BarMode.Goto) DoGoto();
                    else DoFind(!e.shift);
                    e.Use();
                    return;
                }
                if ((e.command || e.control) && e.keyCode == KeyCode.G)
                {
                    DoFind(!e.shift); e.Use(); return;
                }
                return;
            }

            // Markdown preview is read-only: allow copy / select-all / toggle / exit,
            // and swallow every editing key so nothing reaches the buffer.
            if (_preview)
            {
                if ((e.command || e.control) && e.shift && e.keyCode == KeyCode.V) { TogglePreview(); e.Use(); return; }
                if (e.keyCode == KeyCode.Escape) { SetPreview(false); e.Use(); return; }
                if (e.command || e.control)
                {
                    switch (e.keyCode)
                    {
                        case KeyCode.C:
                        {
                            string s = _native.EditorCopy(Eid);
                            if (!string.IsNullOrEmpty(s)) EditorGUIUtility.systemCopyBuffer = s;
                            e.Use(); return;
                        }
                        case KeyCode.A:
                            _native.EditorSelectAll(Eid); RenderView(); Repaint(); e.Use(); return;
                    }
                }
                return;
            }

            // While composing, let every key reach the IME field.
            if (_composing) return;

            // Ctrl+Space opens the completion popup.
            if (e.control && e.keyCode == KeyCode.Space)
            {
                UpdateCompletion(1);
                e.Use();
                return;
            }

            // While the popup is open: navigate / accept / dismiss. Left/Right/Home/
            // End move the caret away, so close and let them through.
            if (_complOpen && _complItems.Count > 0)
            {
                switch (e.keyCode)
                {
                    case KeyCode.DownArrow:
                        _complSel = (_complSel + 1) % _complItems.Count; EnsureComplSelVisible(); PushCompletions(); e.Use(); return;
                    case KeyCode.UpArrow:
                        _complSel = (_complSel - 1 + _complItems.Count) % _complItems.Count; EnsureComplSelVisible(); PushCompletions(); e.Use(); return;
                    case KeyCode.Tab:
                    case KeyCode.Return:
                    case KeyCode.KeypadEnter:
                        AcceptCompletion(); e.Use(); return;
                    case KeyCode.Escape:
                        CloseCompletion(); e.Use(); return;
                    case KeyCode.LeftArrow:
                    case KeyCode.RightArrow:
                    case KeyCode.Home:
                    case KeyCode.End:
                        CloseCompletion(); break; // fall through to normal motion
                }
            }

            // Escape dismisses the signature hint (when the completion popup didn't
            // already consume it above).
            if (_sigOpen && e.keyCode == KeyCode.Escape) { CloseSignatureHelp(); e.Use(); return; }

            // Swallow the Enter that committed an IME composition.
            if (_composeJustEnded &&
                (e.keyCode == KeyCode.Return || e.keyCode == KeyCode.KeypadEnter))
            {
                e.Use();
                return;
            }

            // Move the current line up/down (Alt/Option + Up/Down).
            if (e.alt && !e.command && !e.control &&
                (e.keyCode == KeyCode.UpArrow || e.keyCode == KeyCode.DownArrow))
            {
                if (e.keyCode == KeyCode.UpArrow) _native.EditorMoveLineUp(Eid);
                else _native.EditorMoveLineDown(Eid);
                MarkDirty(); RenderView(); Repaint(); e.Use();
                return;
            }

            // Caret motion: arrows / Home / End, plus modifier combos (word, line
            // start/end, document start/end). Resolved per-platform, then forwarded
            // as a semantic name; shift extends the selection.
            string motion = ResolveMotion(e);
            if (motion != null)
            {
                _native.EditorKey(Eid, motion, e.control, e.alt, e.shift);
                RenderView(); Repaint(); e.Use();
                return;
            }

            // Word / line deletion. macOS: Option+Backspace = delete word, Cmd+
            // Backspace = delete to line start, Option+Delete = delete word forward.
            // Windows/Linux: Ctrl+Backspace/Delete = delete word.
            if (e.keyCode == KeyCode.Backspace && (e.alt || e.command || e.control))
            {
#if UNITY_EDITOR_OSX
                string n = e.command ? "DeleteToLineStart" : "DeleteWordBack";
#else
                string n = "DeleteWordBack";
#endif
                _native.EditorKey(Eid, n, e.control, e.alt, e.shift);
                MarkDirty();
                if (_complOpen) UpdateCompletion(1);
                if (_sigOpen) RequestSignatureHelp();
                RenderView(); Repaint(); e.Use();
                return;
            }
            if (e.keyCode == KeyCode.Delete && (e.alt || e.control))
            {
                _native.EditorKey(Eid, "DeleteWordForward", e.control, e.alt, e.shift);
                MarkDirty();
                if (_complOpen) UpdateCompletion(1);
                if (_sigOpen) RequestSignatureHelp();
                RenderView(); Repaint(); e.Use();
                return;
            }

            // Cmd/Ctrl shortcuts. Cmd+S is also bound as a Shortcut (context), but
            // handle it here too as a best-effort fallback.
            if (e.command || e.control)
            {
                switch (e.keyCode)
                {
                    case KeyCode.S:
                        Save(); e.Use(); return;
                    case KeyCode.V when e.shift && CanPreview:
                        TogglePreview(); e.Use(); return;
                    case KeyCode.V:
                        _native.EditorInsert(Eid, EditorGUIUtility.systemCopyBuffer);
                        MarkDirty(); RenderView(); Repaint(); e.Use(); return;
                    case KeyCode.C:
                    {
                        string s = _native.EditorCopy(Eid);
                        if (!string.IsNullOrEmpty(s)) EditorGUIUtility.systemCopyBuffer = s;
                        e.Use(); return;
                    }
                    case KeyCode.X:
                    {
                        string s = _native.EditorCut(Eid);
                        if (!string.IsNullOrEmpty(s)) EditorGUIUtility.systemCopyBuffer = s;
                        MarkDirty(); RenderView(); Repaint(); e.Use(); return;
                    }
                    case KeyCode.A:
                        _native.EditorSelectAll(Eid); RenderView(); Repaint(); e.Use(); return;
                    case KeyCode.Z when !e.shift:
                        _native.EditorUndo(Eid); MarkDirty(); RenderView(); Repaint(); e.Use(); return;
                    case KeyCode.Z when e.shift:
                        _native.EditorRedo(Eid); MarkDirty(); RenderView(); Repaint(); e.Use(); return;
                    case KeyCode.Slash:
                        _native.EditorToggleComment(Eid); MarkDirty(); RenderView(); Repaint(); e.Use(); return;
                    case KeyCode.D:
                        _native.EditorDuplicateLine(Eid); MarkDirty(); RenderView(); Repaint(); e.Use(); return;
                    case KeyCode.K when e.shift:
                        _native.EditorDeleteLine(Eid); MarkDirty(); RenderView(); Repaint(); e.Use(); return;
                    case KeyCode.L:
                        OpenBar(BarMode.Goto); e.Use(); return;
                    case KeyCode.F:
                        OpenBar(e.alt ? BarMode.Replace : BarMode.Find); e.Use(); return;
                    case KeyCode.G when !e.shift:
                        DoFind(true); e.Use(); return;
                    case KeyCode.G when e.shift:
                        DoFind(false); e.Use(); return;
                }
            }

            // Tab: indent a selection, outdent with Shift, else insert spaces.
            if (e.keyCode == KeyCode.Tab && !e.control && !e.command)
            {
                bool hasSel = !string.IsNullOrEmpty(_native.EditorCopy(Eid));
                if (e.shift) _native.EditorOutdent(Eid);
                else if (hasSel) _native.EditorIndent(Eid);
                else _native.EditorInsert(Eid, "    ");
                MarkDirty(); RenderView(); Repaint(); e.Use();
                return;
            }

            // Editing keys (motion is handled above).
            string name = e.keyCode switch
            {
                KeyCode.Return => "Return",
                KeyCode.KeypadEnter => "Return",
                KeyCode.Backspace => "Backspace",
                KeyCode.Delete => "Delete",
                _ => null,
            };
            if (name != null)
            {
                _native.EditorKey(Eid, name, e.control, e.alt, e.shift);
                MarkDirty();
                if (_complOpen && (name == "Backspace" || name == "Delete")) UpdateCompletion(1);
                else if (name == "Return") CloseCompletion();
                // Keep the parameter hint in sync as the caret moves/edits within a call
                // (re-resolves the active parameter, or closes when leaving the call).
                if (_sigOpen) RequestSignatureHelp();
                RenderView();
                Repaint();
                e.Use();
            }
        }

        // Map an arrow/Home/End keystroke (with modifiers) to a semantic motion
        // name the native editor understands. Returns null for non-motion keys.
        // macOS: Cmd+←/→ = line start/end, Cmd+↑/↓ = document start/end,
        // Option+←/→ = word. Windows/Linux: Ctrl+←/→ = word, Ctrl+Home/End = doc.
        private static string ResolveMotion(Event e)
        {
#if UNITY_EDITOR_OSX
            bool word = e.alt;
            bool ends = e.command;
            switch (e.keyCode)
            {
                case KeyCode.LeftArrow:  return word ? "WordLeft"  : ends ? "LineStart" : "LeftArrow";
                case KeyCode.RightArrow: return word ? "WordRight" : ends ? "LineEnd"   : "RightArrow";
                case KeyCode.UpArrow:    return ends ? "DocStart" : "UpArrow";
                case KeyCode.DownArrow:  return ends ? "DocEnd"   : "DownArrow";
                case KeyCode.Home:       return "LineStart";
                case KeyCode.End:        return "LineEnd";
                case KeyCode.PageUp:     return "PageUp";
                case KeyCode.PageDown:   return "PageDown";
                default: return null;
            }
#else
            bool word = e.control;
            switch (e.keyCode)
            {
                case KeyCode.LeftArrow:  return word ? "WordLeft"  : "LeftArrow";
                case KeyCode.RightArrow: return word ? "WordRight" : "RightArrow";
                case KeyCode.UpArrow:    return "UpArrow";
                case KeyCode.DownArrow:  return "DownArrow";
                case KeyCode.Home:       return e.control ? "DocStart" : "LineStart";
                case KeyCode.End:        return e.control ? "DocEnd"   : "LineEnd";
                case KeyCode.PageUp:     return "PageUp";
                case KeyCode.PageDown:   return "PageDown";
                default: return null;
            }
#endif
        }

        // --- find / replace / goto bar + scrollbar -----------------------------

        private float BarHeight() => _bar == BarMode.Replace ? 44f : (_bar == BarMode.None ? 0f : 22f);

        private bool HasOverflow(Rect rect)
        {
            float ppp = EditorGUIUtility.pixelsPerPoint;
            return _native.EditorContentHeight(Eid) - rect.height * ppp > 0.5f;
        }

        private void OpenBar(BarMode mode)
        {
            _bar = mode;
            _focusBar = true;
            _findStatus = "";
            Repaint();
        }

        private void CloseBar()
        {
            _bar = BarMode.None;
            _refocus = true;
            Repaint();
        }

        private void DoFind(bool forward)
        {
            if (string.IsNullOrEmpty(_findText)) return;
            bool ok = _native.EditorFind(Eid, _findText, forward, _findCase);
            _findStatus = ok ? "" : "No match";
            RenderView(); Repaint();
        }

        private void DoGoto()
        {
            if (int.TryParse(_gotoText, out int n))
            {
                _native.EditorGotoLine(Eid, (uint)Mathf.Max(0, n - 1));
                RenderView(); Repaint();
            }
            CloseBar();
        }

        private void DoReplace()
        {
            // Replace the current match (if any) then advance to the next.
            _native.EditorReplaceSelection(Eid, _replaceText ?? "");
            _native.EditorFind(Eid, _findText, true, _findCase);
            MarkDirty(); RenderView(); Repaint();
        }

        private void DoReplaceAll()
        {
            uint n = _native.EditorReplaceAll(Eid, _findText, _replaceText ?? "", _findCase);
            _findStatus = n + " replaced";
            if (n > 0) MarkDirty();
            RenderView(); Repaint();
        }

        private void DrawBar()
        {
            if (_bar == BarMode.None) return;
            float h = BarHeight();
            var area = new Rect(0, 0, position.width, h);
            EditorGUI.DrawRect(area, EditorGUIUtility.isProSkin
                ? new Color(0.18f, 0.18f, 0.18f, 0.98f)
                : new Color(0.85f, 0.85f, 0.85f, 0.98f));

            GUILayout.BeginArea(area);
            if (_bar == BarMode.Goto)
            {
                GUILayout.BeginHorizontal();
                GUILayout.Label("Go to line:", GUILayout.Width(64));
                GUI.SetNextControlName(FindField);
                _gotoText = GUILayout.TextField(_gotoText, GUILayout.Width(80));
                if (GUILayout.Button("Go", EditorStyles.miniButton, GUILayout.Width(34))) DoGoto();
                GUILayout.FlexibleSpace();
                if (GUILayout.Button("✕", EditorStyles.miniButton, GUILayout.Width(22))) CloseBar();
                GUILayout.EndHorizontal();
            }
            else
            {
                GUILayout.BeginHorizontal();
                GUI.SetNextControlName(FindField);
                _findText = GUILayout.TextField(_findText, GUILayout.MinWidth(120));
                _findCase = GUILayout.Toggle(_findCase, "Aa", EditorStyles.miniButton, GUILayout.Width(28));
                if (GUILayout.Button("◀", EditorStyles.miniButton, GUILayout.Width(22))) DoFind(false);
                if (GUILayout.Button("▶", EditorStyles.miniButton, GUILayout.Width(22))) DoFind(true);
                GUILayout.Label(_findStatus, GUILayout.Width(64));
                GUILayout.FlexibleSpace();
                if (GUILayout.Button("✕", EditorStyles.miniButton, GUILayout.Width(22))) CloseBar();
                GUILayout.EndHorizontal();
                if (_bar == BarMode.Replace)
                {
                    GUILayout.BeginHorizontal();
                    _replaceText = GUILayout.TextField(_replaceText, GUILayout.MinWidth(120));
                    if (GUILayout.Button("Replace", EditorStyles.miniButton, GUILayout.Width(60))) DoReplace();
                    if (GUILayout.Button("All", EditorStyles.miniButton, GUILayout.Width(34))) DoReplaceAll();
                    GUILayout.FlexibleSpace();
                    GUILayout.EndHorizontal();
                }
            }
            GUILayout.EndArea();

            if (_focusBar && Event.current.type == EventType.Repaint)
            {
                EditorGUI.FocusTextInControl(FindField);
                _focusBar = false;
            }
        }

        private void DrawScrollbar(Rect rect)
        {
            if (_native == null || _editorId == 0) return;
            float ppp = EditorGUIUtility.pixelsPerPoint;
            float content = _native.EditorContentHeight(Eid);
            float viewport = rect.height * ppp;
            float max = Mathf.Max(0f, content - viewport);
            if (max <= 0.5f) return;

            float cur = _native.EditorScrollOffset(Eid);
            var sb = new Rect(rect.xMax - ScrollbarWidth, rect.y, ScrollbarWidth, rect.height);
            EditorGUI.BeginChangeCheck();
            float nv = GUI.VerticalScrollbar(sb, cur, viewport, 0f, content);
            if (EditorGUI.EndChangeCheck())
            {
                _native.EditorSetScroll(Eid, Mathf.Clamp(nv, 0f, max));
                RenderView(); Repaint();
            }
        }

        // Reload from disk if the file changed externally (kept edits win if dirty).
        private void CheckExternalChange()
        {
            if (string.IsNullOrEmpty(_filePath) || !File.Exists(_filePath)) return;
            long t = File.GetLastWriteTimeUtc(_filePath).Ticks;
            if (_fileTicks == 0 || t == _fileTicks) return;
            if (!_dirty) { LoadFile(_filePath); return; } // no local edits → just reload

            // Conflict: unsaved local edits AND the file changed on disk. Let the user
            // pick, then sync `_fileTicks` either way so we don't re-prompt every poll.
            bool reload = EditorUtility.DisplayDialog(
                "File changed on disk",
                $"{Path.GetFileName(_filePath)} was modified outside the editor, but you have " +
                "unsaved changes here.\n\nReload from disk (discard your edits), or keep your " +
                "edits (a later save overwrites the disk version)?",
                "Reload", "Keep my edits");
            if (reload) LoadFile(_filePath);
            else { _fileTicks = t; _status = "Kept your edits — saving will overwrite the external change"; }
        }

        // --- autocomplete popup ------------------------------------------------

        private static readonly Regex s_ident = new Regex(@"[A-Za-z_][A-Za-z0-9_]*", RegexOptions.Compiled);

        // Decide what to complete at the caret. C#: semantic completion via Roslyn —
        // member access (`expr.`) lists the type's members, otherwise scope symbols
        // (types, namespaces, locals, members…). Roslyn runs ONCE per word on a
        // BACKGROUND thread (so typing never blocks); the result is cached and keyed
        // by the word start, so typing more filters the cache synchronously.
        // True when the '.' at `dotIndex` is a decimal point inside a numeric literal
        // (e.g. `1.0f`), not a member-access dot — so `1.` doesn't trigger completion.
        // A digit run immediately before the dot that isn't preceded by an identifier
        // char (so `a1.` stays member access) means it's a number.
        private static bool IsNumericDot(string text, int dotIndex)
        {
            int i = dotIndex - 1;
            if (i < 0 || !char.IsDigit(text[i])) return false;
            while (i >= 0 && char.IsDigit(text[i])) i--;
            return i < 0 || !(char.IsLetter(text[i]) || text[i] == '_');
        }

        // The completion context for the token starting at `nameStart`:
        //   1 = member access (after a non-numeric `.`), 2 = attribute name
        //   (the token sits in a `[ ... ]` attribute list), else 0 = general scope.
        private static int CompletionModeAt(string text, int nameStart)
        {
            if (nameStart > 0 && nameStart <= text.Length && text[nameStart - 1] == '.'
                && !IsNumericDot(text, nameStart - 1))
                return 1;
            if (IsAttributeContext(text, nameStart)) return 2;
            if (PrecededByWord(text, nameStart, "new")) return 3;       // object creation → types
            if (PrecededByWord(text, nameStart, "override")) return 5;  // override → base members
            if (IsUsingDirective(text, nameStart)) return 4;           // using directive → namespaces
            return 0;
        }

        // Whether the token at `nameStart` immediately follows the bare keyword `word`
        // (separated only by whitespace, with a token boundary before the keyword).
        private static bool PrecededByWord(string text, int nameStart, string word)
        {
            int i = nameStart - 1;
            while (i >= 0 && (text[i] == ' ' || text[i] == '\t')) i--;
            if (i < word.Length - 1) return false;
            for (int k = 0; k < word.Length; k++)
                if (text[i - k] != word[word.Length - 1 - k]) return false;
            int b = i - word.Length;
            return b < 0 || !(char.IsLetterOrDigit(text[b]) || text[b] == '_' || text[b] == '.');
        }

        // A spot where general completion should open with no prefix typed, because
        // the context produces specific items worth showing right away: a call's
        // argument list (`(` / `,`), an assignment / comparison (`=`), an object
        // initializer (`{`), or after `case` / `return`.
        private static bool IsRichContext(string text, int nameStart)
        {
            int i = nameStart - 1;
            while (i >= 0 && (text[i] == ' ' || text[i] == '\t')) i--;
            if (i >= 0)
            {
                char c = text[i];
                if (c == '(' || c == ',' || c == '=' || c == '{') return true;
            }
            return PrecededByWord(text, nameStart, "case") || PrecededByWord(text, nameStart, "return");
        }

        // Whether the caret's token sits in the namespace part of a `using …` line.
        private static bool IsUsingDirective(string text, int nameStart)
        {
            int ls = Mathf.Min(nameStart, text.Length);
            while (ls > 0 && text[ls - 1] != '\n') ls--;
            int i = ls;
            while (i < text.Length && (text[i] == ' ' || text[i] == '\t')) i++;
            const string kw = "using";
            if (i + kw.Length >= text.Length) return false;
            for (int k = 0; k < kw.Length; k++) if (text[i + k] != kw[k]) return false;
            char after = text[i + kw.Length];
            return after == ' ' || after == '\t';
        }

        // Heuristic (Roslyn-free, so it's cheap per keystroke): is the token at
        // `nameStart` an attribute name? Scan back over the attribute-list grammar
        // (identifiers, `.`, `,`, and balanced `( … )` of earlier attributes) to the
        // opening `[`; then reject the indexer/array `[` that follows an expression
        // (identifier, `)`, `]`, or `.`).
        private static bool IsAttributeContext(string text, int nameStart)
        {
            int i = Mathf.Min(nameStart, text.Length) - 1;
            int depth = 0;
            while (i >= 0)
            {
                char c = text[i];
                if (c == ')') { depth++; i--; continue; }
                if (c == '(') { if (depth == 0) return false; depth--; i--; continue; }
                if (depth > 0) { i--; continue; }
                if (c == '[') break;
                if (char.IsWhiteSpace(c) || c == ',' || c == '.' || c == '_' || char.IsLetterOrDigit(c)) { i--; continue; }
                return false; // any other token → not an attribute-name list
            }
            if (i < 0 || text[i] != '[') return false;
            int j = i - 1;
            while (j >= 0 && char.IsWhiteSpace(text[j])) j--;
            if (j < 0) return true; // '[' at the start of the file
            char p = text[j];
            // An indexer/array/`new[]` '[' follows an expression; an attribute '[' doesn't.
            return !(char.IsLetterOrDigit(p) || p == '_' || p == ')' || p == ']' || p == '.');
        }

        // Lightweight scan from the document start to `pos`, tracking whether the caret
        // is inside a line/block comment or a string/char literal — so completion isn't
        // offered there. Cheap (pure char loop, no Roslyn parse) to keep typing snappy.
        // Approximate for raw/interpolated strings, which is fine for suppression.
        private static bool InCommentOrStringAt(string s, int pos)
        {
            bool line = false, block = false, str = false, chr = false, verbatim = false;
            int end = Mathf.Min(pos, s.Length);
            for (int i = 0; i < end; i++)
            {
                char c = s[i];
                char n = i + 1 < s.Length ? s[i + 1] : '\0';
                if (line) { if (c == '\n') line = false; continue; }
                if (block) { if (c == '*' && n == '/') { block = false; i++; } continue; }
                if (str)
                {
                    if (verbatim) { if (c == '"' && n == '"') i++; else if (c == '"') { str = false; verbatim = false; } }
                    else if (c == '\\') i++;
                    else if (c == '"') str = false;
                    continue;
                }
                if (chr) { if (c == '\\') i++; else if (c == '\'') chr = false; continue; }
                if (c == '/' && n == '/') { line = true; i++; }
                else if (c == '/' && n == '*') { block = true; i++; }
                else if (c == '"') { str = true; verbatim = false; }
                else if ((c == '@' || c == '$') && n == '"') { str = true; verbatim = c == '@'; i++; }
                else if (c == '\'') chr = true;
            }
            return line || block || str || chr;
        }

        // VS Code-style fuzzy match: `query` must appear in `cand` as a subsequence
        // (case-insensitive). Returns false if not; otherwise `score` ranks the match
        // (higher = better), rewarding a true prefix, word/camelCase boundaries,
        // consecutive runs, exact case, and earlier/shorter matches.
        private static bool FuzzyMatch(string cand, string query, out int score)
        {
            score = 0;
            if (string.IsNullOrEmpty(query)) return true;
            int ci = 0, qi = 0, run = 0, first = -1;
            while (ci < cand.Length && qi < query.Length)
            {
                char c = cand[ci];
                if (char.ToLowerInvariant(c) == char.ToLowerInvariant(query[qi]))
                {
                    if (first < 0) first = ci;
                    int bonus = 0;
                    if (c == query[qi]) bonus += 1;          // exact case
                    if (ci == 0) bonus += 8;                 // start of identifier
                    else
                    {
                        char prev = cand[ci - 1];
                        if (prev == '_' || (char.IsLower(prev) && char.IsUpper(c))) bonus += 6; // boundary
                    }
                    run++;
                    score += 10 + bonus + run * 2;           // consecutive runs compound
                    qi++; ci++;
                }
                else { run = 0; ci++; }
            }
            if (qi < query.Length) { score = 0; return false; } // not all query chars consumed
            score -= first;            // earlier first match is better
            score -= cand.Length / 4;  // mild preference for shorter candidates
            if (cand.StartsWith(query, StringComparison.OrdinalIgnoreCase)) score += 40; // prefix wins
            return true;
        }

        private void UpdateCompletion(int minLen)
        {
            if (_native == null || _editorId == 0) { CloseCompletion(); return; }

            if (_langToken == "cs")
            {
                string text = _native.EditorText(Eid);
                int off = _native.EditorCaretOffset(Eid);
                // Don't pop completion inside comments or string/char literals.
                if (InCommentOrStringAt(text, off)) { CloseCompletion(); return; }
                string wp = _native.EditorWordPrefix(Eid);
                int nameStart = off - wp.Length;
                int mode = CompletionModeAt(text, nameStart); // 0 general, 1 member, 2 attribute, 3 type, 4 namespace

                // General completion needs a couple chars so the popup isn't the whole
                // symbol table on the first letter; member/attribute open immediately,
                // and a "rich" spot (call args, `new`, `case`, an assignment, …) opens
                // with no prefix so its context-specific items show up right away.
                if (mode == 0 && wp.Length < Mathf.Max(minLen, 1) && !IsRichContext(text, nameStart))
                {
                    CloseCompletion();
                    return;
                }

                // Cache hit → filter instantly on the main thread (no Roslyn).
                if (_memberCache != null && _memberAnchor == nameStart && _cacheMode == mode)
                {
                    ShowFromCache(wp, mode);
                    return;
                }
                // Cache miss → ask the background worker; the popup updates when the
                // result arrives (PollCompletion). Typing isn't blocked. Don't
                // resubmit if a request for this same context is already in flight.
                if (_pendingSeq == 0 || _pendingAnchor != nameStart || _pendingMode != mode)
                {
                    UntermRoslynCompletion.EnsureReferences(); // main-thread (Unity API)
                    _pendingAnchor = nameStart;
                    _pendingMode = mode;
                    _pendingSeq = UntermCompletionWorker.Submit(text, off, mode);
                }
                return;
            }

            // Non-C#: synchronous word + keyword completion.
            ShowWordCompletion(_native.EditorWordPrefix(Eid), minLen);
        }

        // Per-frame editor tick (registered on EditorApplication.update). A thin
        // dispatcher: each deferred/polled concern is its own method.
        private void OnEditorUpdate()
        {
            if (_native == null || _editorId == 0) return;
#if UNITY_EDITOR_WIN
            // Windows Unity doesn't reliably send MouseMove, so drive the hover
            // tooltip by repainting while the pointer is over this window — the
            // Repaint handler then polls the cursor. macOS uses MouseMove directly.
            if (mouseOverWindow == this) Repaint();
#endif
            // A line jump requested before the editor was ready (fresh window).
            if (_pendingLine > 0)
            {
                _native.EditorGotoLine(Eid, (uint)(_pendingLine - 1));
                _pendingLine = -1;
                Repaint();
            }
            // Pick up external changes (e.g. the Claude Code agent editing the file,
            // or `git add`/`reset`/commits run in a terminal changing the index)
            // even while this window stays focused — not just on OnFocus. Throttled.
            double now = EditorApplication.timeSinceStartup;
            if (hasFocus && now - _lastExtCheck >= ExternalCheckInterval)
            {
                _lastExtCheck = now;
                CheckExternalChange(); // still needed in preview (file may change on disk)
                // The diff gutter is an edit-mode surface: don't re-read git while
                // previewing (SetPreview refreshes it again on exit).
                if (!_preview) _native.EditorRefreshDiff(Eid); // background HEAD + index
            }
            // Poll at a bounded cadence while focused. Losing focus pauses this work;
            // OnFocus requests a fresh diff and resumes polling immediately.
            if (hasFocus && !_preview && now - _lastDiffPoll >= DiffPollInterval)
            {
                _lastDiffPoll = now;
                if (_native.EditorPollDiff(Eid)) { RenderView(); Repaint(); }
            }
            PollSignatureTask();
            // While a hint is shown, re-evaluate whenever the caret moved by ANY means
            // (arrows, click, edits) so it tracks the active parameter and closes once
            // the caret leaves the call — the per-key hooks alone miss plain motion.
            if (_sigOpen && _sigSeq == 0)
            {
                int caret = _native.EditorCaretOffset(Eid);
                if (caret != _sigReqOff) RequestSignatureHelp();
            }
            PollCompletion();
        }

        // Apply a finished background completion result (off the typing path).
        private void PollCompletion()
        {
            if (_pendingSeq == 0) return;
            if (!UntermCompletionWorker.TryTake(_pendingSeq, out var result)) return;

            int anchor = _pendingAnchor;
            int mode = _pendingMode;
            _pendingSeq = 0;
            _memberCache = result;
            _memberAnchor = anchor;
            _cacheMode = mode;

            // Only show if the caret is still in the same context the request was for.
            string text = _native.EditorText(Eid);
            int off = _native.EditorCaretOffset(Eid);
            string wp = _native.EditorWordPrefix(Eid);
            int nameStart = off - wp.Length;
            if (nameStart != anchor || CompletionModeAt(text, nameStart) != mode) return;

            if (_memberCache != null) ShowFromCache(wp, mode);
            else if (mode == 0) ShowWordCompletion(wp, 1); // Roslyn unavailable → word fallback
            else CloseCompletion();
        }

        // Apply a finished signature-help request: a null result (caret not inside a
        // call) hides the native hint; otherwise (re)show it (also repositions it as
        // the caret moves within the call).
        private void PollSignatureTask()
        {
            if (_sigSeq == 0) return;
            if (!UntermSignatureWorker.TryTake(_sigSeq, out var sig)) return;
            _sigSeq = 0;
            _sig = sig;
            _sigOpen = sig != null && sig.Items.Count > 0;
            PushSignature();
        }

        // Ask the worker for parameter hints at the caret (off the typing path).
        private void RequestSignatureHelp()
        {
            if (_native == null || _editorId == 0 || _langToken != "cs") return;
            string text = _native.EditorText(Eid);
            int off = _native.EditorCaretOffset(Eid);
            UntermRoslynCompletion.EnsureReferences(); // main-thread (Unity API)
            _sigReqOff = off;
            _sigSeq = UntermSignatureWorker.Submit(text, off);
        }

        private void CloseSignatureHelp()
        {
            _sigSeq = 0;
            if (!_sigOpen && _sig == null) { _native?.PopupSigHide(); return; }
            _sig = null;
            _sigOpen = false;
            _native?.PopupSigHide();
        }

        // Filter the cached symbol list by `wp` and show the popup. Cheap; runs
        // synchronously per keystroke. `mode`: 0 general, 1 member, 2 attribute.
        private void ShowFromCache(string wp, int mode)
        {
            if (_memberCache == null) { CloseCompletion(); return; }
            var scored = new List<(string insert, string label, char kind, int score)>();
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var (insert, label, kind) in _memberCache)
                if (FuzzyMatch(insert, wp, out int sc) && seen.Add(insert))
                {
                    // Context-specific items (named arguments `x: `, object-initializer
                    // members `X = `, and the expected enum's qualified members) lead
                    // the list — they're why completion popped here.
                    if (insert.EndsWith(": ") || insert.EndsWith(" = ")
                        || (kind == 'E' && insert.IndexOf('.') >= 0))
                        sc += 500;
                    scored.Add((insert, label, kind, sc));
                }
            // C# keywords only make sense in plain (general) statement context.
            if (mode == 0)
                foreach (var kw in s_csKeywords)
                    if (FuzzyMatch(kw, wp, out int sc) && seen.Add(kw))
                        scored.Add((kw, kw, 'K', sc));
            // Unimported types matching the prefix (auto-import on accept). Queried live
            // per keystroke from the prebuilt index — being prefix-dependent, they can't
            // ride the per-word symbol cache. Ranked below everything in scope.
            if (mode == 0 && wp.Length >= 3)
            {
                var inScope = new HashSet<string>(StringComparer.Ordinal);
                foreach (var it in _memberCache) inScope.Add(it.insert);
                var uni = UntermRoslynCompletion.UnimportedTypesMatching(wp, inScope);
                if (uni != null)
                    foreach (var u in uni)
                        if (seen.Add(u.label) && FuzzyMatch(u.insert, wp, out int sc))
                            // Only a slight tiebreak below an equally-good in-scope match,
                            // so a prefix-matching unimported type still beats in-scope
                            // fuzzy (subsequence) matches.
                            scored.Add((u.insert, u.label, u.kind, sc - 5));
            }
            if (scored.Count == 0) { CloseCompletion(); return; }
            // Rank: concrete symbols (types, members, …) before namespaces — a `[`
            // attribute or `new` list should lead with the class, not the namespaces
            // it could be qualified through (matches VS Code). Then by fuzzy score,
            // ties broken alphabetically for stability.
            scored.Sort((a, b) =>
            {
                bool an = a.kind == 'N', bn = b.kind == 'N';
                if (an != bn) return an ? 1 : -1;
                if (b.score != a.score) return b.score.CompareTo(a.score);
                return string.Compare(a.insert, b.insert, StringComparison.Ordinal);
            });
            _complItems = new List<string>();
            _complLabels = new List<string>();
            _complKinds = new List<char>();
            foreach (var s in scored)
            {
                _complItems.Add(s.insert);
                _complLabels.Add(s.label);
                _complKinds.Add(s.kind);
                if (_complItems.Count >= 300) break;
            }
            _complPrefixLen = wp.Length;
            _complSel = 0; // preselect the best-ranked match
            EnsureComplSelVisible();
            _complOpen = true;
            PushCompletions();
        }

        // Stage 1 (fallback): C# keywords + identifiers already in the buffer.
        private void ShowWordCompletion(string prefix, int minLen)
        {
            if (prefix.Length < minLen) { CloseCompletion(); return; }
            var scored = new List<(string word, char kind, int score)>();
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var kw in s_csKeywords)
                if (kw != prefix && FuzzyMatch(kw, prefix, out int sc) && seen.Add(kw))
                    scored.Add((kw, 'K', sc));
            foreach (Match m in s_ident.Matches(_native.EditorText(Eid)))
            {
                string w = m.Value;
                if (w != prefix && w.Length > 1 && FuzzyMatch(w, prefix, out int sc) && seen.Add(w))
                    scored.Add((w, ' ', sc));
            }
            if (scored.Count == 0) { CloseCompletion(); return; }
            scored.Sort((a, b) => b.score != a.score
                ? b.score.CompareTo(a.score)
                : string.Compare(a.word, b.word, StringComparison.Ordinal));
            if (scored.Count > 200) scored = scored.GetRange(0, 200);
            _complItems = new List<string>(scored.Count);
            _complKinds = new List<char>(scored.Count);
            foreach (var s in scored) { _complItems.Add(s.word); _complKinds.Add(s.kind); }
            _complLabels = _complItems; // word/keyword completion: label == insert
            _complPrefixLen = prefix.Length;
            _complSel = 0; // preselect the best-ranked match
            EnsureComplSelVisible();
            _complOpen = true;
            PushCompletions();
        }

        // Push the popup state (items + selection) to the native editor, which
        // renders it on top of the text at the caret.
        private void PushCompletions()
        {
            if (_native == null || _editorId == 0) return;
            if (!_complOpen)
            {
                _native.EditorSetCompletions(Eid, "", 0); // clear any in-texture popup
                _native.PopupHide();
                RenderView();
                Repaint();
                return;
            }
            // Each line is a 1-char kind tag + the display label, so the native
            // renderer can color it like the editor.
            var sb = new System.Text.StringBuilder();
            for (int i = 0; i < _complLabels.Count; i++)
            {
                if (i > 0) sb.Append('\n');
                sb.Append(i < _complKinds.Count ? _complKinds[i] : ' ').Append(_complLabels[i]);
            }
            string payload = sb.ToString();
            if (_native.PopupAvailable)
            {
                // Native OS popup (NSPanel): can overflow the editor window and never
                // steals focus. Keep the in-texture popup cleared.
                _native.EditorSetCompletions(Eid, "", 0);
                bool dark = EditorGUIUtility.isProSkin;
                Color32 fg = dark ? new Color32(210, 210, 214, 255) : new Color32(32, 32, 32, 255);
                // Native clears/quads in linear space; the sRGB target re-encodes on
                // store (same as EditorSetTheme).
                int vis = Mathf.Min(_complItems.Count, ComplRows);
                _complScroll = Mathf.Clamp(_complScroll, 0, Mathf.Max(0, _complItems.Count - vis));
                _native.PopupShow(payload, (uint)_complSel, (uint)_complScroll, _popupAnchorX, _popupAnchorY, _popupScale,
                    GetEditorBackground().linear, fg, dark);
            }
            else
            {
                _native.EditorSetCompletions(Eid, payload, (uint)_complSel); // fallback: in-texture
            }
            RenderView();
            Repaint();
        }

        private void CloseCompletion()
        {
            if (!_complOpen) return;
            _complOpen = false;
            _complSel = 0;
            _complScroll = 0;
            PushCompletions();
        }

        // Clamp the popup scroll offset so the current selection stays visible
        // (after arrow nav, or after the list changed).
        private void EnsureComplSelVisible()
        {
            int vis = Mathf.Min(_complItems.Count, ComplRows);
            if (_complSel < _complScroll) _complScroll = _complSel;
            else if (_complSel >= _complScroll + vis) _complScroll = _complSel - vis + 1;
            _complScroll = Mathf.Clamp(_complScroll, 0, Mathf.Max(0, _complItems.Count - vis));
        }

        private void AcceptCompletion()
        {
            if (!_complOpen || _complItems.Count == 0) { CloseCompletion(); return; }
            int sel = _complSel;
            string insert = _complItems[sel];
            char kind = sel < _complKinds.Count ? _complKinds[sel] : ' ';
            string label = sel < _complLabels.Count ? _complLabels[sel] : insert;
            int del = _complPrefixLen;
            // Override completion replaces the typed `override ` keyword too — the
            // generated member already carries its own `public override`.
            if (_cacheMode == 5)
            {
                string txt = _native.EditorText(Eid);
                int caret = _native.EditorCaretOffset(Eid);
                int p = Mathf.Clamp(caret - _complPrefixLen, 0, txt.Length);
                int i = p;
                while (i > 0 && (txt[i - 1] == ' ' || txt[i - 1] == '\t')) i--;
                const string ovr = "override";
                if (i >= ovr.Length && txt.Substring(i - ovr.Length, ovr.Length) == ovr)
                {
                    int b = i - ovr.Length;
                    if (b == 0 || !(char.IsLetterOrDigit(txt[b - 1]) || txt[b - 1] == '_'))
                        del = caret - b;
                }
            }
            _native.EditorComplete(Eid, (uint)del, insert);
            // Unimported type: add the `using` for its namespace (encoded in the label).
            if (kind == 'U')
            {
                string ns = UntermRoslynCompletion.NamespaceFromUnimportedLabel(label);
                if (!string.IsNullOrEmpty(ns)) _native.EditorAddUsing(Eid, ns);
            }
            // Methods/constructors: auto-insert "()" (VS Code behavior). Put the caret
            // between the parens if it takes parameters, else after them. (Override
            // inserts a full member with its own body, so skip it there.)
            bool wantSig = false;
            if (_cacheMode != 5 && (kind == 'M' || kind == 'X') && !insert.EndsWith(")"))
            {
                _native.EditorInsert(Eid, "()");
                if (MethodHasParams(label)) { _native.EditorKey(Eid, "LeftArrow", false, false, false); wantSig = true; }
            }
            MarkDirty();
            CloseCompletion(); // clears the popup and re-renders
            if (wantSig) RequestSignatureHelp(); // show parameter hints for the new call
        }

        // True if the completion label's signature shows at least one parameter
        // (e.g. "Translate(Vector3) : void" → true, "ToString() : string" → false).
        private static bool MethodHasParams(string label)
        {
            int a = label.IndexOf('(');
            if (a < 0) return false;
            int b = label.IndexOf(')', a + 1);
            return b > a + 1;
        }

        // Called after typed text commits, to open/refilter as the user types.
        private void OnTextTyped(string committed)
        {
            // Signature help: (re)evaluate when entering or editing a call's argument
            // list (or to dismiss it on the closing paren / leaving the call). Use
            // Contains, not ==, so a multi-char IME commit like "Foo(" still triggers.
            if (committed.IndexOf('(') >= 0 || committed.IndexOf(')') >= 0
                || committed.IndexOf(',') >= 0 || _sigOpen)
                RequestSignatureHelp();
            // Open completion immediately (no prefix typed yet) when the new character
            // makes a context that knows what to offer: a member dot, an attribute
            // bracket, or an argument/new/case/assignment spot — see UpdateCompletion's
            // rich-context check. A plain space just closes the popup.
            char last = committed.Length > 0 ? committed[committed.Length - 1] : '\0';
            if (committed == "." || committed == "[" || last == '(' || last == ',' || last == ' ')
            {
                UpdateCompletion(0);
                return;
            }
            if (_complOpen) { UpdateCompletion(1); return; }
            // Auto-open from the first identifier character (like VS Code).
            if (committed.Length == 1 && (char.IsLetter(committed[0]) || committed[0] == '_'))
                UpdateCompletion(1);
        }

        // --- IME (hidden field that drives composition + plain typing) ---------

        private void DrawImeField(Rect rect)
        {
            if (_native == null || _editorId == 0) return;
            // No keyboard focus → skip the hidden IME field entirely. It only exists
            // to anchor composition and receive typing (both need focus), and its
            // transparent-text TextField still draws a thin text cursor at the caret —
            // which must not linger on a background (unfocused) window.
            if (focusedWindow != this && !_composing && string.IsNullOrEmpty(Input.compositionString))
                return;
            float ppp = EditorGUIUtility.pixelsPerPoint;
            _native.EditorCaret(Eid, out float cx, out float cy, out float _, out float chh);
            float gx = rect.x + cx / ppp;
            float gy = rect.y + cy / ppp;
            float gh = Mathf.Max(14f, chh / ppp);

            // Cache the caret's screen position (points) for the native popups: the
            // completion list hangs from the caret bottom, the signature hint sits
            // above the caret top.
            var sp = GUIUtility.GUIToScreenPoint(new Vector2(gx, gy + gh));
            _popupAnchorX = sp.x;
            _popupAnchorY = sp.y;
            _popupAnchorTopY = GUIUtility.GUIToScreenPoint(new Vector2(gx, gy)).y;
            _popupScale = ppp;

            // Clamp the focused field's cached TextEditor caret to the current buffer:
            // Unity doesn't re-clamp it when `_imeBuffer` is reset out from under it,
            // so a stale index throws ArgumentOutOfRange in ReplaceSelection on the
            // next keystroke.
            if (GUIUtility.keyboardControl != 0
                && GUIUtility.GetStateObject(typeof(TextEditor), GUIUtility.keyboardControl) is TextEditor kte)
            {
                kte.cursorIndex = Mathf.Min(kte.cursorIndex, _imeBuffer.Length);
                kte.selectIndex = Mathf.Min(kte.selectIndex, _imeBuffer.Length);
            }

            GUI.SetNextControlName(InputControl);
            var style = ImeHidden();
            bool composing = _composing || !string.IsNullOrEmpty(Input.compositionString);
            if (composing)
            {
                style.alignment = TextAnchor.UpperRight;
                float w = Mathf.Max(120f, gx);
                _imeBuffer = GUI.TextField(new Rect(gx - w, gy, w, gh), _imeBuffer, style);
            }
            else
            {
                style.alignment = TextAnchor.UpperLeft;
                _imeBuffer = GUI.TextField(new Rect(gx, gy, 2f, gh), _imeBuffer, style);
            }
            if (focusedWindow == this)
                Input.compositionCursorPos = new Vector2(gx, gy + gh * 1.5f);
        }

        // Draw the parameter-hint box just above the caret (or below if no room),
        // with the active parameter bolded and an overload count.
        // Push the parameter hint to the native signature panel (anchored above the
        // caret), or hide it. The native renderer colors the active parameter, so we
        // pass the plain line plus the active parameter's char range.
        private void PushSignature()
        {
            if (_native == null || _editorId == 0 || !_native.PopupSigAvailable) return;
            if (!_sigOpen || _sig == null || _sig.Items.Count == 0)
            {
                _native.PopupSigHide();
                return;
            }
            var item = _sig.Items[Mathf.Clamp(_sig.ActiveSignature, 0, _sig.Items.Count - 1)];
            var sb = new System.Text.StringBuilder();
            sb.Append(item.Prefix);
            int activeStart = 0, activeLen = 0;
            for (int i = 0; i < item.Parameters.Count; i++)
            {
                if (i > 0) sb.Append(", ");
                if (i == _sig.ActiveParameter) { activeStart = sb.Length; activeLen = item.Parameters[i].Length; }
                sb.Append(item.Parameters[i]);
            }
            sb.Append(item.Suffix);
            if (_sig.Items.Count > 1) sb.Append($"   (+{_sig.Items.Count - 1})");

            bool dark = EditorGUIUtility.isProSkin;
            Color32 fg = dark ? new Color32(210, 210, 214, 255) : new Color32(32, 32, 32, 255);
            _native.PopupSigShow(sb.ToString(), (uint)activeStart, (uint)activeLen,
                _popupAnchorX, _popupAnchorTopY, _popupScale, GetEditorBackground().linear, fg, dark);
        }

        private GUIStyle ImeHidden()
        {
            if (_imeHidden == null)
            {
                _imeHidden = new GUIStyle(GUIStyle.none);
                var clear = new Color(0f, 0f, 0f, 0f);
                _imeHidden.normal.textColor = clear;
                _imeHidden.focused.textColor = clear;
                _imeHidden.hover.textColor = clear;
                _imeHidden.active.textColor = clear;
            }
            return _imeHidden;
        }

        private void SyncIme()
        {
            if (_native == null || _editorId == 0) return;

            if (focusedWindow != this)
            {
                if (!string.IsNullOrEmpty(_lastPreedit))
                {
                    _native.EditorSetPreedit(Eid, "");
                    _lastPreedit = "";
                    RenderView(); Repaint();
                }
                return;
            }

            if (_composing)
            {
                string marked = _imeBuffer + Input.compositionString;
                if (marked != _lastPreedit)
                {
                    _lastPreedit = marked;
                    _native.EditorSetPreedit(Eid, marked);
                    RenderView(); Repaint();
                }
                return;
            }

            if (Event.current.type != EventType.Repaint) return;

            if (!string.IsNullOrEmpty(_lastPreedit))
            {
                _native.EditorSetPreedit(Eid, "");
                _lastPreedit = "";
            }
            if (string.IsNullOrEmpty(_imeBuffer)) return;

            string typed = _imeBuffer;
            _native.EditorInsert(Eid, _imeBuffer);
            _imeBuffer = "";
            var te = (TextEditor)GUIUtility.GetStateObject(typeof(TextEditor), GUIUtility.keyboardControl);
            if (te != null) { te.text = ""; te.cursorIndex = 0; te.selectIndex = 0; }
            MarkDirty();
            RenderView(); Repaint();
            OnTextTyped(typed); // open / refilter the completion popup
        }

        // --- save / dirty ------------------------------------------------------

        private void MarkDirty()
        {
            // Recompute against the saved version (cheap u64), so editing then undoing
            // back to the saved content clears the flag rather than latching it on.
            if (_native == null || _editorId == 0) return;
            bool dirty = _native.EditorEditSerial(Eid) != _savedSerial;
            _dirty = dirty;
            // Unity shows the unsaved indicator on the tab from hasUnsavedChanges
            // and prompts on close via saveChangesMessage — no manual title marker.
            hasUnsavedChanges = dirty;
            if (dirty) saveChangesMessage = $"{Path.GetFileName(_filePath)} has unsaved changes.";
        }

        public override void SaveChanges()
        {
            Save();
            base.SaveChanges();
        }

        private void Save()
        {
            if (_native == null || _editorId == 0) return;
            if (string.IsNullOrEmpty(_filePath))
            {
                string path = EditorUtility.SaveFilePanel("Save", Application.dataPath, "Untitled", "cs");
                if (string.IsNullOrEmpty(path)) return;
                _filePath = path;
                _langToken = LangTokenFor(path) ?? "";
                _native.EditorSetLanguage(Eid, _langToken);
            }

            // Guard against clobbering an external change that landed since we loaded
            // or last synced (e.g. between on-disk-change polls): confirm the overwrite.
            if (_fileTicks != 0 && File.Exists(_filePath)
                && File.GetLastWriteTimeUtc(_filePath).Ticks != _fileTicks
                && !EditorUtility.DisplayDialog(
                    "Overwrite external changes?",
                    $"{Path.GetFileName(_filePath)} was changed on disk since you opened it. " +
                    "Overwrite those changes with your version?",
                    "Overwrite", "Cancel"))
            {
                _status = "Save canceled (file changed on disk)";
                return;
            }

            string text = _native.EditorText(Eid);
            if (_crlf) text = text.Replace("\n", "\r\n");
            try
            {
                File.WriteAllText(_filePath, text);
            }
            catch (Exception e)
            {
                _status = "save failed: " + e.Message;
                Debug.LogError("[Unterm] " + e);
                return;
            }

            // Record our own write time so it isn't seen as an external change.
            _fileTicks = File.Exists(_filePath) ? File.GetLastWriteTimeUtc(_filePath).Ticks : 0;
            // Baseline the dirty check to the just-saved state.
            _savedSerial = _native.EditorEditSerial(Eid);

            // Reimport if the file lives under the project so Unity recompiles.
            string rel = ToProjectRelative(_filePath);
            if (rel != null) AssetDatabase.ImportAsset(rel, ImportAssetOptions.ForceUpdate);

            _dirty = false;
            hasUnsavedChanges = false;
            // Path may have just been chosen (untitled → Save As); (re)point the diff
            // gutter at it and re-fetch the git texts.
            _native.EditorSetPath(Eid, _filePath);
            UpdateTitle();
            RenderView(); Repaint();
        }

        // A path under the project's Assets/ or Packages/ as a project-relative
        // path (for AssetDatabase), or null if it's outside the project.
        private static string ToProjectRelative(string path)
        {
            string full = Path.GetFullPath(path).Replace('\\', '/');
            string root = ProjectRoot.Replace('\\', '/').TrimEnd('/') + "/";
            if (!full.StartsWith(root, StringComparison.OrdinalIgnoreCase)) return null;
            string rel = full.Substring(root.Length);
            return (rel.StartsWith("Assets/") || rel.StartsWith("Packages/")) ? rel : null;
        }

        private void UpdateTitle()
        {
            // No manual dirty marker — Unity overlays the unsaved indicator from
            // hasUnsavedChanges.
            string title = string.IsNullOrEmpty(_filePath) ? "Untitled" : Path.GetFileName(_filePath);
            if (_preview) title += " (Preview)";
            titleContent = UntermWindowTitle.Create(title, UntermWindowTitle.CodeEditorIcon, titleContent);
        }

        // Cmd/Ctrl+S while this window is focused saves the file (a window-context
        // shortcut takes priority over the global File ▸ Save when focused, and
        // restores it elsewhere).
        [Shortcut("Unterm/Save Code File", typeof(UntermCodeEditorWindow), KeyCode.S, ShortcutModifiers.Action)]
        private static void SaveShortcut(ShortcutArguments args)
        {
            var w = args.context as UntermCodeEditorWindow ?? focusedWindow as UntermCodeEditorWindow;
            w?.Save();
        }
    }
}
