/*
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 * Project: Unity Cursor Toolkit
 * Description: Opt-in, bounded Play session evidence and lifecycle journal.
 */
#if UNITY_EDITOR
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Threading;
using UnityEditor;
using UnityEngine;

namespace UnityCursorToolkit
{
	[InitializeOnLoad]
	internal static class PlaySessionMonitor
	{
		internal const string RelativeRoot = "Library/UnityCursorToolkit/PlaySessions";
		internal const int MaximumJournalBytes = 4 * 1024 * 1024;
		internal const int MaximumSnapshots = 8;
		private const int MaximumErrorGroups = 64;
		private const int MaximumArtifactBytes = 8 * 1024 * 1024;
		private const long MaximumStorageBytes = 512L * 1024 * 1024;
		private const long ReservedSessionBytes = 88L * 1024 * 1024;
		private const string Key = "UnityCursorToolkit.PlaySessions.";
		private static readonly object sync = new object();
		private static readonly Dictionary<ulong, PlaySessionError> errors = new Dictionary<ulong, PlaySessionError>();
		private static readonly Queue<PlaySessionError> pending = new Queue<PlaySessionError>();
		private static volatile bool acceptingErrors;
		private static volatile bool captureOnError;
		private static bool enabled;
		private static bool journalStopped;
		private static long sequence;
		private static long droppedErrors;
		private static string lastFailure;
		private static PlaySessionSummary session;

		internal static string Root => Path.Combine(Directory.GetParent(Application.dataPath).FullName, RelativeRoot);
		internal static string JournalPath => Path.Combine(Root, "events.jsonl");

		static PlaySessionMonitor()
		{
			enabled = SessionState.GetBool(Key + "Enabled", false);
			captureOnError = SessionState.GetBool(Key + "CaptureOnError", true);
			long.TryParse(SessionState.GetString(Key + "Sequence", "0"), NumberStyles.None, CultureInfo.InvariantCulture, out sequence);
			lastFailure = SessionState.GetString(Key + "LastFailure", string.Empty);
			journalStopped = SessionState.GetBool(Key + "JournalStopped", false);
			EditorApplication.playModeStateChanged += OnPlayModeChanged;
			AssemblyReloadEvents.beforeAssemblyReload += BeforeReload;
			EditorApplication.quitting += OnQuitting;
			if (enabled && !string.IsNullOrEmpty(SessionState.GetString(Key + "ActiveSession", string.Empty)))
			{
				acceptingErrors = true;
				Application.logMessageReceivedThreaded += OnError;
			}
			EditorApplication.delayCall += Restore;
		}

		internal static string Configure(bool monitorEnabled, bool errorsEnabled)
		{
			if (EditorApplication.isCompiling || EditorApplication.isUpdating)
				return Failure("editor_busy", "Configure session monitoring after compilation and import finish.");
			if (monitorEnabled && journalStopped) return Failure("journal_limit_reached", "Event recording is stopped at its evidence budget; no files were deleted.");
			enabled = monitorEnabled;
			captureOnError = errorsEnabled;
			SessionState.SetBool(Key + "Enabled", enabled);
			SessionState.SetBool(Key + "CaptureOnError", captureOnError);
			if (!enabled) End("monitor_disabled", Application.isPlaying);
			else if (Application.isPlaying && session == null) Begin("attached_during_play");
			return Status();
		}

