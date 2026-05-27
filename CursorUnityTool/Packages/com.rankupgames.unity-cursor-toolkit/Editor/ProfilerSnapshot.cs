/*
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 * Project: Unity Cursor Toolkit
 * Description: Editor profiler session snapshots for clipboard and MCP diagnostics.
 */

#if UNITY_EDITOR
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;

using UnityEditor;
using UnityEditorInternal;
using UnityEngine;

#if UNITY_2020_2_OR_NEWER
using Unity.Profiling;
using Unity.Profiling.LowLevel.Unsafe;
using UnityEditor.Profiling;
#endif

namespace UnityCursorToolkit
{
	[FilePath("ProjectSettings/UnityCursorToolkitProfilerSnapshotSettings.asset", FilePathAttribute.Location.ProjectFolder)]
	internal sealed class ProfilerSnapshotSettings : ScriptableSingleton<ProfilerSnapshotSettings>
	{
		[SerializeField] private bool enabled = true;
		[SerializeField] private int frameBufferLength = 300;
		[SerializeField] private int tempSessionLimit = 15;
		[SerializeField] private bool captureHierarchy = true;
		[SerializeField] private int hierarchyDepth = 6;
		[SerializeField] private int maxHierarchyItems = 200;
		[SerializeField] private int topHotPathCount = 25;
		[SerializeField] private bool includeRawFrameArrays = true;
		[SerializeField] private bool deepProfiling = false;

		internal bool Enabled => enabled;
		internal int FrameBufferLength => Mathf.Clamp(frameBufferLength, 30, 5000);
		internal int TempSessionLimit => Mathf.Clamp(tempSessionLimit, 1, 100);
		internal bool CaptureHierarchy => captureHierarchy;
		internal int HierarchyDepth => Mathf.Clamp(hierarchyDepth, 1, 32);
		internal int MaxHierarchyItems => Mathf.Clamp(maxHierarchyItems, 25, 5000);
		internal int TopHotPathCount => Mathf.Clamp(topHotPathCount, 5, 200);
		internal bool IncludeRawFrameArrays => includeRawFrameArrays;
		internal bool DeepProfiling => deepProfiling;

		internal void SaveSettings()
		{
			Save(true);
			ProfilerSessionRecorder.ApplySettings();
		}

		internal static ProfilerSnapshotSettings Current => instance;
	}

	internal static class ProfilerSnapshotSettingsProvider
	{
		[SettingsProvider]
		public static SettingsProvider CreateProvider()
		{
			var provider = new SettingsProvider("Project/Unity Cursor Toolkit/Profiler Snapshot", SettingsScope.Project)
			{
				label = "Profiler Snapshot",
				guiHandler = _ => DrawSettings(),
				keywords = new HashSet<string>(new[] { "Unity Cursor Toolkit", "Profiler", "Snapshot", "Console", "MCP", "Frame Timing" })
			};
			return provider;
		}

		private static void DrawSettings()
		{
			ProfilerSnapshotSettings settings = ProfilerSnapshotSettings.Current;
			SerializedObject serialized = new SerializedObject(settings);

			EditorGUI.BeginChangeCheck();
			EditorGUILayout.PropertyField(serialized.FindProperty("enabled"), new GUIContent("Enable profiler snapshots"));
			EditorGUILayout.PropertyField(serialized.FindProperty("frameBufferLength"), new GUIContent("Frame buffer length"));
			EditorGUILayout.PropertyField(serialized.FindProperty("tempSessionLimit"), new GUIContent("Temporary session limit"));
			EditorGUILayout.Space();
			EditorGUILayout.PropertyField(serialized.FindProperty("captureHierarchy"), new GUIContent("Capture hierarchy data"));
			EditorGUILayout.PropertyField(serialized.FindProperty("hierarchyDepth"), new GUIContent("Hierarchy depth"));
			EditorGUILayout.PropertyField(serialized.FindProperty("maxHierarchyItems"), new GUIContent("Max hierarchy items"));
			EditorGUILayout.PropertyField(serialized.FindProperty("topHotPathCount"), new GUIContent("Top hot path count"));
			EditorGUILayout.PropertyField(serialized.FindProperty("includeRawFrameArrays"), new GUIContent("Include raw arrays in clipboard"));
			EditorGUILayout.PropertyField(serialized.FindProperty("deepProfiling"), new GUIContent("Deep profiling"));
			serialized.ApplyModifiedProperties();

			EditorGUILayout.Space();
			bool frameTimingStats = PlayerSettings.enableFrameTimingStats;
			bool nextFrameTimingStats = EditorGUILayout.Toggle(new GUIContent("Player Frame Timing Stats"), frameTimingStats);
			if (nextFrameTimingStats != frameTimingStats)
			{
				PlayerSettings.enableFrameTimingStats = nextFrameTimingStats;
			}

			if (EditorGUI.EndChangeCheck())
			{
				settings.SaveSettings();
			}

			EditorGUILayout.HelpBox("Copy Console Logs and profiler_snapshot use the current play session. When the Editor is not playing, they use the current editor session.", MessageType.Info);
		}
	}

