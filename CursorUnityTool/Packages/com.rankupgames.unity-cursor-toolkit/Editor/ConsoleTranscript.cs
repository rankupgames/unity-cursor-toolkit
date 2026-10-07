/*
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 * Project: Unity Cursor Toolkit
 * Description: Compact whole-console transcript serialized beside profiler sessions.
 */

#if UNITY_EDITOR
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace UnityCursorToolkit
{
	internal sealed class ConsoleTranscript
	{
		internal string sessionId = "";
		internal string startedUtc = "";
		internal string capturedUtc = "";
		internal string transcriptPath = "";
		internal bool trimmed = false;
		internal List<ConsoleTranscriptEntry> entries = new List<ConsoleTranscriptEntry>();
		internal List<ConsoleLogGroup> groups = new List<ConsoleLogGroup>();

		internal int EntryCount => entries == null ? 0 : entries.Count;
		internal int GroupCount => groups == null ? 0 : groups.Count;
		internal int ErrorGroupCount
		{
			get
			{
				int count = 0;
				for (int i = 0; groups != null && i < groups.Count; i++)
				{
					if (groups[i].IsErrorLike)
					{
						count++;
					}
				}
				return count;
			}
		}

		internal string ToJson()
		{
			StringBuilder sb = new StringBuilder(8192);
			sb.Append("{");
			ProfilerSnapshotJson.Prop(sb, "sessionId", sessionId).Append(",");
			ProfilerSnapshotJson.Prop(sb, "startedUtc", startedUtc).Append(",");
			ProfilerSnapshotJson.Prop(sb, "capturedUtc", capturedUtc).Append(",");
			ProfilerSnapshotJson.Prop(sb, "transcriptPath", transcriptPath).Append(",");
			sb.Append("\"trimmed\":").Append(ProfilerSnapshotJson.Bool(trimmed)).Append(",");
			sb.Append("\"entryCount\":").Append(EntryCount.ToString(CultureInfo.InvariantCulture)).Append(",");
			sb.Append("\"groupCount\":").Append(GroupCount.ToString(CultureInfo.InvariantCulture)).Append(",");
			sb.Append("\"errorGroupCount\":").Append(ErrorGroupCount.ToString(CultureInfo.InvariantCulture)).Append(",");
			AppendEntries(sb);
			AppendGroups(sb);
			AppendErrorGroups(sb);
			sb.Append("}");
			return sb.ToString();
		}

		private void AppendEntries(StringBuilder sb)
		{
			sb.Append("\"entries\":[");
			for (int i = 0; i < entries.Count; i++)
			{
				if (i > 0) sb.Append(",");
				entries[i].AppendJson(sb);
			}
			sb.Append("]");
		}

		private void AppendGroups(StringBuilder sb)
		{
			sb.Append(",\"groups\":{");
			for (int i = 0; i < groups.Count; i++)
			{
				if (i > 0) sb.Append(",");
				ConsoleLogGroup group = groups[i];
				sb.Append("\"").Append(ProfilerSnapshotJson.Escape(group.key)).Append("\":");
				group.AppendJson(sb);
			}
			sb.Append("}");
		}

		private void AppendErrorGroups(StringBuilder sb)
		{
			sb.Append(",\"errorGroups\":{");
			bool first = true;
			for (int i = 0; i < groups.Count; i++)
			{
				ConsoleLogGroup group = groups[i];
				if (group.IsErrorLike == false)
				{
					continue;
				}

				if (first == false) sb.Append(",");
				first = false;
				sb.Append("\"").Append(ProfilerSnapshotJson.Escape(group.key)).Append("\":");
				group.AppendSummaryJson(sb);
			}
			sb.Append("}");
		}
	}
}

#endif
