using UnityEditor;

namespace Unterm.Editor
{
    /// <summary>
    /// Gates the "Window/Unterm/Claude Code" entry on Unterm's own managed Claude Code
    /// engine binary: the item is enabled only once the binary has been downloaded
    /// (see <see cref="UntermClaudeInstaller"/> and the "Preferences &gt; Unterm" page,
    /// <see cref="UntermSettingsProvider"/>), and selecting it opens the agent panel
    /// (<see cref="UntermAgentWindow"/>).
    ///
    /// Unterm deliberately drives only the engine it manages, not whatever <c>claude</c>
    /// the user may have installed, so it always runs a known-good binary. The managed
    /// path is handed to the native agent at spawn (see <see cref="ClaudePath"/>), so
    /// "available" is exactly "what gets launched".
    ///
    /// Unity has no supported API to add/remove a menu item at runtime, so the entry is
    /// a static <c>[MenuItem]</c> whose validate callback greys it out until the binary
    /// is present (an instant <c>File.Exists</c>, so no caching is needed).
    /// </summary>
    internal static class ClaudeCode
    {
        private const string MenuPath = "Window/Unterm/Claude Code";

        /// The absolute path to the managed `claude` binary, passed to the native agent
        /// at spawn (<see cref="UntermNative.AgentviewCreate"/>). "" until it has been
        /// downloaded via the Preferences page.
        internal static string ClaudePath => UntermClaudeInstaller.InstalledBinaryPath();

#if UNITY_EDITOR_OSX || UNITY_EDITOR_WIN
        [MenuItem(MenuPath, priority = 1)]
        public static void OpenClaudeCode()
        {
            // Open the native agent panel (it starts the in-editor MCP server
            // and wires the session to it for the unity_* tools).
            UntermAgentWindow.Open();
        }

        [MenuItem(MenuPath, validate = true)]
        public static bool OpenClaudeCodeValidate() => !string.IsNullOrEmpty(ClaudePath);
#endif
    }
}