	[InitializeOnLoad]
	internal static class ProfilerSessionRecorder
	{
		private const string SessionRootFolder = "Library/UnityCursorToolkit/ProfilerSessions";
		private const string TempFolderName = "temp";
		private const string SavedFolderName = "saved";

		private static readonly List<RecorderSlot> recorders = new List<RecorderSlot>();
		private static readonly List<FrameTimingSnapshot> frameTimings = new List<FrameTimingSnapshot>();
		private static readonly FrameTiming[] latestTiming = new FrameTiming[1];
		private static readonly object syncRoot = new object();

		private static string sessionId;
		private static string sessionStartedUtc;
		private static int activeCapacity;
		private static bool activeEnabled;
		private static bool profilerDriverManaged;
		private static bool profilerDriverOriginalEnabled;
#if UNITY_2020_2_OR_NEWER
		private static bool hierarchyColumnWarningLogged;
#endif
		private static bool profilerDriverWarningLogged;

		static ProfilerSessionRecorder()
		{
			sessionStartedUtc = DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture);
			sessionId = CreateSessionId();
			EditorApplication.update += Tick;
			EditorApplication.playModeStateChanged += OnPlayModeStateChanged;
			ApplySettings();
		}

		internal static void ApplySettings()
		{
			lock (syncRoot)
			{
				ProfilerSnapshotSettings settings = ProfilerSnapshotSettings.Current;
				if (settings.Enabled == false)
				{
					StopRecorders();
					SetProfilerDriverEnabled(false);
					activeEnabled = false;
					return;
				}

				if (activeEnabled == false || activeCapacity != settings.FrameBufferLength)
				{
					StartRecorders(settings.FrameBufferLength);
				}

				activeEnabled = true;
				ConfigureProfilerDriver(settings);
				TrimFrameTimings(settings.FrameBufferLength);
			}
		}

