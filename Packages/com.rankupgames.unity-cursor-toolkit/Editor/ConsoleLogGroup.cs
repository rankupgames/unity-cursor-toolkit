/*
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 * Project: Unity Cursor Toolkit
 * Description: Deduplicated console log body with every timestamped occurrence.
 */

#if UNITY_EDITOR
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace UnityCursorToolkit
{
	internal sealed class ConsoleLogGroup
	{
		internal string key = "";
		internal string type = "";
		internal string message = "";
		internal string firstFrame = "";
		internal string stackTrace = "";
		internal int count;
		internal int firstIndex;
		internal int lastIndex;
		internal string firstTimestampUtc = "";
		internal string lastTimestampUtc = "";
		internal List<ConsoleLogOccurrence> timeline = new List<ConsoleLogOccurrence>();

		internal bool IsErrorLike => type == "error" || type == "exception" || type == "assert";

		internal void AppendJson(StringBuilder sb)
		{
			sb.Append("{");
			ProfilerSnapshotJson.Prop(sb, "key", key).Append(",");
			ProfilerSnapshotJson.Prop(sb, "type", type).Append(",");
			ProfilerSnapshotJson.Prop(sb, "message", message).Append(",");
			ProfilerSnapshotJson.Prop(sb, "firstFrame", firstFrame).Append(",");
			ProfilerSnapshotJson.Prop(sb, "stackTrace", stackTrace).Append(",");
			AppendSummaryFields(sb);
			sb.Append(",");
			AppendTimeline(sb);
			sb.Append("}");
		}

		internal void AppendSummaryJson(StringBuilder sb)
		{
			sb.Append("{");
			AppendSummaryFields(sb);
			sb.Append("}");
		}

		private void AppendSummaryFields(StringBuilder sb)
		{
			sb.Append("\"count\":").Append(count.ToString(CultureInfo.InvariantCulture)).Append(",");
			sb.Append("\"firstIndex\":").Append(firstIndex.ToString(CultureInfo.InvariantCulture)).Append(",");
			sb.Append("\"lastIndex\":").Append(lastIndex.ToString(CultureInfo.InvariantCulture)).Append(",");
			ProfilerSnapshotJson.Prop(sb, "firstTimestampUtc", firstTimestampUtc).Append(",");
			ProfilerSnapshotJson.Prop(sb, "lastTimestampUtc", lastTimestampUtc);
		}

		private void AppendTimeline(StringBuilder sb)
		{
			sb.Append("\"timeline\":[");
			for (int i = 0; i < timeline.Count; i++)
			{
				if (i > 0) sb.Append(",");
				timeline[i].AppendJson(sb);
			}
			sb.Append("]");
		}
	}
}

#endif
