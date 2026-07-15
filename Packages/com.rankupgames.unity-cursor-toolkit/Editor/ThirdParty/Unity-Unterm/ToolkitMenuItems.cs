using UnityEditor;

namespace Unterm.Editor
{
    /// <summary>Unity Cursor Toolkit menu aliases for the vendored Unterm surfaces.</summary>
    internal static class ToolkitMenuItems
    {
        private const string ClaudeMenuPath = "Tools/Unity Cursor Toolkit/Unterm/Claude Code";
        private const string DebuggerMenuPath = "Tools/Unity Cursor Toolkit/Unterm/Debugger (Standalone Process)";

        [MenuItem("Tools/Unity Cursor Toolkit/Unterm/New Terminal", priority = 300)]
        private static void OpenTerminal() => UntermWindow.OpenNew();

        [MenuItem(ClaudeMenuPath, priority = 301)]
        private static void OpenClaudeCode() => ClaudeCode.OpenClaudeCode();

        [MenuItem(ClaudeMenuPath, validate = true)]
        private static bool OpenClaudeCodeValidate() => ClaudeCode.OpenClaudeCodeValidate();

        [MenuItem("Tools/Unity Cursor Toolkit/Unterm/Code Editor", priority = 302)]
        private static void OpenCodeEditor() => UntermCodeEditorWindow.OpenEmpty();

        [MenuItem(DebuggerMenuPath, priority = 303)]
        private static void OpenDebugger() => UntermDebuggerLauncher.Open();

        [MenuItem(DebuggerMenuPath, validate = true)]
        private static bool OpenDebuggerValidate() => UntermDebuggerLauncher.OpenValidate();

        [MenuItem("Tools/Unity Cursor Toolkit/Unterm/Settings", priority = 304)]
        private static void OpenSettings() => SettingsService.OpenUserPreferences("Preferences/Unterm");
    }
}
