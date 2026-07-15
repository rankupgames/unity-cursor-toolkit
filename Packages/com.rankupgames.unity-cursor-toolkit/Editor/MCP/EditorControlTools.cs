// =============================================================================
// Author: Miguel A. Lopez
// Company: Rank Up Games LLC
// Project: Unity Cursor Toolkit
// Description: MCP tool handlers for editor lifecycle, play mode, menu, screenshot, and build.
// Created: 2026-03-12
// Last Modified: 2026-07-11
// =============================================================================

#if UNITY_EDITOR

using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using UnityEngine;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine.SceneManagement;
using UnityCursorToolkit.Core;
using Object = UnityEngine.Object;
#if UNITY_2021_2_OR_NEWER
using PrefabStageUtility = UnityEditor.SceneManagement.PrefabStageUtility;
#else
using PrefabStageUtility = UnityEditor.Experimental.SceneManagement.PrefabStageUtility;
#endif

namespace UnityCursorToolkit.MCP
{
	[MCPTool("play_mode")]
	internal sealed class PlayModeTool : IToolHandler
	{
		public string ToolName => "play_mode";
		public string Description => "Enter, exit, pause, or step play mode.";

		public string HandleCommand(string argsJson)
		{
			var args = EditorControlHelpers.ParseArgs(argsJson);
			var action = EditorControlHelpers.GetString(args, "action", "");

			switch (action)
			{
				case "enter":
					EditorApplication.isPlaying = true;
					return "{\"success\":true,\"isPlaying\":true}";
				case "exit":
					EditorApplication.isPlaying = false;
					return "{\"success\":true,\"isPlaying\":false}";
				case "pause":
					EditorApplication.isPaused = true;
					return "{\"success\":true,\"isPaused\":true}";
				case "step":
					EditorApplication.Step();
					return "{\"success\":true}";
				default:
					return EditorControlHelpers.JsonError($"Unknown action: {action}");
			}
		}
	}

	[MCPTool("editor_lifecycle")]
	internal sealed class EditorLifecycleTool : IToolHandler
	{
		/// <summary>
		/// Bounds dirty-path details returned through the editor bridge while preserving exact total counts.
		/// </summary>
		private const int MaxReportedDirtyPaths = 50;

		public string ToolName => "editor_lifecycle";
		public string Description => "Inspect editor save state, save all open scenes and assets, or save and quit safely.";

		public string HandleCommand(string argsJson)
		{
			var args = EditorControlHelpers.ParseArgs(argsJson);
			var action = EditorControlHelpers.GetString(args, "action", "status");

			switch (action)
			{
				case "status":
					return GetStatus();
				case "save":
					return SaveProject(false);
				case "saveAndQuit":
					return SaveProject(true);
				default:
					return EditorControlHelpers.JsonError($"Unknown action: {action}");
			}
		}

		/// <summary>
		/// Returns the editor state and every open scene that still has unsaved changes.
		/// </summary>
		private static string GetStatus()
		{
			bool hasUntitledDirtyScene;
			List<string> dirtyScenes = GetDirtySceneIdentifiers(out hasUntitledDirtyScene);
			List<string> dirtyAssets = GetDirtyAssetPaths();
			var prefabStage = PrefabStageUtility.GetCurrentPrefabStage();
			return "{\"success\":true,\"isPlaying\":" + ToJsonBool(EditorApplication.isPlayingOrWillChangePlaymode)
				+ ",\"isCompiling\":" + ToJsonBool(EditorApplication.isCompiling)
				+ ",\"isUpdating\":" + ToJsonBool(EditorApplication.isUpdating)
				+ ",\"dirtySceneCount\":" + dirtyScenes.Count
				+ ",\"hasUntitledDirtyScene\":" + ToJsonBool(hasUntitledDirtyScene)
				+ ",\"dirtyScenes\":" + ToJsonArray(dirtyScenes)
				+ ",\"dirtySceneListTrimmed\":" + ToJsonBool(dirtyScenes.Count > MaxReportedDirtyPaths)
				+ ",\"dirtyAssetCount\":" + dirtyAssets.Count
				+ ",\"dirtyAssets\":" + ToJsonArray(dirtyAssets)
				+ ",\"dirtyAssetListTrimmed\":" + ToJsonBool(dirtyAssets.Count > MaxReportedDirtyPaths)
				+ ",\"prefabStageOpen\":" + ToJsonBool(prefabStage != null)
				+ ",\"prefabStageDirty\":" + ToJsonBool(prefabStage != null && prefabStage.scene.isDirty)
				+ ",\"prefabAssetPath\":\"" + EditorControlHelpers.Escape(GetCurrentPrefabAssetPath()) + "\"}";
		}

