using System.Collections.Generic;
using UnityEditor;
using UnityEngine;

namespace Unterm.Editor
{
    /// <summary>
    /// "Preferences &gt; Unterm" page for editor, debugger, and project-local MCP
    /// controls. Claude Code is optional and discovered from an existing installation;
    /// Unterm does not download or manage it from this page.
    /// </summary>
    internal static class UntermSettingsProvider
    {
        [SettingsProvider]
        public static SettingsProvider Create()
        {
            return new SettingsProvider("Preferences/Unterm", SettingsScope.User)
            {
                label = "Unterm",
                guiHandler = _ => OnGui(),
                keywords = new HashSet<string>
                {
                    "unterm", "claude", "claude code", "agent", "terminal",
                    "code editor", "undo", "history", "sound", "notify", "notification", "chime",
                    "debug", "debugger", "breakpoint", "extension", "extensions", "open",
                    "unity", "mcp", "tools", "security", "approval",
                },
            };
        }

        private static void OnGui()
        {
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
    }
}