		internal static ProfilerSnapshotSession CaptureCurrentSession(bool includeRaw)
		{
			lock (syncRoot)
			{
				ProfilerSnapshotSettings settings = ProfilerSnapshotSettings.Current;
				if (settings.Enabled && (activeEnabled == false || activeCapacity != settings.FrameBufferLength))
				{
					StartRecorders(settings.FrameBufferLength);
				}

				var session = new ProfilerSnapshotSession
				{
					id = sessionId,
					mode = EditorApplication.isPlaying ? "play" : "editor",
					startedUtc = sessionStartedUtc,
					capturedUtc = DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture),
					unityVersion = Application.unityVersion,
					activeScene = UnityEngine.SceneManagement.SceneManager.GetActiveScene().path,
					isPlaying = EditorApplication.isPlaying,
					isPaused = EditorApplication.isPaused,
					isCompiling = EditorApplication.isCompiling,
					frameBufferLength = settings.FrameBufferLength,
					hierarchyEnabled = settings.CaptureHierarchy,
					deepProfiling = settings.DeepProfiling,
					frameTimingStatsEnabled = PlayerSettings.enableFrameTimingStats,
					metrics = CaptureMetrics(includeRaw),
					frameTimings = includeRaw ? new List<FrameTimingSnapshot>(frameTimings) : new List<FrameTimingSnapshot>(),
					warnings = new List<string>()
				};

				CaptureHierarchy(settings, session);
				AnalyzeBottleneck(session);
				session.sessionPath = StoreTempSession(session, includeRaw);
				return session;
			}
		}

		internal static string BuildClipboardSnapshot(string consoleEntries, bool includeRaw)
		{
			ProfilerSnapshotSession session = CaptureCurrentSession(includeRaw);
			return ProfilerSnapshotFormatter.FormatClipboard(consoleEntries, session, includeRaw);
		}

		internal static string ListSessionsJson(bool includeSaved)
		{
			var sb = new StringBuilder();
			sb.Append("{\"success\":true,\"sessions\":[");
			bool first = true;
			AppendSessionFiles(sb, TempFolder, "temp", ref first);
			if (includeSaved)
			{
				AppendSessionFiles(sb, SavedFolder, "saved", ref first);
			}
			sb.Append("]}");
			return sb.ToString();
		}

		internal static string ReadSessionJson(string id)
		{
			string path = ResolveSessionPath(id, true);
			if (string.IsNullOrEmpty(path) || File.Exists(path) == false)
			{
				return ProfilerSnapshotJson.Error("Session not found: " + id);
			}

			return "{\"success\":true,\"session\":" + File.ReadAllText(path) + "}";
		}

		internal static string SaveSessionJson(string id)
		{
			string source = ResolveSessionPath(id, false);
			if (string.IsNullOrEmpty(source) || File.Exists(source) == false)
			{
				return ProfilerSnapshotJson.Error("Temporary session not found: " + id);
			}

			Directory.CreateDirectory(SavedFolder);
			string dest = Path.Combine(SavedFolder, Path.GetFileName(source));
			File.Copy(source, dest, true);
			return "{\"success\":true,\"id\":\"" + ProfilerSnapshotJson.Escape(id) + "\",\"path\":\"" + ProfilerSnapshotJson.Escape(dest) + "\"}";
		}

		internal static string ClearSessionsJson(bool includeSaved)
		{
			DeleteFiles(TempFolder, "*.json");
			if (includeSaved)
			{
				DeleteFiles(SavedFolder, "*.json");
			}
			return "{\"success\":true}";
		}

		internal static string DiscoverCountersJson(int limit)
		{
#if UNITY_2020_2_OR_NEWER
			int cappedLimit = Mathf.Clamp(limit <= 0 ? 200 : limit, 1, 2000);
			var handles = new List<ProfilerRecorderHandle>();
			ProfilerRecorderHandle.GetAvailable(handles);
			var sb = new StringBuilder();
			sb.Append("{\"success\":true,\"count\":").Append(handles.Count.ToString(CultureInfo.InvariantCulture)).Append(",\"counters\":[");
			int count = Math.Min(cappedLimit, handles.Count);
			for (int i = 0; i < count; i++)
			{
				if (i > 0) sb.Append(",");
				ProfilerRecorderDescription description = ProfilerRecorderHandle.GetDescription(handles[i]);
				sb.Append("{\"name\":\"").Append(ProfilerSnapshotJson.Escape(description.Name)).Append("\",");
				sb.Append("\"category\":\"").Append(ProfilerSnapshotJson.Escape(description.Category.ToString())).Append("\",");
				sb.Append("\"unit\":\"").Append(ProfilerSnapshotJson.Escape(description.UnitType.ToString())).Append("\"}");
			}
			sb.Append("]}");
			return sb.ToString();
#else
			return ProfilerSnapshotJson.Error("ProfilerRecorder counter discovery requires Unity 2020.2 or newer.");
#endif
		}

		private static void Tick()
		{
			ProfilerSnapshotSettings settings = ProfilerSnapshotSettings.Current;
			if (settings.Enabled == false)
			{
				return;
			}

			if (activeEnabled == false || activeCapacity != settings.FrameBufferLength)
			{
				ApplySettings();
			}

			ConfigureProfilerDriver(settings);
			CaptureFrameTiming(settings.FrameBufferLength);
		}

		private static void OnPlayModeStateChanged(PlayModeStateChange state)
		{
			if (state == PlayModeStateChange.ExitingPlayMode)
			{
				CaptureCurrentSession(true);
			}

			if (state == PlayModeStateChange.EnteredPlayMode || state == PlayModeStateChange.EnteredEditMode)
			{
				ResetSession();
			}
		}

		private static void ResetSession()
		{
			lock (syncRoot)
			{
				sessionStartedUtc = DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture);
				sessionId = CreateSessionId();
				frameTimings.Clear();
				foreach (RecorderSlot recorder in recorders)
				{
					recorder.Reset();
				}
			}
		}

		private static void StartRecorders(int capacity)
		{
			StopRecorders();
			activeCapacity = capacity;
#if UNITY_2020_2_OR_NEWER
			AddRecorder(ProfilerCategory.Internal, "Main Thread", capacity, true);
			AddRecorder(ProfilerCategory.Internal, "Render Thread", capacity, true);
			AddRecorder(ProfilerCategory.Memory, "GC Allocated In Frame", capacity, false);
			AddRecorder(ProfilerCategory.Memory, "GC Allocation In Frame Count", capacity, false);
			AddRecorder(ProfilerCategory.Memory, "GC Reserved Memory", capacity, false);
			AddRecorder(ProfilerCategory.Memory, "GC Used Memory", capacity, false);
			AddRecorder(ProfilerCategory.Memory, "System Used Memory", capacity, false);
			AddRecorder(ProfilerCategory.Memory, "Total Reserved Memory", capacity, false);
			AddRecorder(ProfilerCategory.Memory, "Texture Memory", capacity, false);
			AddRecorder(ProfilerCategory.Memory, "Mesh Memory", capacity, false);
			AddRecorder(ProfilerCategory.Memory, "GC.Alloc", capacity, false, ProfilerRecorderOptions.SumAllSamplesInFrame);
#endif
			activeEnabled = true;
		}

