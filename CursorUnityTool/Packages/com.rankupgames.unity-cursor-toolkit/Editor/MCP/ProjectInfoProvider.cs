// =============================================================================
// Author: Miguel A. Lopez
// Company: Rank Up Games LLC
// Project: Unity Cursor Toolkit
// Description: MCP tool handler for project information.
// Created: 2026-03-12
// Last Modified: 2026-03-12
// =============================================================================

#if UNITY_EDITOR

using System.Text;
using UnityEngine;
using UnityEditor;
using UnityCursorToolkit.Core;

namespace UnityCursorToolkit.MCP
{
	[MCPTool("project_info")]
	internal sealed class ProjectInfoTool : IToolHandler
	{
		public string ToolName => "project_info";
		public string Description => "Returns Unity project information.";

		public string HandleCommand(string argsJson)
		{
			var sb = new StringBuilder();
			sb.Append("{");
			sb.Append("\"unityVersion\":\"").Append(Escape(Application.unityVersion)).Append("\",");
			sb.Append("\"activeScene\":\"").Append(Escape(UnityEngine.SceneManagement.SceneManager.GetActiveScene().path)).Append("\",");
			sb.Append("\"buildTarget\":\"").Append(Escape(EditorUserBuildSettings.activeBuildTarget.ToString())).Append("\",");
			sb.Append("\"platform\":\"").Append(Escape(Application.platform.ToString())).Append("\",");
			sb.Append("\"isPlaying\":").Append(Application.isPlaying ? "true" : "false").Append(",");
			sb.Append("\"isPaused\":").Append(EditorApplication.isPaused ? "true" : "false").Append(",");
			sb.Append("\"projectPath\":\"").Append(Escape(Application.dataPath.Replace("/Assets", ""))).Append("\"");
			sb.Append("}");
			return sb.ToString();
		}

		private static string Escape(string s)
		{
			if (s == null) return string.Empty;
			return s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\n", "\\n").Replace("\r", "\\r");
		}
	}
}

#endif
