using System.Collections.Generic;
using System.Threading;
using UnityEditor;
using UnityEngine;

namespace Unterm.Editor
{
    /// <summary>
    /// "Preferences &gt; Unterm" page. Its job is to download Anthropic's standalone
    /// engine binary with a button (see <see cref="UntermClaudeInstaller"/>) and show
    /// the active and pinned versions, the resolved binary path, and live download progress.
    /// Once the binary lands, the "Window/Unterm/Claude Code" menu enables on its own —
    /// its validate callback checks <c>File.Exists</c> live (see <see cref="ClaudeCode"/>).
    ///
    /// The download runs on a background thread; the page polls a few progress fields
    /// and repaints itself while it is in flight.
    /// </summary>
    internal static class UntermSettingsProvider
    {
        private static volatile bool s_busy;
        private static long s_downloaded;         // bytes pulled so far (this run)
        private static long s_total;              // total bytes, or 0 if unknown
        private static string s_message;          // last success / error line
        private static bool s_failed;
        private static EditorWindow s_repaintTarget;

        [SettingsProvider]
        public static SettingsProvider Create()
        {
            return new SettingsProvider("Preferences/Unterm", SettingsScope.User)
            {
                label = "Unterm",
                guiHandler = _ => OnGui(),
                keywords = new HashSet<string>
                {
                    "unterm", "claude", "claude code", "agent", "terminal", "download",
                    "code editor", "undo", "history", "sound", "notify", "notification", "chime",
                    "debug", "debugger", "breakpoint", "extension", "extensions", "open",
                    "unity", "mcp", "tools", "security", "approval",
                },
            };
        }

