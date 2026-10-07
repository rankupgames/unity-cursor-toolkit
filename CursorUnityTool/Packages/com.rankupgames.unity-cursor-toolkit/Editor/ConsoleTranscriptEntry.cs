/*
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 * Project: Unity Cursor Toolkit
 * Description: Compact chronological console transcript occurrence model.
 */

#if UNITY_EDITOR
using System.Globalization;
using System.Text;

namespace UnityCursorToolkit
{
	internal sealed class ConsoleTranscriptEntry
	{
		internal int index;
		internal string key = "";
		internal string type = "";
		internal string message = "";
		internal string stackTrace = "";
		internal string timestampUtc = "";
		internal double elapsedMs;
		internal string firstFrame = "";

		internal void AppendJson(StringBuilder sb)
		{
			sb.Append("{");
			sb.Append("\"index\":").Append(index.ToString(CultureInfo.InvariantCulture)).Append(",");
			ProfilerSnapshotJson.Prop(sb, "key", key).Append(",");
			ProfilerSnapshotJson.Prop(sb, "type", type).Append(",");
			ProfilerSnapshotJson.Prop(sb, "timestampUtc", timestampUtc).Append(",");
			sb.Append("\"elapsedMs\":").Append(ProfilerSnapshotJson.Number(elapsedMs));
			sb.Append("}");
		}
	}
}

#endif
