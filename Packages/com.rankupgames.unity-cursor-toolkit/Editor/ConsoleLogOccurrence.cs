/*
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 * Project: Unity Cursor Toolkit
 * Description: Timestamped console occurrence for compact grouped transcripts.
 */

#if UNITY_EDITOR
using System.Globalization;
using System.Text;

namespace UnityCursorToolkit
{
	internal sealed class ConsoleLogOccurrence
	{
		internal int index;
		internal string timestampUtc = "";
		internal double elapsedMs;

		internal void AppendJson(StringBuilder sb)
		{
			sb.Append("{");
			sb.Append("\"index\":").Append(index.ToString(CultureInfo.InvariantCulture)).Append(",");
			ProfilerSnapshotJson.Prop(sb, "timestampUtc", timestampUtc).Append(",");
			sb.Append("\"elapsedMs\":").Append(ProfilerSnapshotJson.Number(elapsedMs)).Append("}");
		}
	}
}

#endif
