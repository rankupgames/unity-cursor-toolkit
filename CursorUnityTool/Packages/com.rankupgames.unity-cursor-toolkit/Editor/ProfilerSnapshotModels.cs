/*
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 * Project: Unity Cursor Toolkit
 * Description: Profiler snapshot data models, JSON emission, and clipboard formatting.
 */

#if UNITY_EDITOR
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

using UnityEngine;

#if UNITY_2020_2_OR_NEWER
using Unity.Profiling;
using Unity.Profiling.LowLevel.Unsafe;
#endif

namespace UnityCursorToolkit
{
	internal sealed class RecorderSlot : IDisposable
	{
#if UNITY_2020_2_OR_NEWER
		private readonly string categoryName;
		private readonly string name;
		private readonly string error;
		private readonly bool timingNanoseconds;
		private string unit;
		private ProfilerRecorder recorder;

		internal RecorderSlot(ProfilerCategory category, string name, int capacity, bool timingNanoseconds, ProfilerRecorderOptions extraOptions)
		{
			this.timingNanoseconds = timingNanoseconds;
			categoryName = category.ToString();
			this.name = name;
			unit = "Unavailable";

			try
			{
				ProfilerRecorderOptions options = ProfilerRecorderOptions.WrapAroundWhenCapacityReached | ProfilerRecorderOptions.StartImmediately | extraOptions;
				recorder = new ProfilerRecorder(category, name, capacity, options);
				if (recorder.Valid)
				{
					unit = recorder.UnitType.ToString();
				}
			}
			catch (Exception ex)
			{
				error = ex.Message;
			}
		}

		internal MetricSnapshot Capture(bool includeRaw)
		{
			var metric = new MetricSnapshot
			{
				category = categoryName,
				name = name,
				unit = unit,
				valid = recorder.Valid,
				error = error,
				timingNanoseconds = timingNanoseconds,
				values = new List<double>()
			};

			if (recorder.Valid == false)
			{
				return metric;
			}

			int count = Math.Min(recorder.Count, recorder.Capacity);
			metric.count = count;
			metric.last = recorder.LastValue;
			if (count == 0)
			{
				return metric;
			}

			double min = double.MaxValue;
			double max = double.MinValue;
			double sum = 0d;
			for (int i = 0; i < count; i++)
			{
				double value = recorder.GetSample(i).Value;
				min = Math.Min(min, value);
				max = Math.Max(max, value);
				sum += value;
				if (includeRaw)
				{
					metric.values.Add(value);
				}
			}

			metric.min = min;
			metric.max = max;
			metric.avg = sum / count;
			return metric;
		}

		internal void Reset()
		{
			if (recorder.Valid)
			{
				recorder.Reset();
				recorder.Start();
			}
		}

		public void Dispose()
		{
			if (recorder.Valid)
			{
				recorder.Dispose();
			}
		}
#else
		internal MetricSnapshot Capture(bool includeRaw)
		{
			return new MetricSnapshot
			{
				name = "ProfilerRecorder",
				category = "Unavailable",
				unit = "Unavailable",
				valid = false,
				error = "ProfilerRecorder requires Unity 2020.2 or newer.",
				values = new List<double>()
			};
		}

		internal void Reset() {}
		public void Dispose() {}
#endif
	}

	internal sealed class ProfilerSnapshotSession
	{
		internal string id;
		internal string mode;
		internal string startedUtc;
		internal string capturedUtc;
		internal string unityVersion;
		internal string activeScene;
		internal bool isPlaying;
		internal bool isPaused;
		internal bool isCompiling;
		internal int frameBufferLength;
		internal bool hierarchyEnabled;
		internal bool deepProfiling;
		internal bool frameTimingStatsEnabled;
		internal string bottleneck;
		internal string sessionPath;
		internal List<MetricSnapshot> metrics = new List<MetricSnapshot>();
		internal List<FrameTimingSnapshot> frameTimings = new List<FrameTimingSnapshot>();
		internal List<ProfilerHotFrame> hotFrames = new List<ProfilerHotFrame>();
		internal List<ProfilerHotPath> hotPaths = new List<ProfilerHotPath>();
		internal List<string> warnings = new List<string>();