#if UNITY_2020_2_OR_NEWER
		private static void AddRecorder(ProfilerCategory category, string name, int capacity, bool timingNanoseconds, ProfilerRecorderOptions extraOptions = ProfilerRecorderOptions.Default)
		{
			var slot = new RecorderSlot(category, name, capacity, timingNanoseconds, extraOptions);
			recorders.Add(slot);
		}
#endif

		private static void StopRecorders()
		{
			foreach (RecorderSlot recorder in recorders)
			{
				recorder.Dispose();
			}
			recorders.Clear();
			activeEnabled = false;
		}

		private static List<MetricSnapshot> CaptureMetrics(bool includeRaw)
		{
			var result = new List<MetricSnapshot>();
			foreach (RecorderSlot slot in recorders)
			{
				result.Add(slot.Capture(includeRaw));
			}
			return result;
		}

		private static void CaptureFrameTiming(int capacity)
		{
			FrameTimingManager.CaptureFrameTimings();
			uint count = FrameTimingManager.GetLatestTimings(1, latestTiming);
			if (count == 0)
			{
				return;
			}

			FrameTiming timing = latestTiming[0];
			frameTimings.Add(new FrameTimingSnapshot
			{
				cpuFrameTimeMs = timing.cpuFrameTime,
				gpuFrameTimeMs = timing.gpuFrameTime,
				cpuMainThreadFrameTimeMs = timing.cpuMainThreadFrameTime,
				cpuRenderThreadFrameTimeMs = timing.cpuRenderThreadFrameTime,
				cpuMainThreadPresentWaitTimeMs = timing.cpuMainThreadPresentWaitTime
			});
			TrimFrameTimings(capacity);
		}

		private static void TrimFrameTimings(int capacity)
		{
			while (frameTimings.Count > capacity)
			{
				frameTimings.RemoveAt(0);
			}
		}

		private static void CaptureHierarchy(ProfilerSnapshotSettings settings, ProfilerSnapshotSession session)
		{
			session.hotFrames = new List<ProfilerHotFrame>();
			session.hotPaths = new List<ProfilerHotPath>();

			if (settings.CaptureHierarchy == false)
			{
				session.warnings.Add("Hierarchy capture is disabled in Project Settings.");
				return;
			}

#if UNITY_2020_2_OR_NEWER
			int firstFrame = GetProfilerDriverInt("firstFrameIndex", -1);
			int lastFrame = GetProfilerDriverInt("lastFrameIndex", -1);
			if (firstFrame < 0 || lastFrame < firstFrame)
			{
				session.warnings.Add("No hierarchy profiler frames are available yet.");
				return;
			}

			int startFrame = Math.Max(firstFrame, lastFrame - settings.FrameBufferLength + 1);
			var aggregates = new Dictionary<string, ProfilerHotPath>(StringComparer.Ordinal);
			var children = new List<int>();
			int traversalLimit = Math.Max(settings.MaxHierarchyItems, settings.TopHotPathCount) * 20;

			for (int frame = startFrame; frame <= lastFrame; frame++)
			{
				using (HierarchyFrameDataView frameData = ProfilerDriver.GetHierarchyFrameDataView(frame, 0, HierarchyFrameDataView.ViewModes.Default, HierarchyFrameDataView.columnTotalTime, false))
				{
					if (frameData == null || frameData.valid == false)
					{
						continue;
					}

					session.hotFrames.Add(new ProfilerHotFrame
					{
						frameIndex = frame,
						threadName = frameData.threadName,
						cpuFrameTimeMs = frameData.frameTimeMs,
						gpuFrameTimeMs = frameData.frameGpuTimeMs
					});

					int visited = 0;
					children.Clear();
					frameData.GetItemChildren(frameData.GetRootItemID(), children);
					for (int i = 0; i < children.Count; i++)
					{
						CollectHierarchyItem(frameData, children[i], "", 1, settings.HierarchyDepth, traversalLimit, aggregates, ref visited);
					}
				}
			}

			session.hotFrames = session.hotFrames
				.OrderByDescending(f => f.cpuFrameTimeMs)
				.Take(Math.Min(10, session.hotFrames.Count))
				.ToList();

			session.hotPaths = aggregates.Values
				.OrderByDescending(p => p.totalTimeMs)
				.ThenByDescending(p => p.gcBytes)
				.Take(settings.TopHotPathCount)
				.ToList();
#else
			session.warnings.Add("Hierarchy profiler capture requires Unity 2020.2 or newer.");
#endif
		}

