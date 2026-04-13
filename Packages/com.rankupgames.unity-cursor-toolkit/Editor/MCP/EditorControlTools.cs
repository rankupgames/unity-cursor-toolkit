// =============================================================================
// Author: Miguel A. Lopez
// Company: Rank Up Games LLC
// Project: Unity Cursor Toolkit
// Description: MCP tool handlers for play mode, menu, screenshot, and build.
// Created: 2026-03-12
// Last Modified: 2026-03-12
// =============================================================================

#if UNITY_EDITOR

using System;
using System.Collections.Generic;
using System.IO;
using UnityEngine;
using UnityEditor;
using UnityCursorToolkit.Core;

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
			var path = EditorControlHelpers.GetString(args, "path", "Build/Build");
			var target = (BuildTarget)EditorControlHelpers.GetInt(args, "buildTarget", (int)BuildTarget.StandaloneWindows64);
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