		internal string ToJson(bool includeRaw)
		{
			var sb = new StringBuilder(4096);
			sb.Append("{");
			ProfilerSnapshotJson.Prop(sb, "id", id).Append(",");
			ProfilerSnapshotJson.Prop(sb, "mode", mode).Append(",");
			ProfilerSnapshotJson.Prop(sb, "startedUtc", startedUtc).Append(",");
			ProfilerSnapshotJson.Prop(sb, "capturedUtc", capturedUtc).Append(",");
			ProfilerSnapshotJson.Prop(sb, "unityVersion", unityVersion).Append(",");
			ProfilerSnapshotJson.Prop(sb, "activeScene", activeScene).Append(",");
			ProfilerSnapshotJson.Prop(sb, "bottleneck", bottleneck).Append(",");
			ProfilerSnapshotJson.Prop(sb, "sessionPath", sessionPath).Append(",");
			sb.Append("\"isPlaying\":").Append(ProfilerSnapshotJson.Bool(isPlaying)).Append(",");
			sb.Append("\"isPaused\":").Append(ProfilerSnapshotJson.Bool(isPaused)).Append(",");
			sb.Append("\"isCompiling\":").Append(ProfilerSnapshotJson.Bool(isCompiling)).Append(",");
			sb.Append("\"frameBufferLength\":").Append(frameBufferLength.ToString(CultureInfo.InvariantCulture)).Append(",");
			sb.Append("\"hierarchyEnabled\":").Append(ProfilerSnapshotJson.Bool(hierarchyEnabled)).Append(",");
			sb.Append("\"deepProfiling\":").Append(ProfilerSnapshotJson.Bool(deepProfiling)).Append(",");
			sb.Append("\"frameTimingStatsEnabled\":").Append(ProfilerSnapshotJson.Bool(frameTimingStatsEnabled)).Append(",");
			AppendMetrics(sb, includeRaw);
			AppendFrameTimings(sb, includeRaw);
			AppendHotFrames(sb);
			AppendHotPaths(sb);
			AppendWarnings(sb);
			sb.Append("}");
			return sb.ToString();
		}

		private void AppendMetrics(StringBuilder sb, bool includeRaw)
		{
			sb.Append("\"metrics\":[");
			for (int i = 0; i < metrics.Count; i++)
			{
				if (i > 0) sb.Append(",");
				metrics[i].AppendJson(sb, includeRaw);
			}
			sb.Append("]");
		}

		private void AppendFrameTimings(StringBuilder sb, bool includeRaw)
		{
			sb.Append(",\"frameTimings\":[");
			for (int i = 0; includeRaw && i < frameTimings.Count; i++)
			{
				if (i > 0) sb.Append(",");
				frameTimings[i].AppendJson(sb);
			}
			sb.Append("]");
		}

		private void AppendHotFrames(StringBuilder sb)
		{
			sb.Append(",\"hotFrames\":[");
			for (int i = 0; i < hotFrames.Count; i++)
			{
				if (i > 0) sb.Append(",");
				hotFrames[i].AppendJson(sb);
			}
			sb.Append("]");
		}

		private void AppendHotPaths(StringBuilder sb)
		{
			sb.Append(",\"hotPaths\":[");
			for (int i = 0; i < hotPaths.Count; i++)
			{
				if (i > 0) sb.Append(",");
				hotPaths[i].AppendJson(sb);
			}
			sb.Append("]");
		}

		private void AppendWarnings(StringBuilder sb)
		{
			sb.Append(",\"warnings\":[");
			for (int i = 0; i < warnings.Count; i++)
			{
				if (i > 0) sb.Append(",");
				sb.Append("\"").Append(ProfilerSnapshotJson.Escape(warnings[i])).Append("\"");
			}
			sb.Append("]");
		}
	}