		internal static string Status()
		{
			var sb = new StringBuilder();
			sb.Append("{\"success\":true,\"version\":1,\"enabled\":").Append(ProfilerSnapshotJson.Bool(enabled));
			sb.Append(",\"captureOnError\":").Append(ProfilerSnapshotJson.Bool(captureOnError));
			sb.Append(",\"active\":").Append(ProfilerSnapshotJson.Bool(session != null && string.IsNullOrEmpty(session.endedUtc)));
			sb.Append(",\"sequence\":").Append(sequence.ToString(CultureInfo.InvariantCulture)).Append(",");
			ProfilerSnapshotJson.Prop(sb, "sessionId", session == null ? string.Empty : session.id).Append(",");
			ProfilerSnapshotJson.Prop(sb, "journalPath", RelativeRoot + "/events.jsonl").Append(",");
			ProfilerSnapshotJson.Prop(sb, "lastFailure", lastFailure).Append(",");
			sb.Append("\"snapshotCount\":").Append(session == null ? 0 : session.snapshotCount);
			sb.Append(",\"observedErrors\":").Append(session == null ? 0 : CountErrors());
			sb.Append(",\"droppedErrors\":").Append(Interlocked.Read(ref droppedErrors));
			sb.Append(",\"journalStopped\":").Append(ProfilerSnapshotJson.Bool(journalStopped));
			sb.Append(",\"limits\":{\"snapshotsPerSession\":8,\"objectsPerSnapshot\":10000,\"componentsPerSnapshot\":50000,\"referencesPerSnapshot\":50000,\"snapshotBytes\":8388608,\"journalBytes\":4194304,\"storageBytes\":536870912,\"reservedSessionBytes\":92274688}}");
			return sb.ToString();
		}

		internal static string Capture(string reason)
		{
			if (!enabled || session == null || !Application.isPlaying || !string.IsNullOrEmpty(session.endedUtc))
				return Failure("play_session_required", "Enable monitoring and enter Play Mode before capturing.");
			if (EditorApplication.isCompiling || EditorApplication.isUpdating)
				return Failure("editor_busy", "Capture after compilation and import finish.");
			string id = null;
			if (!Storage(() => { id = StoreSnapshot(reason, null, false); SaveSummary(); }))
				return Failure("session_storage_failed", lastFailure);
			return id == null ? Failure("snapshot_limit", lastFailure) : "{\"success\":true,\"sessionId\":\"" + ProfilerSnapshotJson.Escape(session.id) + "\",\"snapshotId\":\"" + id + "\"}";
		}