		/// <summary>
		/// Reads the active Prefab Stage asset path across the package's supported Unity editor versions.
		/// </summary>
		private static string GetCurrentPrefabAssetPath()
		{
			var prefabStage = PrefabStageUtility.GetCurrentPrefabStage();
			if (prefabStage == null)
				return string.Empty;

			#if UNITY_2021_2_OR_NEWER
			return prefabStage.assetPath;
			#else
			return prefabStage.prefabAssetPath;
			#endif
		}

		/// <summary>
		/// Saves every open scene and project asset before optionally scheduling a normal editor exit.
		/// </summary>
		private static string SaveProject(bool shouldQuit)
		{
			int savedSceneCount;
			int savedAssetCount;
			string error;
			if (TrySaveProject(out savedSceneCount, out savedAssetCount, out error) == false)
				return EditorControlHelpers.JsonError(error);

			if (shouldQuit)
				EditorApplication.delayCall += QuitEditor;

			return "{\"success\":true,\"savedSceneCount\":" + savedSceneCount
				+ ",\"savedAssetCount\":" + savedAssetCount
				+ ",\"quitScheduled\":" + ToJsonBool(shouldQuit) + "}";
		}

		/// <summary>
		/// Exits through Unity's normal editor lifecycle after the save result has been returned to the caller.
		/// </summary>
		private static void QuitEditor()
		{
			EditorApplication.delayCall -= QuitEditor;
			string error;
			if (TrySaveProject(out _, out _, out error) == false)
			{
				Debug.LogWarning("Safe editor shutdown was cancelled: " + error);
				return;
			}
			EditorApplication.Exit(0);
		}

		/// <summary>
		/// Saves and verifies all tracked dirty scenes and persistent assets without ever forcing an editor exit.
		/// </summary>
		private static bool TrySaveProject(out int savedSceneCount, out int savedAssetCount, out string error)
		{
			savedSceneCount = 0;
			savedAssetCount = 0;
			error = string.Empty;

			if (EditorApplication.isPlayingOrWillChangePlaymode)
			{
				error = "Exit Play Mode before saving or closing the Unity Editor.";
				return false;
			}
			if (EditorApplication.isCompiling)
			{
				error = "Wait for script compilation to finish before saving or closing the Unity Editor.";
				return false;
			}
			if (EditorApplication.isUpdating)
			{
				error = "Wait for the Asset Database or Package Manager update to finish before saving or closing the Unity Editor.";
				return false;
			}
			if (PrefabStageUtility.GetCurrentPrefabStage() != null)
			{
				error = "Close Prefab Mode through Unity before automated editor shutdown so prefab edits can be reviewed and saved normally.";
				return false;
			}

			bool hasUntitledDirtyScene;
			List<string> dirtyScenes = GetDirtySceneIdentifiers(out hasUntitledDirtyScene);
			if (hasUntitledDirtyScene)
			{
				error = "An untitled scene has unsaved work. Save it to an explicit path before automated editor shutdown.";
				return false;
			}

			if (dirtyScenes.Count > 0 && EditorSceneManager.SaveOpenScenes() == false)
			{
				error = "Unity could not save every open scene. The editor will remain open.";
				return false;
			}
			savedSceneCount = dirtyScenes.Count;

			List<string> dirtyAssets = GetDirtyAssetPaths();
			AssetDatabase.SaveAssets();
			savedAssetCount = dirtyAssets.Count;

			bool hasRemainingUntitledScene;
			List<string> remainingDirtyScenes = GetDirtySceneIdentifiers(out hasRemainingUntitledScene);
			if (remainingDirtyScenes.Count > 0 || hasRemainingUntitledScene)
			{
				error = "Unity still reports unsaved scene changes after the save attempt. The editor will remain open.";
				return false;
			}

			List<string> remainingDirtyAssets = GetDirtyAssetPaths();
			if (remainingDirtyAssets.Count > 0)
			{
				error = "Unity still reports " + remainingDirtyAssets.Count + " unsaved persistent asset(s) after the save attempt: " + string.Join(", ", remainingDirtyAssets.GetRange(0, Math.Min(remainingDirtyAssets.Count, MaxReportedDirtyPaths)));
				return false;
			}

			return true;
		}

