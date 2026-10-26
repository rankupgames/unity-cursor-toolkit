using System;
using System.IO;
using UnityEditor;
using UnityEditor.Build.Reporting;
using UnityEditor.SceneManagement;
using UnityEngine;

public static class CliProof
{
    public static void Run()
    {
        Debug.Log("CLI_PROOF_RUNTIME " + Application.unityVersion);
        EditorSceneManager.SaveScene(EditorSceneManager.NewScene(NewSceneSetup.EmptyScene), "Assets/Proof.unity");
        EditorApplication.Exit(0);
    }

    public static void RunDelay()
    {
        Directory.CreateDirectory("Temp");
        File.WriteAllText("Temp/cli-proof-partial.txt", "started");
        Debug.Log("CLI_PROOF_DELAY_STARTED");
        System.Threading.Thread.Sleep(30000);
        EditorApplication.Exit(0);
    }

    public static void Build()
    {
        var args = Environment.GetCommandLineArgs();
        var outputIndex = Array.IndexOf(args, "-buildOutput");
        if (outputIndex < 0 || outputIndex + 1 >= args.Length) throw new InvalidOperationException("Missing -buildOutput");
        Directory.CreateDirectory(Path.GetDirectoryName(args[outputIndex + 1]));
        var targetIndex = Array.IndexOf(args, "-buildTarget");
        if (targetIndex < 0 || targetIndex + 1 >= args.Length) throw new InvalidOperationException("Missing -buildTarget");
        var target = (BuildTarget)Enum.Parse(typeof(BuildTarget), args[targetIndex + 1]);
        var report = BuildPipeline.BuildPlayer(new BuildPlayerOptions
        {
            scenes = new[] { "Assets/Proof.unity" },
            locationPathName = args[outputIndex + 1],
            target = target,
            options = BuildOptions.Development
        });
        Debug.Log("CLI_PROOF_BUILD " + report.summary.result);
        EditorApplication.Exit(report.summary.result == BuildResult.Succeeded ? 0 : 1);
    }
}