        private static void OnGui()
        {
            EditorGUILayout.Space();
            EditorGUILayout.LabelField("Claude Code", EditorStyles.boldLabel);
            EditorGUILayout.HelpBox(
                "Unterm's agent panel drives Anthropic's standalone Claude Code engine — no Node " +
                "required. If you haven't installed `claude` yourself, download it here. The binary " +
                "(~214 MB) is fetched from Anthropic's official npm registry into a per-user folder " +
                "shared by all your Unity projects, and you sign in with your own `claude login`.",
                MessageType.Info);

            string active = UntermClaudeInstaller.InstalledVersion();
            string resolved = ClaudeCode.ClaudePath;
            EditorGUILayout.LabelField("Active version",
                string.IsNullOrEmpty(active) ? "(none — download required)" : active);
            EditorGUILayout.LabelField("Pinned version", UntermClaudeInstaller.PinnedVersion);
            using (new EditorGUI.DisabledScope(true))
                EditorGUILayout.TextField("Binary path", string.IsNullOrEmpty(resolved) ? "(not found)" : resolved);

            EditorGUILayout.Space();

            if (s_busy)
            {
                long got = s_downloaded, total = s_total;
                float frac = total > 0 ? (float)((double)got / total) : 0f;
                string label = total > 0
                    ? $"Downloading… {Mb(got):0.0} / {Mb(total):0.0} MB ({Mathf.RoundToInt(frac * 100f)}%)"
                    : $"Downloading… {Mb(got):0.0} MB";
                var rect = EditorGUILayout.GetControlRect(false, 20f);
                EditorGUI.ProgressBar(rect, frac, label);
            }
            else
            {
                DrawAction();
            }

            if (!string.IsNullOrEmpty(s_message))
                EditorGUILayout.HelpBox(s_message, s_failed ? MessageType.Error : MessageType.Info);

            EditorGUILayout.Space();
            EditorGUILayout.LabelField("Code Editor", EditorStyles.boldLabel);
            int curLimit = UntermCodeEditorPrefs.UndoLimit;
            int nextLimit = EditorGUILayout.IntField(
                new GUIContent("Undo history limit",
                    "Maximum retained undo steps per editor buffer (0 = unlimited). Bounds memory " +
                    "over a long session; takes effect for editors opened afterward."),
                curLimit);
            if (nextLimit != curLimit)
                UntermCodeEditorPrefs.UndoLimit = nextLimit;

            string curExts = UntermOpenExtensions.Value;
            string nextExts = EditorGUILayout.DelayedTextField(
                new GUIContent("Openable extensions",
                    "Semicolon-separated file extensions the Unterm code editor claims: " +
                    "double-clicked assets (when Unterm is the External Script Editor) and " +
                    "file links clicked in the agent transcript. Anything else falls through " +
                    "to Unity's own handler or the OS default app."),
                curExts);
            if (nextExts != curExts)
                UntermOpenExtensions.Value = nextExts;
            if (nextExts != UntermOpenExtensions.Default &&
                GUILayout.Button("Reset extensions to default", GUILayout.ExpandWidth(false)))
                UntermOpenExtensions.Value = UntermOpenExtensions.Default;

            EditorGUILayout.Space();
            EditorGUILayout.LabelField("Agent", EditorStyles.boldLabel);
            bool notify = UntermAgentPrefs.NotifySoundEnabled;
            bool nextNotify = EditorGUILayout.Toggle(
                new GUIContent("Notify when idle",
                    "Play a chime and show an OS notification when the agent finishes a turn " +
                    "or needs a permission — but only while the Unity Editor is in the " +
                    "background, so you're only interrupted when you're away."),
                notify);
            if (nextNotify != notify)
                UntermAgentPrefs.NotifySoundEnabled = nextNotify;

            EditorGUILayout.Space();
            EditorGUILayout.LabelField("Debugger", EditorStyles.boldLabel);
            bool curDbg = UntermDebuggerPrefs.Enabled;
            bool nextDbg = EditorGUILayout.Toggle(
                new GUIContent("Enable debugging",
                    "Enables the Window/Unterm/Debugger (Standalone Process) menu and the code editor's breakpoint " +
                    "gutter (click left of the line numbers to set breakpoints; entering Play " +
                    "mode with breakpoints launches the debugger)."),
                curDbg);
            if (nextDbg != curDbg)
                UntermDebuggerPrefs.Enabled = nextDbg;

            EditorGUILayout.Space();
            EditorGUILayout.LabelField("Unity MCP", EditorStyles.boldLabel);
            EditorGUILayout.HelpBox(
                "These settings apply only to the current Unity project and are stored in local, " +
                "uncommitted Editor user settings.",
                MessageType.Info);
            bool mcpEnabled = UntermMcpSecurity.Enabled;
            bool nextMcpEnabled = EditorGUILayout.Toggle(
                new GUIContent("Enable MCP tools for this project",
                    "Disabled by default. Requests follow the current-project access policy."),
                mcpEnabled);
            if (nextMcpEnabled != mcpEnabled)
            {
                if (nextMcpEnabled)
                    UntermMcpSecurity.TryEnableWithConfirmation();
                else
                    UntermMcpSecurity.Disable();
                UntermMcp.RefreshTools();
            }
            if (!UntermMcpSecurity.Enabled)
            {
                EditorGUILayout.HelpBox(
                    "MCP is disabled. Unterm does not load MCP native state, build the Unity tool catalog, capture logs, or poll requests.",
                    MessageType.Info);
                return;
            }

            UntermMcpAccessPolicy accessPolicy = UntermMcpSecurity.AccessPolicy;
            UntermMcpAccessPolicy nextAccessPolicy = (UntermMcpAccessPolicy)EditorGUILayout.EnumPopup(
                new GUIContent("Current-project access",
                    "Prompt keeps one-shot approval. Allow Mutating permits known mutations without prompts. " +
                    "Allow Dangerous also permits known dangerous actions without prompts."),
                accessPolicy);
            if (nextAccessPolicy != accessPolicy)
                UntermMcpSecurity.TrySetAccessPolicyWithConfirmation(nextAccessPolicy);

            string policyMessage = UntermMcpSecurity.AccessPolicy switch
            {
                UntermMcpAccessPolicy.AllowMutating => "Known mutations may run unattended in this project. Dangerous actions still require one-shot approval; batch dangerous requests fail closed.",
                UntermMcpAccessPolicy.AllowDangerous => "Known mutating and dangerous actions may run unattended in this project. Unclassified tools are never auto-allowed.",
                _ => "Mutating and dangerous actions require fresh one-shot approval. Requests that need a prompt fail closed in batch mode.",
            };
            EditorGUILayout.HelpBox(policyMessage, MessageType.Warning);

            using (new EditorGUI.DisabledScope(UntermMcpSecurity.AccessPolicy != UntermMcpAccessPolicy.AllowDangerous))
            {
                bool allowArbitraryCSharp = UntermMcpSecurity.AllowArbitraryCSharp;
                bool nextAllowArbitraryCSharp = EditorGUILayout.Toggle(
                    new GUIContent("Allow Arbitrary C#",
                        "Separate opt-in that lets unity_execute_code run without a per-call prompt in this project."),
                    allowArbitraryCSharp);
                if (nextAllowArbitraryCSharp != allowArbitraryCSharp)
                    UntermMcpSecurity.TrySetAllowArbitraryCSharpWithConfirmation(nextAllowArbitraryCSharp);
            }
            EditorGUILayout.HelpBox(
                "Arbitrary C# has full machine and Editor access under your user account: it can read or write " +
                "files, launch processes, use the network, inspect environment data, and modify this project. " +
                "It runs unattended only when Allow Dangerous and the separate opt-in above are both enabled.",
                MessageType.Error);
        }