		/// <summary>
		/// Collects dirty scene identifiers and reports whether any dirty scene lacks a persistent asset path.
		/// </summary>
		private static List<string> GetDirtySceneIdentifiers(out bool hasUntitledDirtyScene)
		{
			var dirtyScenes = new List<string>();
			hasUntitledDirtyScene = false;
			for (int i = 0; i < SceneManager.sceneCount; i++)
			{
				Scene scene = SceneManager.GetSceneAt(i);
				if (scene.isDirty == false)
					continue;

				if (string.IsNullOrEmpty(scene.path))
				{
					hasUntitledDirtyScene = true;
					dirtyScenes.Add(scene.name);
					continue;
				}

				dirtyScenes.Add(scene.path);
			}

			return dirtyScenes;
		}

		/// <summary>
		/// Finds loaded persistent project assets whose dirty flags remain set.
		/// </summary>
		private static List<string> GetDirtyAssetPaths()
		{
			var paths = new HashSet<string>(StringComparer.Ordinal);
			Object[] loadedObjects = Resources.FindObjectsOfTypeAll<Object>();
			foreach (Object loadedObject in loadedObjects)
			{
				if (loadedObject == null || EditorUtility.IsPersistent(loadedObject) == false || EditorUtility.IsDirty(loadedObject) == false)
					continue;

				string path = AssetDatabase.GetAssetPath(loadedObject);
				if (IsWritableProjectAssetPath(path))
					paths.Add(path);
			}

			var sortedPaths = new List<string>(paths);
			sortedPaths.Sort(StringComparer.Ordinal);
			return sortedPaths;
		}

		/// <summary>
		/// Excludes Unity's built-in Library and Resources objects from project-asset save verification.
		/// </summary>
		private static bool IsWritableProjectAssetPath(string path)
		{
			return string.IsNullOrEmpty(path) == false
				&& (path.StartsWith("Assets/", StringComparison.Ordinal)
					|| path.StartsWith("Packages/", StringComparison.Ordinal)
					|| path.StartsWith("ProjectSettings/", StringComparison.Ordinal));
		}

		/// <summary>
		/// Serializes scene identifiers without introducing a dependency on an external JSON package.
		/// </summary>
		private static string ToJsonArray(List<string> values)
		{
			var builder = new StringBuilder("[");
			int reportedCount = Math.Min(values.Count, MaxReportedDirtyPaths);
			for (int i = 0; i < reportedCount; i++)
			{
				if (i > 0)
					builder.Append(',');
				builder.Append('"').Append(EditorControlHelpers.Escape(values[i])).Append('"');
			}
			return builder.Append(']').ToString();
		}

		/// <summary>
		/// Formats a boolean for direct use in a JSON response.
		/// </summary>
		private static string ToJsonBool(bool value) => value ? "true" : "false";
	}

	[MCPTool("execute_menu_item")]
	internal sealed class ExecuteMenuItemTool : IToolHandler
	{
		public string ToolName => "execute_menu_item";
		public string Description => "Executes a Unity menu item by path.";

		public string HandleCommand(string argsJson)
		{
			var args = EditorControlHelpers.ParseArgs(argsJson);
			var menuPath = EditorControlHelpers.GetString(args, "menuPath", "");
			if (string.IsNullOrEmpty(menuPath))
				return EditorControlHelpers.JsonError("menuPath is required");
			if (EditorApplication.ExecuteMenuItem(menuPath) == false)
				return EditorControlHelpers.JsonError("Menu item execution failed or not found");
			return "{\"success\":true}";
		}
	}

	[MCPTool("screenshot")]
	internal sealed class ScreenshotTool : IToolHandler
	{
		public string ToolName => "screenshot";
		public string Description => "Captures the game view to a temp file.";