	internal sealed class MetricSnapshot
	{
		internal string category = "";
		internal string name = "";
		internal string unit = "";
		internal bool valid = false;
		internal bool timingNanoseconds = false;
		internal string error = "";
		internal int count = 0;
		internal double last = 0d;
		internal double min = 0d;
		internal double max = 0d;
		internal double avg = 0d;
		internal List<double> values = new List<double>();

		internal void AppendJson(StringBuilder sb, bool includeRaw)
		{
			sb.Append("{");
			ProfilerSnapshotJson.Prop(sb, "category", category).Append(",");
			ProfilerSnapshotJson.Prop(sb, "name", name).Append(",");
			ProfilerSnapshotJson.Prop(sb, "unit", unit).Append(",");
			ProfilerSnapshotJson.Prop(sb, "error", error).Append(",");
			sb.Append("\"valid\":").Append(ProfilerSnapshotJson.Bool(valid)).Append(",");
			sb.Append("\"timingNanoseconds\":").Append(ProfilerSnapshotJson.Bool(timingNanoseconds)).Append(",");
			sb.Append("\"count\":").Append(count.ToString(CultureInfo.InvariantCulture)).Append(",");
			sb.Append("\"last\":").Append(ProfilerSnapshotJson.Number(last)).Append(",");
			sb.Append("\"min\":").Append(ProfilerSnapshotJson.Number(min)).Append(",");
			sb.Append("\"max\":").Append(ProfilerSnapshotJson.Number(max)).Append(",");
			sb.Append("\"avg\":").Append(ProfilerSnapshotJson.Number(avg));
			AppendValues(sb, includeRaw);
			sb.Append("}");
		}

		private void AppendValues(StringBuilder sb, bool includeRaw)
		{
			if (includeRaw == false)
			{
				return;
			}

			sb.Append(",\"values\":[");
			for (int i = 0; i < values.Count; i++)
			{
				if (i > 0) sb.Append(",");
				sb.Append(ProfilerSnapshotJson.Number(values[i]));
			}
			sb.Append("]");
		}
	}

	internal sealed class FrameTimingSnapshot
	{
		internal double cpuFrameTimeMs;
		internal double gpuFrameTimeMs;
		internal double cpuMainThreadFrameTimeMs;
		internal double cpuRenderThreadFrameTimeMs;
		internal double cpuMainThreadPresentWaitTimeMs;

		internal void AppendJson(StringBuilder sb)
		{
			sb.Append("{");
			sb.Append("\"cpuFrameTimeMs\":").Append(ProfilerSnapshotJson.Number(cpuFrameTimeMs)).Append(",");
			sb.Append("\"gpuFrameTimeMs\":").Append(ProfilerSnapshotJson.Number(gpuFrameTimeMs)).Append(",");
			sb.Append("\"cpuMainThreadFrameTimeMs\":").Append(ProfilerSnapshotJson.Number(cpuMainThreadFrameTimeMs)).Append(",");
			sb.Append("\"cpuRenderThreadFrameTimeMs\":").Append(ProfilerSnapshotJson.Number(cpuRenderThreadFrameTimeMs)).Append(",");
			sb.Append("\"cpuMainThreadPresentWaitTimeMs\":").Append(ProfilerSnapshotJson.Number(cpuMainThreadPresentWaitTimeMs)).Append("}");
		}
	}

	internal sealed class ProfilerHotFrame
	{
		internal int frameIndex = 0;
		internal string threadName = "";
		internal double cpuFrameTimeMs = 0d;
		internal double gpuFrameTimeMs = 0d;

		internal void AppendJson(StringBuilder sb)
		{
			sb.Append("{");
			sb.Append("\"frameIndex\":").Append(frameIndex.ToString(CultureInfo.InvariantCulture)).Append(",");
			ProfilerSnapshotJson.Prop(sb, "threadName", threadName).Append(",");
			sb.Append("\"cpuFrameTimeMs\":").Append(ProfilerSnapshotJson.Number(cpuFrameTimeMs)).Append(",");
			sb.Append("\"gpuFrameTimeMs\":").Append(ProfilerSnapshotJson.Number(gpuFrameTimeMs)).Append("}");
		}
	}