#if UNITY_2020_2_OR_NEWER
		private static void CollectHierarchyItem(
			HierarchyFrameDataView frameData,
			int itemId,
			string parentPath,
			int depth,
			int maxDepth,
			int traversalLimit,
			Dictionary<string, ProfilerHotPath> aggregates,
			ref int visited)
		{
			if (visited >= traversalLimit)
			{
				return;
			}
			visited++;

			string name = frameData.GetItemColumnData(itemId, HierarchyFrameDataView.columnName);
			if (string.IsNullOrEmpty(name))
			{
				name = "(unnamed)";
			}

			string path = string.IsNullOrEmpty(parentPath) ? name : parentPath + " > " + name;
			float totalMs = GetColumnFloat(frameData, itemId, HierarchyFrameDataView.columnTotalTime);
			float selfMs = GetColumnFloat(frameData, itemId, HierarchyFrameDataView.columnSelfTime);
			float gcBytes = GetColumnFloat(frameData, itemId, HierarchyFrameDataView.columnGcMemory);
			float calls = GetColumnFloat(frameData, itemId, HierarchyFrameDataView.columnCalls);

			ProfilerHotPath aggregate;
			if (aggregates.TryGetValue(path, out aggregate) == false)
			{
				aggregate = new ProfilerHotPath { name = name, path = path };
				aggregates[path] = aggregate;
			}

			aggregate.totalTimeMs += totalMs;
			aggregate.selfTimeMs += selfMs;
			aggregate.gcBytes += Math.Max(0f, gcBytes);
			aggregate.calls += Math.Max(0f, calls);
			aggregate.framesSeen++;
			if (totalMs > aggregate.maxTimeMs)
			{
				aggregate.maxTimeMs = totalMs;
			}

			if (depth >= maxDepth)
			{
				return;
			}

			var children = new List<int>();
			frameData.GetItemChildren(itemId, children);
			for (int i = 0; i < children.Count; i++)
			{
				CollectHierarchyItem(frameData, children[i], path, depth + 1, maxDepth, traversalLimit, aggregates, ref visited);
			}
		}

		private static float GetColumnFloat(HierarchyFrameDataView frameData, int itemId, int column)
		{
			try
			{
				return frameData.GetItemColumnDataAsFloat(itemId, column);
			}
			catch (Exception ex)
			{
				LogHierarchyColumnWarning(ex);
				return 0f;
			}
		}