        private static void DrawAction()
        {
            string installed = UntermClaudeInstaller.InstalledVersion();
            bool updateAvailable = !string.IsNullOrEmpty(installed) &&
                                   installed != UntermClaudeInstaller.PinnedVersion;

            if (string.IsNullOrEmpty(installed))
            {
                if (GUILayout.Button("Download Claude Code")) StartDownload();
            }
            else if (updateAvailable)
            {
                EditorGUILayout.LabelField("Status", $"Installed {installed} — approved version is {UntermClaudeInstaller.PinnedVersion}");
                if (GUILayout.Button($"Install {UntermClaudeInstaller.PinnedVersion}")) StartDownload();
            }
            else
            {
                EditorGUILayout.LabelField("Status", $"Installed ({installed})");
                if (GUILayout.Button("Reinstall pinned version")) StartDownload();
            }
        }

        private static void StartDownload()
        {
            if (s_busy) return;
            s_busy = true;
            s_downloaded = 0;
            s_total = 0;
            s_message = null;
            s_failed = false;
            s_repaintTarget = EditorWindow.focusedWindow; // the Preferences window
            EditorApplication.update += RepaintWhileBusy;

            var thread = new Thread(() =>
            {
                string err = UntermClaudeInstaller.Download((got, total) =>
                {
                    s_downloaded = got;
                    s_total = total;
                });
                EditorApplication.delayCall += () =>
                {
                    s_busy = false;
                    EditorApplication.update -= RepaintWhileBusy;
                    if (err == null)
                    {
                        s_failed = false;
                        string v = UntermClaudeInstaller.InstalledVersion();
                        s_message = $"Installed Claude Code {v}. The menu is now enabled.";
                        // The menu's validate checks File.Exists live, so it enables on
                        // its own; nothing else to refresh.
                    }
                    else
                    {
                        s_failed = true;
                        s_message = "Download failed: " + err;
                    }
                    s_repaintTarget?.Repaint();
                };
            })
            {
                IsBackground = true,
                Name = "UntermClaudeDownload",
            };
            thread.Start();
        }

        private static void RepaintWhileBusy() => s_repaintTarget?.Repaint();

        private static double Mb(long bytes) => bytes / (1024.0 * 1024.0);
    }
}