	internal sealed class ProfilerHotPath
	{
		internal string name = "";
		internal string path = "";
		internal double totalTimeMs = 0d;
		internal double selfTimeMs = 0d;
		internal double maxTimeMs = 0d;
		internal double gcBytes = 0d;
		internal double calls = 0d;
		internal int framesSeen = 0;

		internal void AppendJson(StringBuilder sb)
		{
			sb.Append("{");
			ProfilerSnapshotJson.Prop(sb, "name", name).Append(",");
			ProfilerSnapshotJson.Prop(sb, "path", path).Append(",");
			sb.Append("\"totalTimeMs\":").Append(ProfilerSnapshotJson.Number(totalTimeMs)).Append(",");
			sb.Append("\"selfTimeMs\":").Append(ProfilerSnapshotJson.Number(selfTimeMs)).Append(",");
			sb.Append("\"maxTimeMs\":").Append(ProfilerSnapshotJson.Number(maxTimeMs)).Append(",");
			sb.Append("\"gcBytes\":").Append(ProfilerSnapshotJson.Number(gcBytes)).Append(",");
			sb.Append("\"calls\":").Append(ProfilerSnapshotJson.Number(calls)).Append(",");
			sb.Append("\"framesSeen\":").Append(framesSeen.ToString(CultureInfo.InvariantCulture)).Append("}");
		}
	}

	internal static class ProfilerSnapshotFormatter
	{
		internal static string FormatClipboard(string consoleEntries, ProfilerSnapshotSession session, bool includeRaw)
		{
			var sb = new StringBuilder(8192);
			AppendConsoleSection(sb, consoleEntries);
			AppendSessionSummary(sb, session);
			AppendMetricTrends(sb, session);
			AppendHotFrames(sb, session);
			AppendHotPaths(sb, session);
			AppendWarnings(sb, session);
			if (includeRaw)
			{
				AppendRawJson(sb, session);
			}
			return sb.ToString();
		}

		private static void AppendConsoleSection(StringBuilder sb, string consoleEntries)
		{
			sb.AppendLine("## Unity Console Snapshot");
			sb.AppendLine();
			sb.AppendLine(string.IsNullOrEmpty(consoleEntries) ? "(Console log is empty.)" : consoleEntries.TrimEnd());
			sb.AppendLine();
		}

		private static void AppendSessionSummary(StringBuilder sb, ProfilerSnapshotSession session)
		{
			sb.AppendLine("## Profiler Session");
			sb.AppendLine("```text");
			sb.AppendLine("id: " + session.id);
			sb.AppendLine("mode: " + session.mode);
			sb.AppendLine("capturedUtc: " + session.capturedUtc);
			sb.AppendLine("bottleneck: " + session.bottleneck);
			sb.AppendLine("unityVersion: " + session.unityVersion);
			sb.AppendLine("activeScene: " + session.activeScene);
			sb.AppendLine("storedPath: " + session.sessionPath);
			sb.AppendLine("```");
			sb.AppendLine();
		}

		private static void AppendMetricTrends(StringBuilder sb, ProfilerSnapshotSession session)
		{
			sb.AppendLine("### Metric Trends");
			for (int i = 0; i < session.metrics.Count; i++)
			{
				MetricSnapshot metric = session.metrics[i];
				if (metric.valid == false)
				{
					sb.AppendLine("- " + metric.name + ": unavailable");
					continue;
				}

				string avg = FormatMetricValue(metric, metric.avg);
				string max = FormatMetricValue(metric, metric.max);
				string last = FormatMetricValue(metric, metric.last);
				sb.AppendLine("- " + metric.name + ": avg=" + avg + " max=" + max + " last=" + last + " samples=" + metric.count);
			}
			sb.AppendLine();
		}