#endif

		private static void AnalyzeBottleneck(ProfilerSnapshotSession session)
		{
			double cpuAvg = AverageFrameTiming(session.frameTimings, t => t.cpuFrameTimeMs);
			double gpuAvg = AverageFrameTiming(session.frameTimings, t => t.gpuFrameTimeMs);
			double presentAvg = AverageFrameTiming(session.frameTimings, t => t.cpuMainThreadPresentWaitTimeMs);
			double gcMax = 0d;
			for (int i = 0; i < session.metrics.Count; i++)
			{
				if (session.metrics[i].name == "GC Allocated In Frame")
				{
					gcMax = session.metrics[i].max;
					break;
				}
			}

			if (gpuAvg > 0.01d && gpuAvg > cpuAvg * 1.15d)
			{
				session.bottleneck = "GPU-bound";
			}
			else if (presentAvg > 0.01d && cpuAvg > 0.01d && presentAvg > cpuAvg * 0.25d)
			{
				session.bottleneck = "Present/vsync-limited";
			}
			else if (gcMax >= 1024d)
			{
				session.bottleneck = "GC allocation pressure";
			}
			else if (cpuAvg > 0.01d)
			{
				session.bottleneck = "CPU-bound or main-thread limited";
			}
			else
			{
				session.bottleneck = "Insufficient frame timing data";
				session.warnings.Add("FrameTimingManager returned no usable CPU/GPU samples yet.");
			}
		}

		private static double AverageFrameTiming(List<FrameTimingSnapshot> timings, Func<FrameTimingSnapshot, double> selector)
		{
			if (timings == null || timings.Count == 0)
			{
				return 0d;
			}

			double sum = 0d;
			for (int i = 0; i < timings.Count; i++)
			{
				sum += selector(timings[i]);
			}
			return sum / timings.Count;
		}

		private static void ConfigureProfilerDriver(ProfilerSnapshotSettings settings)
		{
			SetProfilerDriverEnabled(settings.CaptureHierarchy);
			SetProfilerDriverBool("profileEditor", EditorApplication.isPlaying == false);
			SetProfilerDriverBool("deepProfiling", settings.DeepProfiling);
			SetProfilerDriverInt("maxHistoryLength", settings.FrameBufferLength);
		}

		private static void SetProfilerDriverEnabled(bool enabled)
		{
			try
			{
				if (enabled)
				{
					if (profilerDriverManaged == false)
					{
						profilerDriverOriginalEnabled = ProfilerDriver.enabled;
						profilerDriverManaged = true;
					}
					ProfilerDriver.enabled = true;
				}
				else if (profilerDriverManaged)
				{
					if (profilerDriverOriginalEnabled == false)
					{
						ProfilerDriver.enabled = false;
					}
					profilerDriverManaged = false;
				}
			}
			catch (Exception ex)
			{
				LogProfilerDriverWarning(ex);
			}
		}

		private static void LogProfilerDriverWarning(Exception ex)
		{
			if (profilerDriverWarningLogged)
			{
				return;
			}

			profilerDriverWarningLogged = true;
			Debug.LogWarning("Unity Cursor Toolkit could not change ProfilerDriver state for profiler snapshots. Hierarchy capture may be unavailable. " + ex.Message);
		}

#if UNITY_2020_2_OR_NEWER
		private static void LogHierarchyColumnWarning(Exception ex)
		{
			if (hierarchyColumnWarningLogged)
			{
				return;
			}

			hierarchyColumnWarningLogged = true;
			Debug.LogWarning("Unity Cursor Toolkit could not read a profiler hierarchy column. Some hot path values may be omitted. " + ex.Message);
		}
