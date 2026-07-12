/*
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 * Project: Unity Cursor Toolkit
 * Description: Records Unity console events for compact session-scoped transcripts.
 */

#if UNITY_EDITOR
using System;
using System.Collections.Generic;
using System.Globalization;

using UnityEngine;

namespace UnityCursorToolkit
{
	internal static class ConsoleTranscriptRecorder
	{
		private const int MaxEntryCount = 1000;
		private const int MaxMessageLength = 2048;
		private const int MaxStackTraceLength = 4096;

		private static readonly Queue<ConsoleTranscriptEntry> entries = new Queue<ConsoleTranscriptEntry>();
		private static readonly object syncRoot = new object();

		private static DateTime sessionStartedAtUtc = DateTime.UtcNow;
		private static int entryCounter;
		private static bool trimmed;

		internal static void Reset(DateTime startedAtUtc)
		{
			lock (syncRoot)
			{
				sessionStartedAtUtc = startedAtUtc;
				entries.Clear();
				entryCounter = 0;
				trimmed = false;
			}
		}

		internal static void Record(string message, string stackTrace, LogType type)
		{
			lock (syncRoot)
			{
				DateTime nowUtc = DateTime.UtcNow;
				string entryType = ToConsoleType(type);
				bool messageTrimmed;
				bool stackTraceTrimmed;
				string entryMessage = LimitLength(message, MaxMessageLength, out messageTrimmed).Trim();
				string entryStackTrace = LimitLength(stackTrace, MaxStackTraceLength, out stackTraceTrimmed);
				string entryFirstFrame = ExtractFirstFrame(entryStackTrace);
				ConsoleTranscriptEntry entry = new ConsoleTranscriptEntry
				{
					index = entryCounter++,
					key = CreateGroupKey(entryType, entryMessage, entryFirstFrame),
					type = entryType,
					message = entryMessage,
					stackTrace = entryStackTrace,
					timestampUtc = FormatUtc(nowUtc),
					elapsedMs = Math.Max(0d, (nowUtc - sessionStartedAtUtc).TotalMilliseconds),
					firstFrame = entryFirstFrame
				};

				entries.Enqueue(entry);
				if (messageTrimmed || stackTraceTrimmed)
				{
					trimmed = true;
				}
				while (entries.Count > MaxEntryCount)
				{
					entries.Dequeue();
					trimmed = true;
				}
			}
		}

		internal static ConsoleTranscript Capture(string sessionId, string startedUtc, string capturedUtc, string transcriptPath)
		{
			List<ConsoleTranscriptEntry> snapshotEntries;
			bool snapshotTrimmed;
			lock (syncRoot)
			{
				snapshotEntries = new List<ConsoleTranscriptEntry>(entries);
				snapshotTrimmed = trimmed;
			}

			return new ConsoleTranscript
			{
				sessionId = sessionId,
				startedUtc = startedUtc,
				capturedUtc = capturedUtc,
				transcriptPath = transcriptPath,
				trimmed = snapshotTrimmed,
				entries = snapshotEntries,
				groups = BuildLogGroups(snapshotEntries)
			};
		}

		private static string LimitLength(string value, int limit, out bool wasTrimmed)
		{
			string normalized = value ?? string.Empty;
			wasTrimmed = normalized.Length > limit;
			return wasTrimmed ? normalized.Substring(0, limit) : normalized;
		}

		private static List<ConsoleLogGroup> BuildLogGroups(List<ConsoleTranscriptEntry> snapshotEntries)
		{
			Dictionary<string, ConsoleLogGroup> groupsByKey = new Dictionary<string, ConsoleLogGroup>(StringComparer.Ordinal);
			for (int i = 0; i < snapshotEntries.Count; i++)
			{
				ConsoleTranscriptEntry entry = snapshotEntries[i];
				ConsoleLogGroup group;
				if (groupsByKey.TryGetValue(entry.key, out group) == false)
				{
					group = new ConsoleLogGroup
					{
						key = entry.key,
						type = entry.type,
						message = entry.message,
						firstFrame = entry.firstFrame,
						stackTrace = entry.stackTrace,
						firstIndex = entry.index,
						firstTimestampUtc = entry.timestampUtc
					};
					groupsByKey[entry.key] = group;
				}

				group.count++;
				group.lastIndex = entry.index;
				group.lastTimestampUtc = entry.timestampUtc;
				group.timeline.Add(new ConsoleLogOccurrence
				{
					index = entry.index,
					timestampUtc = entry.timestampUtc,
					elapsedMs = entry.elapsedMs
				});
			}

			List<ConsoleLogGroup> groups = new List<ConsoleLogGroup>(groupsByKey.Values);
			groups.Sort(CompareLogGroups);
			return groups;
		}

		private static int CompareLogGroups(ConsoleLogGroup left, ConsoleLogGroup right)
		{
			return left.firstIndex.CompareTo(right.firstIndex);
		}

		private static string ToConsoleType(LogType type)
		{
			switch (type)
			{
				case LogType.Error:
					return "error";
				case LogType.Exception:
					return "exception";
				case LogType.Warning:
					return "warning";
				case LogType.Assert:
					return "assert";
				default:
					return "log";
			}
		}

		private static string ExtractFirstFrame(string stackTrace)
		{
			if (string.IsNullOrEmpty(stackTrace))
			{
				return string.Empty;
			}

			string[] lines = stackTrace.Replace("\r\n", "\n").Replace('\r', '\n').Split('\n');
			string fallback = string.Empty;
			for (int i = 0; i < lines.Length; i++)
			{
				string line = lines[i].Trim();
				if (line.Length == 0)
				{
					continue;
				}

				if (fallback.Length == 0)
				{
					fallback = line;
				}

				if (line.IndexOf("Assets/", StringComparison.OrdinalIgnoreCase) >= 0)
				{
					return line;
				}
			}

			return fallback;
		}

		private static string CreateGroupKey(string type, string message, string firstFrame)
		{
			unchecked
			{
				uint hash = 2166136261u;
				AddHash(ref hash, type);
				AddHash(ref hash, "\n");
				AddHash(ref hash, message);
				AddHash(ref hash, "\n");
				AddHash(ref hash, firstFrame);
				return hash.ToString("x8", CultureInfo.InvariantCulture);
			}
		}

		private static void AddHash(ref uint hash, string value)
		{
			if (string.IsNullOrEmpty(value))
			{
				return;
			}

			for (int i = 0; i < value.Length; i++)
			{
				hash ^= value[i];
				hash *= 16777619u;
			}
		}

		private static string FormatUtc(DateTime value)
		{
			return value.ToString("O", CultureInfo.InvariantCulture);
		}
	}
}

#endif
