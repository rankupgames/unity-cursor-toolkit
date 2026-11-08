// Fixture-only build/runtime evidence and normal-stop control. Never copied to the sample.
using System;
using System.Globalization;
using System.IO;
using UnityEngine;
using UnityEngine.Rendering;
#if UNITY_EDITOR
using UnityEditor;
using UnityEditor.Build;
#endif
namespace UCTPlayerProof
{
    internal sealed class CoreCLRPlayerProof : MonoBehaviour
    {
        private string root;
        private float deadline;
#if UNITY_EDITOR
        public static void Build()
        {
            string result = Environment.GetEnvironmentVariable("UCT_PLAYER_BUILD_RESULT");
            EditorApplication.quitting += () => File.WriteAllText(Path.Combine(Path.GetDirectoryName(result), "editor-quitting"), "normal owned build quit");
            try
            {
                PlayerSettings.SetScriptingBackend(NamedBuildTarget.Standalone, ScriptingImplementation.CoreCLR);
                PlayerSettings.SetApiCompatibilityLevel(NamedBuildTarget.Standalone, ApiCompatibilityLevel.NET_Standard);
                Type builder = Type.GetType("UnityCursorToolkit.ViewportServiceBuild, Assembly-CSharp-Editor", true);
                System.Reflection.MethodInfo build = builder.GetMethod("BuildFromCommandLine", System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static, null, Type.EmptyTypes, null);
                if (build == null) throw new MissingMethodException(builder.FullName, "BuildFromCommandLine");
                try { build.Invoke(null, null); }
                catch (System.Reflection.TargetInvocationException error) when (error.InnerException != null)
                { System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(error.InnerException).Throw(); throw; }
                File.WriteAllText(result, "{\"success\":true,\"editorVersion\":" + Quote(Application.unityVersion)
                    + ",\"editorCoreLibrary\":" + Quote(typeof(object).Assembly.GetName().Name)
                    + ",\"backend\":" + Quote(PlayerSettings.GetScriptingBackend(NamedBuildTarget.Standalone).ToString())
                    + ",\"api\":" + Quote(PlayerSettings.GetApiCompatibilityLevel(NamedBuildTarget.Standalone).ToString())
                    + ",\"target\":\"StandaloneWindows64\",\"buildOptions\":\"None\"}");
            }
            catch (Exception error)
            {
                File.WriteAllText(result, "{\"success\":false,\"error\":" + Quote(error.ToString()) + "}");
                throw;
            }
        }
#endif
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        private static void Initialize()
        {
            string requested = Environment.GetEnvironmentVariable("UCT_PLAYER_PROOF_CONTROL");
            if (string.IsNullOrEmpty(requested)) return;
            string resolved = Path.GetFullPath(requested);
            string temp = Path.GetFullPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            if (!resolved.StartsWith(temp, StringComparison.OrdinalIgnoreCase)
                || !Directory.GetParent(resolved).Name.StartsWith("uct-player-proof-", StringComparison.Ordinal))
                throw new InvalidOperationException("Owned player control must be inside the disposable project.");
            Directory.CreateDirectory(resolved);
            CoreCLRPlayerProof probe = new GameObject("UCT owned player evidence").AddComponent<CoreCLRPlayerProof>();
            DontDestroyOnLoad(probe.gameObject);
            probe.root = resolved;
            probe.deadline = Time.realtimeSinceStartup + 120f;
            string identity = Path.Combine(resolved, "identity.json");
            File.WriteAllText(identity + ".tmp", "{\"editorVersion\":" + Quote(Application.unityVersion)
                + ",\"coreLibrary\":" + Quote(typeof(object).Assembly.GetName().Name)
                + ",\"pid\":" + System.Diagnostics.Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture)
                + ",\"platform\":" + Quote(Application.platform.ToString())
                + ",\"is64BitProcess\":" + (Environment.Is64BitProcess ? "true" : "false")
                + ",\"renderPipeline\":" + Quote(GraphicsSettings.currentRenderPipeline == null ? "" : GraphicsSettings.currentRenderPipeline.GetType().FullName)
                + ",\"instrumentation\":\"fixture-only\"}");
            File.Move(identity + ".tmp", identity);
        }
        private void Update()
        {
            if (File.Exists(Path.Combine(root, "stop")) || Time.realtimeSinceStartup > deadline) Application.Quit(0);
        }
        private void OnApplicationQuit()
        {
            if (!string.IsNullOrEmpty(root)) File.WriteAllText(Path.Combine(root, "quitting"), "normal owned player quit");
        }
        private static string Quote(string text)
        {
            return "\"" + (text ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "\\r").Replace("\n", "\\n").Replace("\t", "\\t") + "\"";
        }
    }
}