#endif

		private static void SetProfilerDriverBool(string name, bool value)
		{
			Type type = typeof(ProfilerDriver);
			PropertyInfo property = type.GetProperty(name, BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
			if (property != null && property.CanWrite)
			{
				property.SetValue(null, value, null);
				return;
			}

			FieldInfo field = type.GetField(name, BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
			if (field != null)
			{
				field.SetValue(null, value);
			}
		}

		private static int GetProfilerDriverInt(string name, int fallback)
		{
			Type type = typeof(ProfilerDriver);
			PropertyInfo property = type.GetProperty(name, BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
			if (property != null)
			{
				object value = property.GetValue(null, null);
				return value is int ? (int)value : fallback;
			}

			FieldInfo field = type.GetField(name, BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
			if (field != null)
			{
				object value = field.GetValue(null);
				return value is int ? (int)value : fallback;
			}

			return fallback;
		}

		private static void SetProfilerDriverInt(string name, int value)
		{
			Type type = typeof(ProfilerDriver);
			PropertyInfo property = type.GetProperty(name, BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
			if (property != null && property.CanWrite)
			{
				property.SetValue(null, value, null);
				return;
			}

			FieldInfo field = type.GetField(name, BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
			if (field != null)
			{
				field.SetValue(null, value);
			}
		}

		private static string StoreTempSession(ProfilerSnapshotSession session, bool includeRaw)
		{
			Directory.CreateDirectory(TempFolder);
			string path = Path.Combine(TempFolder, session.id + ".json");
			session.sessionPath = path;
			File.WriteAllText(path, session.ToJson(includeRaw));
			TrimTempSessions();
			return path;
		}

		private static void TrimTempSessions()
		{
			Directory.CreateDirectory(TempFolder);
			FileInfo[] files = new DirectoryInfo(TempFolder).GetFiles("*.json")
				.OrderByDescending(f => f.LastWriteTimeUtc)
				.ToArray();
			int limit = ProfilerSnapshotSettings.Current.TempSessionLimit;
			for (int i = limit; i < files.Length; i++)
			{
				files[i].Delete();
			}
		}

		private static void AppendSessionFiles(StringBuilder sb, string folder, string kind, ref bool first)
		{
			if (Directory.Exists(folder) == false)
			{
				return;
			}

			FileInfo[] files = new DirectoryInfo(folder).GetFiles("*.json")
				.OrderByDescending(f => f.LastWriteTimeUtc)
				.ToArray();
			for (int i = 0; i < files.Length; i++)
			{
				if (first == false) sb.Append(",");
				first = false;
				string id = Path.GetFileNameWithoutExtension(files[i].Name);
				sb.Append("{\"id\":\"").Append(ProfilerSnapshotJson.Escape(id)).Append("\",");
				sb.Append("\"kind\":\"").Append(kind).Append("\",");
				sb.Append("\"path\":\"").Append(ProfilerSnapshotJson.Escape(files[i].FullName)).Append("\",");
				sb.Append("\"lastWriteUtc\":\"").Append(files[i].LastWriteTimeUtc.ToString("O", CultureInfo.InvariantCulture)).Append("\",");
				sb.Append("\"bytes\":").Append(files[i].Length.ToString(CultureInfo.InvariantCulture)).Append("}");
			}
		}

		private static string ResolveSessionPath(string id, bool includeSaved)
		{
			if (string.IsNullOrEmpty(id))
			{
				return null;
			}

			string safeId = Path.GetFileNameWithoutExtension(id);
			string temp = Path.Combine(TempFolder, safeId + ".json");
			if (File.Exists(temp))
			{
				return temp;
			}

			if (includeSaved)
			{
				string saved = Path.Combine(SavedFolder, safeId + ".json");
				if (File.Exists(saved))
				{
					return saved;
				}
			}

			return null;
		}

		private static void DeleteFiles(string folder, string pattern)
		{
			if (Directory.Exists(folder) == false)
			{
				return;
			}

			string[] files = Directory.GetFiles(folder, pattern);
			for (int i = 0; i < files.Length; i++)
			{
				File.Delete(files[i]);
			}
		}

		private static string CreateSessionId()
		{
			string mode = EditorApplication.isPlaying ? "play" : "editor";
			return mode + "_" + DateTime.UtcNow.ToString("yyyyMMdd_HHmmss_fff", CultureInfo.InvariantCulture);
		}

		private static string ProjectRoot
		{
			get
			{
				string dataPath = Application.dataPath.Replace("\\", "/");
				return dataPath.EndsWith("/Assets", StringComparison.Ordinal)
					? dataPath.Substring(0, dataPath.Length - "/Assets".Length)
					: Directory.GetCurrentDirectory();
			}
		}

		private static string TempFolder => Path.Combine(ProjectRoot, SessionRootFolder, TempFolderName);
		private static string SavedFolder => Path.Combine(ProjectRoot, SessionRootFolder, SavedFolderName);
	}
}

#endif