		internal static string Events(long after, int limit)
		{
			if (after < 0 || limit < 1 || limit > 100) return Failure("invalid_arguments", "Event cursor or limit is out of range.");
			var sb = new StringBuilder("{\"success\":true,\"version\":1,\"events\":[");
			long next = after;
			int returned = 0;
			bool hasMore = false;
			if (File.Exists(JournalPath))
			{
				if (new FileInfo(JournalPath).Length > MaximumJournalBytes)
					return Failure("journal_limit", "The existing session journal exceeds the bounded read limit.");
				foreach (string line in File.ReadLines(JournalPath))
				{
					if (line.Length == 0) continue;
					PlaySessionEvent item = JsonUtility.FromJson<PlaySessionEvent>(line);
					if (item == null || item.version != 1 || item.sequence <= 0)
						return Failure("journal_invalid", "Session journal contains an invalid event.");
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

		internal static string Read(string sessionId, string snapshotId, int offset, int limit)
		{
			if (!ValidSessionId(sessionId) || (!string.IsNullOrEmpty(snapshotId) && !ValidSnapshotId(snapshotId)) || offset < 0 || offset > PlaySessionSnapshotBuilder.MaximumObjects || limit < 1 || limit > 200)
				return Failure("invalid_arguments", "Session identity or object pagination is invalid.");
			string directory = Path.Combine(Root, sessionId);
			if (Directory.Exists(Root) && (File.GetAttributes(Root) & FileAttributes.ReparsePoint) != 0)
				return Failure("evidence_link_rejected", "Session evidence root cannot be a symbolic link.");
			if (Directory.Exists(directory) && (File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0)
				return Failure("evidence_link_rejected", "Session evidence directory cannot be a symbolic link.");
			if (string.IsNullOrEmpty(snapshotId))
			{
				string summary = Path.Combine(directory, "session.json");
				if (!File.Exists(summary)) return Failure("session_not_found", "No captured session has that ID.");
				if ((File.GetAttributes(summary) & FileAttributes.ReparsePoint) != 0) return Failure("evidence_link_rejected", "Session summary cannot be a symbolic link.");
				if (new FileInfo(summary).Length > MaximumArtifactBytes) return Failure("artifact_limit", "Session summary exceeds its read budget.");
				return "{\"success\":true,\"session\":" + File.ReadAllText(summary) + "}";
			}
			string path = Path.Combine(directory, snapshotId + ".json");
			if (!File.Exists(path)) return Failure("snapshot_not_found", "No snapshot has that ID in this session.");
			if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) return Failure("evidence_link_rejected", "Snapshot cannot be a symbolic link.");
			if (new FileInfo(path).Length > PlaySessionSnapshotBuilder.MaximumSnapshotBytes)
				return Failure("artifact_limit", "Snapshot exceeds its bounded read limit.");
			PlaySessionSnapshot snapshot = JsonUtility.FromJson<PlaySessionSnapshot>(File.ReadAllText(path));
			if (snapshot == null || snapshot.version != 1 || snapshot.id != snapshotId || snapshot.sessionId != sessionId || snapshot.objects == null)
				return Failure("snapshot_invalid", "Snapshot metadata does not match its requested identity.");
			if (offset > snapshot.objects.Count) return Failure("offset_out_of_range", "Object offset exceeds the captured row count.");
			int total = snapshot.objects.Count;
			int count = Math.Min(limit, total - offset);
			var page = new List<PlaySessionObject>();
			int bytes = 0;
			for (int i = 0; i < count; i++)
			{
				string json = JsonUtility.ToJson(snapshot.objects[offset + i]);
				int size = Encoding.UTF8.GetByteCount(json);
				if (bytes + size > 512 * 1024) break;
				page.Add(snapshot.objects[offset + i]);
				bytes += size;
			}
			if (count > 0 && page.Count == 0) return Failure("object_row_limit", "One captured object exceeds the page byte limit.");
			snapshot.objects = page;
			return "{\"success\":true,\"offset\":" + offset + ",\"nextOffset\":" + (offset + page.Count) + ",\"capturedObjectCount\":" + total +
				",\"hasMore\":" + ProfilerSnapshotJson.Bool(offset + page.Count < total) + ",\"snapshot\":" + JsonUtility.ToJson(snapshot) + "}";
		}

		internal static bool ValidSessionId(string id)
		{
			if (id == null || id.Length != 29 || !id.StartsWith("play_", StringComparison.Ordinal) || id[13] != '_' || id[20] != '_') return false;
			for (int i = 5; i < id.Length; i++)
			{
				if (i == 13 || i == 20) continue;
				char c = id[i];
				if (i < 20 ? c < '0' || c > '9' : !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
			}
			return true;
		}

		internal static bool ValidSnapshotId(string id)
		{
			if (id == null || id.Length != 13 || !id.StartsWith("snapshot-", StringComparison.Ordinal)) return false;
			int number;
			return int.TryParse(id.Substring(9), NumberStyles.None, CultureInfo.InvariantCulture, out number) && number >= 1 && number <= MaximumSnapshots;
		}

		private static void Restore()
		{
			if (!enabled) return;
			string id = SessionState.GetString(Key + "ActiveSession", string.Empty);
			if (string.IsNullOrEmpty(id)) { if (Application.isPlaying) Begin("entered_play"); return; }
			if (!ValidSessionId(id)) { Unhook(); SetFailure("session_state_invalid"); return; }
			if (!Storage(() =>
			{
				string path = Path.Combine(Root, id, "session.json");
				if (!File.Exists(path) || new FileInfo(path).Length > MaximumArtifactBytes)
					throw new IOException("The active session summary is missing or oversized.");
				session = JsonUtility.FromJson<PlaySessionSummary>(File.ReadAllText(path));
				if (session == null || session.version != 1 || session.id != id || session.snapshotCount < 0 || session.snapshotCount > MaximumSnapshots)
					throw new IOException("The active session summary is invalid.");
				droppedErrors = session.droppedErrors;
				lock (sync)
				{
					var early = new List<PlaySessionError>(errors.Values);
					errors.Clear();
					pending.Clear();
					for (int i = 0; i < session.errors.Count && i < MaximumErrorGroups; i++)
					{
						PlaySessionError error = session.errors[i];
						ulong key;
						if (!ulong.TryParse(error.key, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out key))
							throw new IOException("The active session contains an invalid error key.");
						if (errors.ContainsKey(key)) throw new IOException("The active session contains duplicate error groups.");
						errors.Add(key, error);
					}
					for (int i = 0; i < early.Count; i++)
					{
						PlaySessionError current = early[i];
						ulong key;
						ulong.TryParse(current.key, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out key);
						PlaySessionError prior;
						if (errors.TryGetValue(key, out prior))
						{
							prior.count = long.MaxValue - prior.count < current.count ? long.MaxValue : prior.count + current.count;
							prior.lastUtc = current.lastUtc;
							prior.lastUtcTicks = current.lastUtcTicks;
						}
						else if (errors.Count < MaximumErrorGroups) errors.Add(key, current);
						else droppedErrors += current.count;
					}
					foreach (PlaySessionError error in errors.Values)
						if (!error.announced) pending.Enqueue(error);
				}
				if (Application.isPlaying)
				{
					Hook();
					Emit("session_resumed", null, null, "Domain reload completed.");
				}
				else End("reload_interrupted", false);
			})) { Unhook(); session = null; SessionState.EraseString(Key + "ActiveSession"); }
		}

		private static void Begin(string reason)
		{
			if (session != null && string.IsNullOrEmpty(session.endedUtc)) return;
			if (journalStopped) { SetFailure("journal_limit_reached: no new session was started and no evidence was deleted."); return; }
			lastFailure = string.Empty;
			SessionState.SetString(Key + "LastFailure", string.Empty);
			session = new PlaySessionSummary
			{
				id = "play_" + DateTime.UtcNow.ToString("yyyyMMdd_HHmmss", CultureInfo.InvariantCulture) + "_" + Guid.NewGuid().ToString("N").Substring(0, 8),
				startedUtc = DateTime.UtcNow.ToString("O"), unityVersion = Application.unityVersion,
				editorProcessId = System.Diagnostics.Process.GetCurrentProcess().Id
			};
			droppedErrors = 0;
			NativeConsoleContext.BeginSession(session.id);
			lock (sync) { errors.Clear(); pending.Clear(); }
			SessionState.SetString(Key + "ActiveSession", session.id);
			if (!Storage(() =>
			{
				ReserveStorage();
				Directory.CreateDirectory(Path.Combine(Root, session.id));
				ResumeSequence();
				SaveSummary();
				Emit("session_started", null, null, reason);
				SessionState.SetBool(Key + "InitialCapturePending", true);
				if (Application.isPlaying) { StoreSnapshot("session_start", null, false); SessionState.SetBool(Key + "InitialCapturePending", false); }
				SaveSummary();
			})) { session = null; SessionState.EraseString(Key + "ActiveSession"); return; }
			Hook();
		}

		private static void Hook()
		{
			acceptingErrors = true;
			Application.logMessageReceivedThreaded -= OnError;
			Application.logMessageReceivedThreaded += OnError;
			EditorApplication.update -= Tick;
			EditorApplication.update += Tick;
		}

		private static void Unhook()
		{
			acceptingErrors = false;
			Application.logMessageReceivedThreaded -= OnError;
			EditorApplication.update -= Tick;
		}

		private static void OnPlayModeChanged(PlayModeStateChange state)
		{
			if (state == PlayModeStateChange.ExitingEditMode && enabled) Begin("entering_play");
			if (state == PlayModeStateChange.EnteredPlayMode && enabled)
			{
				NativeConsoleContext.ObserveReset();
				if (session == null) Begin("entered_play");
				else Hook();
			}
			if (state == PlayModeStateChange.ExitingPlayMode) End("exiting_play", true);
		}

		private static void BeforeReload()
		{
			Unhook();
			if (session == null || !string.IsNullOrEmpty(session.endedUtc)) return;
			session.reloadObserved = true;
			Storage(() => { SaveSummary(); Emit("session_reloading", null, null, "Snapshot capture suspended for domain reload."); });
		}

		internal static void CaptureBeforeProfilerShutdown() { End("exiting_play", true); }

		private static void OnQuitting() { End("editor_quitting", Application.isPlaying); }

		private static void End(string reason, bool captureWorld)
		{
			if (session == null || !string.IsNullOrEmpty(session.endedUtc)) return;
			Unhook();
			Storage(() => { Drain(false); if (captureWorld) StoreSnapshot("session_end", null, true); });
			Storage(CopyProfilerEvidence);
			session.endedUtc = DateTime.UtcNow.ToString("O");
			session.endReason = reason;
			session.interrupted = reason == "reload_interrupted";
			Storage(() => { SaveSummary(); Emit("session_ended", null, null, reason + (string.IsNullOrEmpty(lastFailure) ? string.Empty : " | " + lastFailure)); });
			SessionState.EraseString(Key + "ActiveSession");
		}

		private static void OnError(string message, string stackTrace, LogType type)
		{
			if (!acceptingErrors || (type != LogType.Error && type != LogType.Exception && type != LogType.Assert)) return;
			string boundedMessage = PlaySessionSnapshotBuilder.Limit(message, 2048);
			string boundedStack = PlaySessionSnapshotBuilder.Limit(stackTrace, 4096);
			ulong key = Hash(boundedMessage, boundedStack, type);
			long nowTicks = DateTime.UtcNow.Ticks;
			lock (sync)
			{
				if (!acceptingErrors) return;
				PlaySessionError error;
				if (errors.TryGetValue(key, out error))
				{
					if (error.message != boundedMessage || error.stackTrace != boundedStack) { droppedErrors++; return; }
					if (error.count < long.MaxValue) error.count++;
					error.lastUtcTicks = nowTicks;
					return;
				}
				if (errors.Count >= MaximumErrorGroups) { droppedErrors++; return; }
				error = new PlaySessionError
				{
					key = key.ToString("x16", CultureInfo.InvariantCulture), type = type.ToString(), message = boundedMessage,
					stackTrace = boundedStack, firstUtc = new DateTime(nowTicks, DateTimeKind.Utc).ToString("O"),
					lastUtcTicks = nowTicks, count = 1,
					textTruncated = (message != null && message.Length > 2048) || (stackTrace != null && stackTrace.Length > 4096)
				};
				errors.Add(key, error);
				pending.Enqueue(error);
			}
		}

		private static void Tick()
		{
			if (session == null || EditorApplication.isCompiling || EditorApplication.isUpdating || !Application.isPlaying) return;
			if (SessionState.GetBool(Key + "InitialCapturePending", false))
			{
				if (Storage(() => { StoreSnapshot("session_start", null, false); SaveSummary(); }))
					SessionState.SetBool(Key + "InitialCapturePending", false);
				return;
			}
			bool hasPending;
			lock (sync) hasPending = pending.Count > 0;
			if (hasPending) Storage(() => { Drain(true); SaveSummary(); });
		}

		private static void Drain(bool capture)
		{
			PlaySessionError error;
			lock (sync)
			{
				if (pending.Count == 0) return;
				error = pending.Dequeue();
			}
			error.announced = true;
			FormatErrorTime(error);
			Emit("error_observed", error, null, "A new error group was observed; correlation is not proof of causality.");
			if (capture && captureOnError) StoreSnapshot("error", error, false);
			if (!capture) Drain(false);
		}

		private static string StoreSnapshot(string reason, PlaySessionError error, bool final)
		{
			if (session.snapshotCount >= (final ? MaximumSnapshots : MaximumSnapshots - 1))
			{
				SetFailure("snapshot_limit_reached: the final capture slot is reserved; no evidence was deleted.");
				Emit("capture_limit_reached", error, null, lastFailure);
				return null;
			}
			string id = "snapshot-" + (session.snapshotCount + 1).ToString("D4", CultureInfo.InvariantCulture);
			PlaySessionError capturedError = null;
			if (error != null)
				lock (sync)
				{
					FormatErrorTime(error);
					capturedError = new PlaySessionError { key = error.key, type = error.type, message = error.message, stackTrace = error.stackTrace,
						firstUtc = error.firstUtc, lastUtc = error.lastUtc, count = error.count, textTruncated = error.textTruncated, announced = error.announced };
				}
			PlaySessionSnapshot snapshot = PlaySessionSnapshotBuilder.Capture(session.id, id, reason, capturedError);
			string json = JsonUtility.ToJson(snapshot);
			int bytes = Encoding.UTF8.GetByteCount(json);
			if (bytes > PlaySessionSnapshotBuilder.MaximumSnapshotBytes)
			{
				SetFailure("snapshot_byte_limit: metadata exceeded the reserved byte budget.");
				Emit("capture_limit_reached", error, null, lastFailure);
				return null;
			}
			string relative = RelativeRoot + "/" + session.id + "/" + id + ".json";
			using (var stream = new FileStream(Path.Combine(Root, session.id, id + ".json"), FileMode.CreateNew, FileAccess.Write))
			using (var writer = new StreamWriter(stream, new UTF8Encoding(false))) writer.Write(json);
			session.snapshotCount++;
			session.snapshotBytes += bytes;
			if (error != null) error.snapshotId = id;
			Emit("snapshot_captured", error, relative, snapshot.truncated ? snapshot.truncationReason : reason);
			return id;
		}

		private static void SaveSummary()
		{
			lock (sync)
			{
				foreach (PlaySessionError error in errors.Values) FormatErrorTime(error);
				session.errors = new List<PlaySessionError>(errors.Values);
				session.observedErrors = CountErrors();
				session.droppedErrors = droppedErrors;
				session.lastFailure = lastFailure;
				string json = JsonUtility.ToJson(session);
				if (Encoding.UTF8.GetByteCount(json) > MaximumArtifactBytes) throw new IOException("Session summary exceeds its byte budget.");
				File.WriteAllText(Path.Combine(Root, session.id, "session.json"), json, new UTF8Encoding(false));
			}
		}

		private static long CountErrors()
		{
			long count = 0;
			lock (sync)
				foreach (PlaySessionError error in errors.Values)
					count = long.MaxValue - count < error.count ? long.MaxValue : count + error.count;
			return count;
		}

		private static void CopyProfilerEvidence()
		{
			ProfilerSnapshotSession snapshot = ProfilerSessionRecorder.CaptureCurrentSession(false);
			session.profilerPath = CopyArtifact(snapshot.sessionPath, "profiler.json");
			session.consolePath = CopyArtifact(snapshot.consoleTranscriptPath, "console.json");
		}

		private static string CopyArtifact(string source, string filename)
		{
			if (string.IsNullOrEmpty(source) || !File.Exists(source)) throw new IOException("Profiler evidence is missing.");
			if (new FileInfo(source).Length > MaximumArtifactBytes) throw new IOException("Profiler evidence exceeds its copy budget.");
			File.Copy(source, Path.Combine(Root, session.id, filename), false);
			return RelativeRoot + "/" + session.id + "/" + filename;
		}

		private static void FormatErrorTime(PlaySessionError error)
		{
			if (error.lastUtcTicks > 0) error.lastUtc = new DateTime(error.lastUtcTicks, DateTimeKind.Utc).ToString("O");
		}

		private static void ReserveStorage()
		{
			if (!Directory.Exists(Root)) return;
			var directories = new Stack<DirectoryInfo>();
			directories.Push(new DirectoryInfo(Root));
			long bytes = 0;
			int entries = 0;
			while (directories.Count > 0)
			{
				DirectoryInfo directory = directories.Pop();
				if ((directory.Attributes & FileAttributes.ReparsePoint) != 0) throw new IOException("Session storage cannot traverse symbolic links.");
				foreach (FileSystemInfo entry in directory.EnumerateFileSystemInfos())
				{
					if (++entries > 10000) throw new IOException("Session storage inventory exceeded its bounded entry count.");
					if ((entry.Attributes & FileAttributes.ReparsePoint) != 0) throw new IOException("Session storage cannot traverse symbolic links.");
					DirectoryInfo child = entry as DirectoryInfo;
					if (child != null) { directories.Push(child); continue; }
					bytes += ((FileInfo)entry).Length;
					if (bytes > MaximumStorageBytes - ReservedSessionBytes)
						throw new IOException("Session storage budget reached; no evidence was deleted.");
				}
			}
		}

		private static void ResumeSequence()
		{
			if (sequence != 0 || !File.Exists(JournalPath)) return;
			if (new FileInfo(JournalPath).Length > MaximumJournalBytes) throw new IOException("Session journal exceeds its bounded read limit.");
			foreach (string line in File.ReadLines(JournalPath))
			{
				if (line.Length == 0) continue;
				PlaySessionEvent item = JsonUtility.FromJson<PlaySessionEvent>(line);
				if (item == null || item.version != 1 || item.sequence <= sequence || item.sequence > 9007199254740991L) throw new IOException("Session journal sequence is invalid.");
				sequence = item.sequence;
			}
			SessionState.SetString(Key + "Sequence", sequence.ToString(CultureInfo.InvariantCulture));
		}

		private static void Emit(string kind, PlaySessionError error, string snapshotPath, string message)
		{
			if (journalStopped) return;
			Directory.CreateDirectory(Root);
			if (sequence >= 9007199254740991L) throw new IOException("Session journal sequence exceeds the safe JSON integer limit.");
			long length = File.Exists(JournalPath) ? new FileInfo(JournalPath).Length : 0;
			if (length >= MaximumJournalBytes - 8192)
			{
				journalStopped = true;
				SessionState.SetBool(Key + "JournalStopped", true);
				SetFailure("journal_limit_reached: event recording stopped; evidence was not deleted.");
				kind = "journal_limit_reached";
				error = null; snapshotPath = null; message = lastFailure;
			}
			var item = new PlaySessionEvent
			{
				sequence = sequence + 1, sessionId = session == null ? string.Empty : session.id, kind = kind,
				occurredUtc = DateTime.UtcNow.ToString("O"), frame = Time.frameCount, snapshotPath = snapshotPath,
				errorKey = error == null ? null : error.key, errorCount = error == null ? 0 : error.count,
				message = PlaySessionSnapshotBuilder.Limit(message, 1024)
			};
			string line = JsonUtility.ToJson(item) + "\n";
			if (length + Encoding.UTF8.GetByteCount(line) > MaximumJournalBytes) throw new IOException("Session journal byte limit reached.");
			File.AppendAllText(JournalPath, line, new UTF8Encoding(false));
			sequence = item.sequence;
			SessionState.SetString(Key + "Sequence", sequence.ToString(CultureInfo.InvariantCulture));
		}

		private static bool Storage(Action action)
		{
			try { action(); return true; }
			catch (IOException exception) { SetFailure("session_storage_failed: " + exception.Message); return false; }
			catch (UnauthorizedAccessException exception) { SetFailure("session_storage_denied: " + exception.Message); return false; }
		}

		private static void SetFailure(string reason)
		{
			lastFailure = reason;
			SessionState.SetString(Key + "LastFailure", reason);
		}

		private static ulong Hash(string message, string stack, LogType type)
		{
			unchecked
			{
				ulong hash = 14695981039346656037UL ^ (ulong)type;
				for (int i = 0; i < message.Length; i++) hash = (hash ^ message[i]) * 1099511628211UL;
				hash = (hash ^ '\n') * 1099511628211UL;
				for (int i = 0; i < stack.Length; i++) hash = (hash ^ stack[i]) * 1099511628211UL;
				return hash;
			}
		}

		internal static string Failure(string code, string message)
		{
			return "{\"success\":false,\"code\":\"" + ProfilerSnapshotJson.Escape(code) + "\",\"error\":\"" + ProfilerSnapshotJson.Escape(message) + "\"}";
		}
	}
}
#endif