		public string HandleCommand(string argsJson)
		{
			var path = Path.Combine(Application.temporaryCachePath, "mcp_screenshot_" + DateTime.UtcNow.Ticks + ".png");
			var cam = Camera.main;
			if (cam == null)
				return EditorControlHelpers.JsonError("No main camera found");
			var rt = new RenderTexture(Screen.width, Screen.height, 24);
			cam.targetTexture = rt;
			var tex = new Texture2D(Screen.width, Screen.height, TextureFormat.RGB24, false);
			cam.Render();
			RenderTexture.active = rt;
			tex.ReadPixels(new Rect(0, 0, Screen.width, Screen.height), 0, 0);
			tex.Apply();
			cam.targetTexture = null;
			RenderTexture.active = null;
			UnityEngine.Object.DestroyImmediate(rt);
			byte[] bytes = tex.EncodeToPNG();
			UnityEngine.Object.DestroyImmediate(tex);
			File.WriteAllBytes(path, bytes);
			return "{\"success\":true,\"path\":\"" + EditorControlHelpers.Escape(path) + "\"}";
		}
	}

	[MCPTool("build_trigger")]
	internal sealed class BuildTriggerTool : IToolHandler
	{
		public string ToolName => "build_trigger";
		public string Description => "Triggers a player build with basic settings.";

		public string HandleCommand(string argsJson)
		{
			var args = EditorControlHelpers.ParseArgs(argsJson);
			var path = EditorControlHelpers.GetString(args, "path", EditorControlHelpers.GetString(args, "buildPath", "Build/Build"));
			var targetValue = EditorControlHelpers.GetInt(args, "buildTarget", 0);
			var target = targetValue == 0 ? EditorUserBuildSettings.activeBuildTarget : (BuildTarget)targetValue;
			var opts = BuildOptions.None;
			if (EditorControlHelpers.GetBool(args, "development", false))
				opts |= BuildOptions.Development;
			var sceneList = new List<string>();
			foreach (var s in EditorBuildSettings.scenes)
			{
				if (s.enabled)
					sceneList.Add(s.path);
			}
			if (sceneList.Count == 0)
				sceneList.Add(UnityEngine.SceneManagement.SceneManager.GetActiveScene().path);
			var report = BuildPipeline.BuildPlayer(sceneList.ToArray(), path, target, opts);
			if (report.summary.result != UnityEditor.Build.Reporting.BuildResult.Succeeded)
				return EditorControlHelpers.JsonError("Build failed: " + report.summary.result);
			return "{\"success\":true,\"path\":\"" + EditorControlHelpers.Escape(path) + "\"}";
		}
	}

	internal static class EditorControlHelpers
	{
		[Serializable]
		private class ArgsWrapper
		{
			public string action;
			public string menuPath;
			public string path;
			public string buildPath;
			public int buildTarget;
			public bool development;
		}

		internal static Dictionary<string, object> ParseArgs(string json)
		{
			var d = new Dictionary<string, object>();
			if (string.IsNullOrEmpty(json))
				return d;
			try
			{
				var w = JsonUtility.FromJson<ArgsWrapper>(json);
				if (w != null)
				{
					if (w.action != null) d["action"] = w.action;
					if (w.menuPath != null) d["menuPath"] = w.menuPath;
					if (w.path != null) d["path"] = w.path;
					if (w.buildPath != null)
					{
						d["buildPath"] = w.buildPath;
						if (d.ContainsKey("path") == false) d["path"] = w.buildPath;
					}
					d["buildTarget"] = w.buildTarget;
					d["development"] = w.development;
				}
			}
			catch (System.Exception ex) { UnityEngine.Debug.LogWarning($"(EditorControlTools - ParseArgs) JSON parse failed: {ex.Message}"); }
			return d;
		}

		internal static string GetString(Dictionary<string, object> d, string key, string def)
		{
			if (d.TryGetValue(key, out var v) == false || v == null)
				return def;
			return v.ToString();
		}

		internal static int GetInt(Dictionary<string, object> d, string key, int def)
		{
			if (d.TryGetValue(key, out var v) == false)
				return def;
			if (v is int vi) return vi;
			if (v is long l) return (int)l;
			if (v is float f) return (int)f;
			int.TryParse(v.ToString(), out var parsed);
			return parsed;
		}

		internal static bool GetBool(Dictionary<string, object> d, string key, bool def)
		{
			if (d.TryGetValue(key, out var v) == false)
				return def;
			if (v is bool b) return b;
			return def;
		}

		internal static string JsonError(string msg) => "{\"success\":false,\"error\":\"" + Escape(msg) + "\"}";
		internal static string Escape(string s)
		{
			if (s == null) return string.Empty;
			return s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\n", "\\n").Replace("\r", "\\r");
		}
	}
}

#endif
