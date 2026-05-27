/*
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 * Project: Unity Cursor Toolkit
 * Description: MCP tool adapter for profiler snapshot sessions.
 */

#if UNITY_EDITOR
using System;
using System.Text;

using UnityEditor;

using UnityCursorToolkit.Core;

namespace UnityCursorToolkit.MCP
{
	[MCPTool("profiler_snapshot")]
	internal sealed class ProfilerSnapshotTool : IToolHandler
	{
		public string ToolName => "profiler_snapshot";
		public string Description => "Capture, list, read, save, or clear Unity Cursor Toolkit profiler sessions and console transcript artifacts.";

		public string HandleCommand(string argsJson)
		{
			if (TryParseArgs(argsJson, out ProfilerSnapshotArgs args, out string error) == false)
			{
				return ProfilerSnapshotJson.Error(error);
			}

			switch (args.action)
			{
				case "current":
					return Current(args);
				case "listSessions":
					return ProfilerSessionRecorder.ListSessionsJson(args.includeSaved);
				case "readSession":
					return ProfilerSessionRecorder.ReadSessionJson(args.SessionId);
				case "readConsoleTranscript":
					return ProfilerSessionRecorder.ReadConsoleTranscriptJson(args.SessionId);
				case "saveSession":
					return ProfilerSessionRecorder.SaveSessionJson(args.SessionId);
				case "clearSessions":
					return ProfilerSessionRecorder.ClearSessionsJson(args.includeSaved);
				case "discoverCounters":
					return ProfilerSessionRecorder.DiscoverCountersJson(args.limit);
				default:
					return ProfilerSnapshotJson.Error("Unknown action: " + args.action);
			}
		}

		private static string Current(ProfilerSnapshotArgs args)
		{
			ProfilerSnapshotSession session = ProfilerSessionRecorder.CaptureCurrentSession(args.includeRaw, args.includeConsole);

			if (string.Equals(args.format, "markdown", StringComparison.OrdinalIgnoreCase))
			{
				string markdown = ProfilerSnapshotFormatter.FormatClipboard(session);
				return "{\"success\":true,\"format\":\"markdown\",\"content\":\"" + ProfilerSnapshotJson.Escape(markdown) + "\"}";
			}

			var sb = new StringBuilder();
			sb.Append("{\"success\":true,\"session\":").Append(session.ToJson(args.includeRaw));
			if (args.includeConsole)
			{
				sb.Append(",\"console\":\"").Append(ProfilerSnapshotJson.Escape(ProfilerSnapshotFormatter.FormatConsoleSummary(session))).Append("\"");
			}
			sb.Append("}");
			return sb.ToString();
		}

		private static bool TryParseArgs(string argsJson, out ProfilerSnapshotArgs args, out string error)
		{
			args = ProfilerSnapshotArgs.CreateDefaults();
			error = null;
			if (string.IsNullOrEmpty(argsJson))
			{
				return true;
			}

			try
			{
				EditorJsonUtility.FromJsonOverwrite(argsJson, args);
				args.ApplyAliases();
				return true;
			}
			catch (Exception ex)
			{
				error = "Invalid profiler_snapshot arguments: " + ex.Message;
				return false;
			}
		}
	}

	[Serializable]
	internal sealed class ProfilerSnapshotArgs
	{
		public string action;
		public string sessionId = "";
		public string id = "";
		public bool includeConsole;
		public bool includeRaw;
		public bool includeSaved;
		public string format;
		public int limit;

		internal string SessionId => string.IsNullOrEmpty(sessionId) ? id : sessionId;

		internal static ProfilerSnapshotArgs CreateDefaults()
		{
			return new ProfilerSnapshotArgs
			{
				action = "current",
				includeConsole = true,
				includeRaw = ProfilerSnapshotSettings.Current.IncludeRawFrameArrays,
				includeSaved = false,
				format = "json",
				limit = 200
			};
		}

		internal void ApplyAliases()
		{
			if (string.IsNullOrEmpty(action))
			{
				action = "current";
			}
			if (string.IsNullOrEmpty(format))
			{
				format = "json";
			}
			if (limit <= 0)
			{
				limit = 200;
			}
		}
	}
}

#endif
