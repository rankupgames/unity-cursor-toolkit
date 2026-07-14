using System.Diagnostics;
using System.IO;
using UnityEditor;
using UnityEngine;

namespace Unterm.Editor
{
    /// <summary>
    /// Whether debugging is enabled (Preferences &gt; Unterm). Gates the debugger menu
    /// item, the Play-mode auto-launch, and the code editor's breakpoint gutter (the
    /// gutter only reserves the dot column and toggles breakpoints when enabled).
    /// </summary>
    internal static class UntermDebuggerPrefs
    {
        private const string EnabledKey = "Unterm.Debugger.Enabled";

        /// Raised when <see cref="Enabled"/> changes, so open code editors can
        /// re-apply their gutter mode immediately.
        public static event System.Action Changed;

        public static bool Enabled
        {
            get => EditorPrefs.GetBool(EnabledKey, false);
            set
            {
                if (value == Enabled) return;
                EditorPrefs.SetBool(EnabledKey, value);
                Changed?.Invoke();
            }
        }
    }

    /// <summary>
    /// Manages the standalone Unterm debugger — a separate process with its own window
    /// that attaches to the editor's Mono agent. It can be opened explicitly from the
    /// <c>Window/Unterm/Debugger (Standalone Process)</c> menu, and is also opened automatically when you
    /// enter Play mode with breakpoints set. The window is persistent: it stays alive
    /// across Play/Stop cycles (surfacing itself when a breakpoint is hit) and closes
    /// itself when the editor it is attached to goes away.
    /// </summary>
    [InitializeOnLoad]
    internal static class UntermDebuggerLauncher
    {
        private const string ProcessName = "unterm-debugger";
#if UNITY_EDITOR_WIN
        private const string ExecutableName = ProcessName + ".exe";
#else
        private const string ExecutableName = ProcessName;
#endif
        private static Process _proc;

        static UntermDebuggerLauncher()
        {
            EditorApplication.playModeStateChanged -= OnPlayModeChanged;
            EditorApplication.playModeStateChanged += OnPlayModeChanged;
            // Best-effort cleanup of the instance we launched when the editor quits.
            EditorApplication.quitting -= Stop;
            EditorApplication.quitting += Stop;
            // (Following the editor to the foreground is handled natively by the debugger
            // via an NSWorkspace observer, so it works even while suspended at a
            // breakpoint — the editor's main thread is frozen then and can't signal.)
        }

        private static string ProjectRoot =>
            Directory.GetParent(Application.dataPath)?.FullName ?? Application.dataPath;

        // The debugger and editor coordinate through this project's Library/Unterm dir,
        // so single-instance and focus are scoped to THIS project (not by process name,
        // which would clash with a debugger running for another Unity project).
        private static string StateDir => Path.Combine(ProjectRoot, "Library", "Unterm");
        private static string PidFile => Path.Combine(StateDir, "debugger.pid");
        private static string FocusFile => Path.Combine(StateDir, "focus.request");

        /// Open the debugger window from the menu. If this project's debugger is already
        /// running, bring it forward; otherwise launch it (in Edit mode it attaches,
        /// arms the current breakpoints and waits for Play — you can also use Pause).
        /// Greyed out until debugging is enabled in Preferences > Unterm.
        [MenuItem("Window/Unterm/Debugger (Standalone Process) %#d")]
        internal static void Open() => EnsureRunning();

        [MenuItem("Window/Unterm/Debugger (Standalone Process) %#d", validate = true)]
        internal static bool OpenValidate() => UntermDebuggerPrefs.Enabled;

        private static void OnPlayModeChanged(PlayModeStateChange state)
        {
            // Auto-open on Play so a breakpoint has something to stop into. The window
            // is left running when leaving Play; it re-syncs breakpoints each run.
            // The debugger is a persistent, always-attached process (like an IDE that
            // stays attached across Play/Stop), so once it's up there's no launch race
            // to wait out — and the type-load watch suspends the VM to arm in time.
            if (state == PlayModeStateChange.ExitingEditMode && UntermDebuggerPrefs.Enabled)
            {
                UntermBreakpoints.Reload();
                if (UntermBreakpoints.All().Count > 0) EnsureRunning();
            }
        }

        // The PID of this project's running debugger (from its pid file), or 0 if none.
        // A domain reload discards the managed `_proc` handle, so the pid file — written
        // by the debugger into THIS project's Library/Unterm — is the source of truth.
        private static int RunningPid()
        {
            try
            {
                if (!File.Exists(PidFile)) return 0;
                if (!int.TryParse(File.ReadAllText(PidFile).Trim(), out var pid) || pid <= 0) return 0;
                var p = Process.GetProcessById(pid); // throws if no such process
                if (p.HasExited) return 0;
                // Guard against PID reuse: confirm it's actually our debugger.
                return p.ProcessName.Contains(ProcessName) ? pid : 0;
            }
            catch { return 0; }
        }

        private static bool IsRunning() => RunningPid() != 0;

        // Touch the focus file; the running debugger polls it and comes to the front.
        private static void RequestFocus()
        {
            try
            {
                Directory.CreateDirectory(StateDir);
                File.WriteAllText(FocusFile, System.DateTime.UtcNow.Ticks.ToString());
            }
            catch { /* best effort */ }
        }

        // The debugger binary ships next to the native plugin; fall back to the cargo
        // dev build during development.
        private static string DebuggerPath()
        {
            try
            {
                var dir = Path.GetDirectoryName(UntermWindow.PluginPath);
                if (!string.IsNullOrEmpty(dir))
                {
                    var p = Path.Combine(dir, ExecutableName);
                    if (File.Exists(p)) return p;
                }
            }
            catch { /* fall through to dev path */ }
            var dev = Path.Combine(ProjectRoot, "native", "target", "debug", ExecutableName);
            return File.Exists(dev) ? dev : null;
        }

        private static void EnsureRunning()
        {
            // Single instance per project: if it's already up, just bring it forward.
            if (IsRunning()) { RequestFocus(); return; }

            var exe = DebuggerPath();
            if (string.IsNullOrEmpty(exe))
            {
                UnityEngine.Debug.LogWarning("Unterm: unterm-debugger binary not found; cannot start debugger.");
                return;
            }

            // No breakpoint arguments: the debugger seeds itself from the shared store
            // (Library/Unterm/breakpoints.json) — the same file it re-reads on every
            // play-mode domain reload — so both sides share one source of truth.
            try
            {
                _proc = Process.Start(new ProcessStartInfo
                {
                    FileName = exe,
                    WorkingDirectory = ProjectRoot,
                    UseShellExecute = false,
                });
            }
            catch (System.Exception e)
            {
                UnityEngine.Debug.LogWarning("Unterm: failed to launch debugger: " + e.Message);
                _proc = null;
            }
        }

        private static void Stop()
        {
            try { if (_proc != null && !_proc.HasExited) _proc.Kill(); }
            catch { /* already gone */ }
            _proc = null;
            // Also stop the instance recorded in this project's pid file, in case our
            // managed handle was lost to a domain reload. This is project-scoped (the
            // pid file lives in this project's Library), so it won't touch another
            // project's debugger.
            try { var pid = RunningPid(); if (pid != 0) Process.GetProcessById(pid).Kill(); }
            catch { /* already gone */ }
        }
    }
}
