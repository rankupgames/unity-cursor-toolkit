using System;
using System.IO;
using System.Threading;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;
using Unity.Pipeline;
using Unity.Pipeline.Commands;
using Unity.Pipeline.Editor.Authoring;

[InitializeOnLoad]
public static class PipelineSafetyProof
{
    private const string Prefix = "PipelineSafetyProof.";
    private static double readySince = -1;
    private static bool ready;

    static PipelineSafetyProof()
    {
        EditorApplication.update += Update;
        EditorApplication.quitting += () => Emit("quitting");
        AssemblyReloadEvents.afterAssemblyReload += () => Emit("after-reload");
        Emit("initialize");
    }

    private static void Emit(string name)
    {
        Debug.Log("[PipelineSafetyProof] " + name + "|" + DateTime.UtcNow.ToString("o"));
    }

    private static void Update()
    {
        if (EditorApplication.isCompiling || EditorApplication.isUpdating) { readySince = -1; return; }
        if (!SessionState.GetBool(Prefix + "seeded", false))
        {
            SessionState.SetString(Prefix + "root", ProjectPaths.AuthoringRoot);
            Directory.CreateDirectory("Assets/PipelineSafety");
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            EditorSceneManager.SaveScene(SceneManager.GetActiveScene(), "Assets/PipelineSafety/proof.unity");
            SessionState.SetBool(Prefix + "seeded", true);
            Emit("seeded");
        }
        if (File.Exists("undo.request"))
        {
            File.Delete("undo.request");
            int before = CountProofObjects();
            Undo.PerformUndo();
            int after = CountProofObjects();
            EditorSceneManager.SaveScene(SceneManager.GetActiveScene());
            Emit("undo-before=" + before + "-after=" + after);
        }
        if (File.Exists("quit.request") || EditorApplication.timeSinceStartup > 600)
        {
            ProjectPaths.AuthoringRoot = SessionState.GetString(Prefix + "root", "Assets");
            EditorSceneManager.SaveScene(SceneManager.GetActiveScene());
            Emit(File.Exists("quit.request") ? "normal-exit" : "deadline-exit");
            EditorApplication.Exit(File.Exists("quit.request") ? 0 : 1);
            return;
        }
        if (readySince < 0) { readySince = EditorApplication.timeSinceStartup; }
        if (!ready && EditorApplication.timeSinceStartup - readySince > 2) { ready = true; Emit("ready"); }
    }

    private static int CountProofObjects()
    {
        int count = 0;
        foreach (GameObject item in SceneManager.GetActiveScene().GetRootGameObjects())
            if (item.name.StartsWith("PipelineUndoProof", StringComparison.Ordinal)) count++;
        return count;
    }

    // A bounded background operation provides real progress, timeout and cancellation observations.
    // It changes no authoring data and never evaluates caller-supplied code.
    [CliCommand("proof_delay", "Disposable proof only: report progress during a bounded background delay.", MainThreadRequired = false)]
    public static object Delay([CliArg("milliseconds", "Delay length, bounded to 0-8000 ms.")] int milliseconds = 2000)
    {
        if (milliseconds < 0 || milliseconds > 8000) throw new ArgumentException("milliseconds must be 0-8000");
        Emit("delay-start-" + milliseconds);
        int elapsed = 0;
        while (elapsed < milliseconds)
        {
            CliProgress.Report("Pipeline proof", current: elapsed, total: milliseconds);
            int step = Math.Min(200, milliseconds - elapsed);
            Thread.Sleep(step);
            elapsed += step;
        }
        CliProgress.Report("Pipeline proof", current: milliseconds, total: milliseconds);
        Emit("delay-finish-" + milliseconds);
        return new { completed = true, elapsedMs = elapsed };
    }
}
