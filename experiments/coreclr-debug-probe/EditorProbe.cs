using System;
using System.IO;
using UnityEditor;
using UnityEditor.Build;
using UnityEditor.Compilation;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace UCTDebugProbe
{
	internal static class EditorProbe
	{
		public static void Run()
		{
			if (CompilationPipeline.codeOptimization != CodeOptimization.Debug)
				throw new InvalidOperationException("Editor fixture requires Debug code optimization.");
			ProbeTarget.Initialize("editor", CompilationPipeline.codeOptimization.ToString(), EditorApplication.Exit);
			EditorApplication.update += ProbeTarget.Tick;
		}

		public static void BuildPlayer()
		{
			var resultPath = Environment.GetEnvironmentVariable("UCT_DEBUG_BUILD_RESULT");
			try
			{
				PlayerSettings.SetScriptingBackend(NamedBuildTarget.Standalone, ScriptingImplementation.CoreCLR);
				PlayerSettings.SetApiCompatibilityLevel(NamedBuildTarget.Standalone, ApiCompatibilityLevel.NET_Standard);
				var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
				EditorSceneManager.SaveScene(scene, "Assets/Probe.unity");
				var report = BuildPipeline.BuildPlayer(new BuildPlayerOptions {
					scenes = new [] { "Assets/Probe.unity" }, target = BuildTarget.StandaloneWindows64,
					locationPathName = "Build/Probe.exe", options = BuildOptions.Development | BuildOptions.AllowDebugging
				});
				File.WriteAllText(resultPath, "{\"version\":" + ProbeTarget.Quote(Application.unityVersion)
					+ ",\"target\":\"StandaloneWindows64\",\"backend\":" + ProbeTarget.Quote(PlayerSettings.GetScriptingBackend(NamedBuildTarget.Standalone).ToString())
					+ ",\"api\":" + ProbeTarget.Quote(PlayerSettings.GetApiCompatibilityLevel(NamedBuildTarget.Standalone).ToString())
					+ ",\"options\":\"Development|AllowDebugging\",\"result\":" + ProbeTarget.Quote(report.summary.result.ToString())
					+ ",\"errors\":" + report.summary.totalErrors.ToString(System.Globalization.CultureInfo.InvariantCulture) + "}");
				EditorApplication.Exit(report.summary.result == UnityEditor.Build.Reporting.BuildResult.Succeeded ? 0 : 1);
			}
			catch (Exception error)
			{
				File.WriteAllText(resultPath, "{\"result\":\"Failed\",\"failure\":" + ProbeTarget.Quote(error.ToString()) + "}");
				EditorApplication.Exit(1);
			}
		}

	}
}
