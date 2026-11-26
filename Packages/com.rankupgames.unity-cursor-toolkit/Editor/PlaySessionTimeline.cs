/*
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 * Description: Read-only master timeline and bounded same-session object comparisons.
 */
#if UNITY_EDITOR
using System;
using System.Collections.Generic;
using System.IO;
using System.Globalization;
using System.Text;
using UnityEngine;

namespace UnityCursorToolkit
{
	internal static class PlaySessionTimeline
	{
		internal static string Events(string root, long after, int limit, bool timeline, bool journalStopped)
		{
			string journalPath = PlaySessionStorage.EvidenceFile(root, "events.jsonl");
			if (after < 0 || limit < 1 || limit > 100) return PlaySessionMonitor.Failure("invalid_arguments", "Event cursor or limit is out of range.");
			var sb = new StringBuilder("{\"success\":true,\"version\":1,");
			if (timeline) sb.Append("\"projection\":\"master_timeline\",\"scope\":\"all_sessions\",");
			sb.Append("\"events\":[");
			long next = after;
			int returned = 0;
			bool hasMore = false;
			long previous = 0;
			if (File.Exists(journalPath))
			{
				if (new FileInfo(journalPath).Length > PlaySessionMonitor.MaximumJournalBytes)
					return PlaySessionMonitor.Failure("journal_limit", "The existing session journal exceeds the bounded read limit.");
				foreach (string line in File.ReadLines(journalPath))
				{
					if (line.Length == 0) continue;
					PlaySessionEvent item = JsonUtility.FromJson<PlaySessionEvent>(line);
					if (item == null || item.version != 1 || item.sequence <= previous || item.sequence > 9007199254740991L)
						return PlaySessionMonitor.Failure("journal_invalid", "Session journal contains an invalid event.");
					previous = item.sequence;
					if (item.sequence <= after) continue;
					if (returned == limit) { hasMore = true; break; }
					if (returned++ > 0) sb.Append(",");
					sb.Append(line);
					next = item.sequence;
				}
			}
			sb.Append("],\"nextSequence\":").Append(next.ToString(CultureInfo.InvariantCulture));
			sb.Append(",\"hasMore\":").Append(ProfilerSnapshotJson.Bool(hasMore));
			sb.Append(",\"journalStopped\":").Append(ProfilerSnapshotJson.Bool(journalStopped)).Append("}");
			return sb.ToString();
		}