		private static void AppendHotFrames(StringBuilder sb, ProfilerSnapshotSession session)
		{
			if (session.hotFrames.Count == 0)
			{
				return;
			}

			sb.AppendLine("### Hot Frames");
			for (int i = 0; i < session.hotFrames.Count; i++)
			{
				ProfilerHotFrame frame = session.hotFrames[i];
				sb.AppendLine("- frame " + frame.frameIndex + ": cpu=" + frame.cpuFrameTimeMs.ToString("F2", CultureInfo.InvariantCulture) + "ms gpu=" + frame.gpuFrameTimeMs.ToString("F2", CultureInfo.InvariantCulture) + "ms thread=" + frame.threadName);
			}
			sb.AppendLine();
		}

		private static void AppendHotPaths(StringBuilder sb, ProfilerSnapshotSession session)
		{
			if (session.hotPaths.Count == 0)
			{
				return;
			}

			sb.AppendLine("### Hot Paths");
			for (int i = 0; i < session.hotPaths.Count; i++)
			{
				ProfilerHotPath path = session.hotPaths[i];
				sb.AppendLine("- " + path.path + ": total=" + path.totalTimeMs.ToString("F2", CultureInfo.InvariantCulture) + "ms self=" + path.selfTimeMs.ToString("F2", CultureInfo.InvariantCulture) + "ms gc=" + FormatBytes(path.gcBytes) + " max=" + path.maxTimeMs.ToString("F2", CultureInfo.InvariantCulture) + "ms");
			}
			sb.AppendLine();
		}

		private static void AppendWarnings(StringBuilder sb, ProfilerSnapshotSession session)
		{
			if (session.warnings.Count == 0)
			{
				return;
			}

			sb.AppendLine("### Warnings");
			for (int i = 0; i < session.warnings.Count; i++)
			{
				sb.AppendLine("- " + session.warnings[i]);
			}
			sb.AppendLine();
		}

		private static void AppendRawJson(StringBuilder sb, ProfilerSnapshotSession session)
		{
			sb.AppendLine("## Raw Profiler Session JSON");
			sb.AppendLine("```json");
			sb.AppendLine(session.ToJson(true));
			sb.AppendLine("```");
		}

		private static string FormatMetricValue(MetricSnapshot metric, double value)
		{
			if (metric.timingNanoseconds)
			{
				return (value * 1e-6d).ToString("F3", CultureInfo.InvariantCulture) + "ms";
			}

			if (metric.unit.IndexOf("Byte", StringComparison.OrdinalIgnoreCase) >= 0 || metric.name.IndexOf("Memory", StringComparison.OrdinalIgnoreCase) >= 0 || metric.name.IndexOf("Allocated", StringComparison.OrdinalIgnoreCase) >= 0)
			{
				return FormatBytes(value);
			}

			return value.ToString("F2", CultureInfo.InvariantCulture) + " " + metric.unit;
		}

		private static string FormatBytes(double bytes)
		{
			if (bytes >= 1024d * 1024d)
			{
				return (bytes / (1024d * 1024d)).ToString("F2", CultureInfo.InvariantCulture) + "MB";
			}
			if (bytes >= 1024d)
			{
				return (bytes / 1024d).ToString("F2", CultureInfo.InvariantCulture) + "KB";
			}
			return bytes.ToString("F0", CultureInfo.InvariantCulture) + "B";
		}
	}

	internal static class ProfilerSnapshotJson
	{
		internal static StringBuilder Prop(StringBuilder sb, string name, string value)
		{
			sb.Append("\"").Append(name).Append("\":\"").Append(Escape(value)).Append("\"");
			return sb;
		}

		internal static string Bool(bool value)
		{
			return value ? "true" : "false";
		}

		internal static string Number(double value)
		{
			if (double.IsNaN(value) || double.IsInfinity(value))
			{
				return "0";
			}
			return value.ToString("G17", CultureInfo.InvariantCulture);
		}

		internal static string Error(string message)
		{
			return "{\"success\":false,\"error\":\"" + Escape(message) + "\"}";
		}

		internal static string Escape(string value)
		{
			if (string.IsNullOrEmpty(value))
			{
				return string.Empty;
			}

			return value
				.Replace("\\", "\\\\")
				.Replace("\"", "\\\"")
				.Replace("\n", "\\n")
				.Replace("\r", "\\r")
				.Replace("\t", "\\t");
		}
	}
}

#endif