		internal static string Compare(string root, string sessionId, string snapshotId, string otherSessionId, string otherSnapshotId, int offset, int limit)
		{
			byte[] firstBytes = PlaySessionStorage.Read(root, sessionId, snapshotId);
			byte[] secondBytes = PlaySessionStorage.Read(root, otherSessionId, otherSnapshotId);
			var first = JsonUtility.FromJson<PlaySessionSnapshot>(PlaySessionStorage.Json(firstBytes));
			var second = JsonUtility.FromJson<PlaySessionSnapshot>(PlaySessionStorage.Json(secondBytes));
			Validate(first, sessionId, snapshotId);
			Validate(second, otherSessionId, otherSnapshotId);
			long sharedSecondBytes, uniqueSecondBytes;
			PlaySessionStorage.CompareBytes(firstBytes, secondBytes, out sharedSecondBytes, out uniqueSecondBytes);
			bool sameSession = sessionId == otherSessionId;
			var rows = new List<Change>();
			int unchanged = 0;
			if (sameSession)
			{
				var before = new Dictionary<int, PlaySessionObject>();
				var after = new HashSet<int>();
				foreach (PlaySessionObject row in first.objects)
				{
					if (row == null || before.ContainsKey(row.instanceId)) throw new IOException("First snapshot has invalid or duplicate object rows.");
					before.Add(row.instanceId, row);
				}
				foreach (PlaySessionObject row in second.objects)
				{
					if (row == null || !after.Add(row.instanceId)) throw new IOException("Second snapshot has invalid or duplicate object rows.");
					PlaySessionObject previous;
					if (!before.TryGetValue(row.instanceId, out previous)) rows.Add(new Change { instanceId = row.instanceId, kind = "added" });
					else if (JsonUtility.ToJson(previous) == JsonUtility.ToJson(row)) unchanged++;
					else rows.Add(new Change { instanceId = row.instanceId, kind = "changed" });
				}
				foreach (PlaySessionObject row in first.objects)
					if (!after.Contains(row.instanceId)) rows.Add(new Change { instanceId = row.instanceId, kind = "not_in_second_capture" });
			}
			if (offset > rows.Count) return PlaySessionMonitor.Failure("offset_out_of_range", "Comparison offset exceeds the change count.");
			int count = Math.Min(limit, rows.Count - offset);
			var sb = new StringBuilder("{\"success\":true,\"version\":1,");
			ProfilerSnapshotJson.Prop(sb, "sessionId", sessionId).Append(",");
			ProfilerSnapshotJson.Prop(sb, "snapshotId", snapshotId).Append(",");
			ProfilerSnapshotJson.Prop(sb, "otherSessionId", otherSessionId).Append(",");
			ProfilerSnapshotJson.Prop(sb, "otherSnapshotId", otherSnapshotId).Append(",");
			ProfilerSnapshotJson.Prop(sb, "identityComparison", sameSession ? "captured_session_local_ids" : "cross_session_identity_not_assumed").Append(",");
			sb.Append("\"objectComparisonAvailable\":").Append(ProfilerSnapshotJson.Bool(sameSession)).Append(",");
			sb.Append("\"sameBytes\":").Append(ProfilerSnapshotJson.Bool(Equal(firstBytes, secondBytes)));
			sb.Append(",\"firstBytes\":").Append(firstBytes.Length).Append(",\"secondBytes\":").Append(secondBytes.Length);
			sb.Append(",\"secondBytesSharedWithFirst\":").Append(sharedSecondBytes).Append(",\"secondBytesNotInFirst\":").Append(uniqueSecondBytes);
			sb.Append(",\"firstTruncated\":").Append(ProfilerSnapshotJson.Bool(first.truncated)).Append(",\"secondTruncated\":").Append(ProfilerSnapshotJson.Bool(second.truncated));
			ProfilerSnapshotJson.Prop(sb.Append(","), "firstTruncationReason", first.truncationReason).Append(",");
			ProfilerSnapshotJson.Prop(sb, "secondTruncationReason", second.truncationReason);
			sb.Append(",\"unchangedObjectCount\":").Append(unchanged).Append(",\"capturedChangeCount\":").Append(rows.Count);
			sb.Append(",\"offset\":").Append(offset).Append(",\"nextOffset\":").Append(offset + count);
			sb.Append(",\"hasMore\":").Append(ProfilerSnapshotJson.Bool(offset + count < rows.Count)).Append(",\"changes\":[");
			for (int index = 0; index < count; index++)
			{
				if (index > 0) sb.Append(",");
				sb.Append(JsonUtility.ToJson(rows[offset + index]));
			}
			sb.Append("]}");
			return sb.ToString();
		}

		private static void Validate(PlaySessionSnapshot snapshot, string sessionId, string snapshotId)
		{
			if (snapshot == null || snapshot.version != 1 || snapshot.sessionId != sessionId || snapshot.id != snapshotId || snapshot.objects == null ||
				snapshot.objects.Count > PlaySessionSnapshotBuilder.MaximumObjects) throw new IOException("Compared snapshot identity or object bounds are invalid.");
		}
		private static bool Equal(byte[] first, byte[] second)
		{
			if (first.Length != second.Length) return false;
			for (int index = 0; index < first.Length; index++) if (first[index] != second[index]) return false;
			return true;
		}
		[Serializable] private sealed class Change { public int instanceId; public string kind; }
	}
}
#endif
