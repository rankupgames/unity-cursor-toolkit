/*
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 * Project: Unity Cursor Toolkit
 * Description: Bounded Play session evidence models and hierarchy capture.
 */
#if UNITY_EDITOR
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Reflection;
using System.Text;
using UnityEditor;
using UnityEngine;
using UnityEngine.SceneManagement;
using Object = UnityEngine.Object;

namespace UnityCursorToolkit
{
	[Serializable]
	internal sealed class LoadedSceneSnapshot
	{
		public string name;
		public string path;
		public bool isActive;
	}

	internal static class LoadedSceneCapture
	{
		// SceneManager does not enumerate the special DontDestroyOnLoad scene.
		internal static List<LoadedSceneSnapshot> Capture(out string activeScene)
		{
			Scene active = SceneManager.GetActiveScene();
			activeScene = active.path;
			var result = new List<LoadedSceneSnapshot>();
			for (int i = 0; i < SceneManager.sceneCount; i++)
			{
				Scene scene = SceneManager.GetSceneAt(i);
				if (!scene.IsValid() || !scene.isLoaded) continue;
				result.Add(new LoadedSceneSnapshot { name = scene.name, path = scene.path, isActive = scene == active });
			}
			return result;
		}
	}

	[Serializable]
	internal sealed class PlaySessionEvent
	{
		public int version = 1;
		public long sequence;
		public string sessionId;
		public string kind;
		public string occurredUtc;
		public int frame;
		public string snapshotPath;
		public string errorKey;
		public long errorCount;
		public string message;
	}

	[Serializable]
	internal sealed class PlaySessionError
	{
		public string key;
		public string type;
		public string message;
		public string stackTrace;
		public string firstUtc;
		public string lastUtc;
		[NonSerialized] public long lastUtcTicks;
		public long count;
		public bool textTruncated;
		public bool announced;
		public string snapshotId;
	}

	[Serializable]
	internal sealed class PlaySessionSummary
	{
		public int version = 1;
		public string id;
		public string startedUtc;
		public string endedUtc;
		public string endReason;
		public string unityVersion;
		public int editorProcessId;
		public int snapshotCount;
		public long snapshotBytes;
		public long observedErrors;
		public long droppedErrors;
		public bool interrupted;
		public bool reloadObserved;
		public string lastFailure;
		public string profilerPath;
		public string consolePath;
		public List<PlaySessionError> errors = new List<PlaySessionError>();
	}

	[Serializable]
	internal sealed class PlaySessionReference
	{
		public string propertyPath;
		public int instanceId;
		// "unassigned" is not proof of a defect. "missing" retains Unity's broken nonzero reference ID.
		public string state;
	}

	[Serializable]
	internal sealed class PlaySessionComponent
	{
		public int slot;
		public int instanceId;
		public string type;
		public string scriptPath;
		public bool missingScript;
		public bool hasEnabled;
		public bool enabled;
		public bool referencesTruncated;
		public List<PlaySessionReference> references = new List<PlaySessionReference>();
		public List<string> missingRequiredComponents = new List<string>();
	}

	[Serializable]
	internal sealed class PlaySessionObject
	{
		public int instanceId;
		public int parentInstanceId;
		public int sceneHandle;
		public int childCount;
		public int siblingIndex;
		public string name;
		public string sceneName;
		public string scenePath;
		public int layer;
		public string layerName;
		public string tag;
		public bool activeSelf;
		public bool activeInHierarchy;
		public Vector3 position;
		public Quaternion rotation;
		public Vector3 localPosition;
		public Quaternion localRotation;
		public Vector3 localScale;
		public bool componentsTruncated;
		public List<PlaySessionComponent> components = new List<PlaySessionComponent>();
	}

	[Serializable]
	internal sealed class PlaySessionConsoleMatch
	{
		public int index;
		public int instanceId;
		public string stackCompatibility;
	}

	[Serializable]
	internal sealed class PlaySessionSnapshot
	{
		public int version = 1;
		public string sessionId;
		public string id;
		public string reason;
		public string capturedUtc;
		public int frame;
		public double captureMilliseconds;
		public string activeScene;
		public List<LoadedSceneSnapshot> loadedScenes;
		public bool includesDontDestroyOnLoad;
		public bool truncated;
		public string truncationReason;
		public int objectLimit;
		public int componentLimit;
		public int referenceLimit;
		public int capturedComponents;
		public int capturedReferences;
		public PlaySessionError error;
		public string errorObservedUtc;
		public double errorCaptureDelayMilliseconds = -1;
		public string timing = "Snapshot captured on the next safe Editor tick; an exact error frame is unavailable from Unity's threaded log callback.";
		public string contextEvidence = "unresolved";
		public int contextInstanceId;
		public int contextObjectInstanceId;
		public bool contextPrioritized;
		public bool consoleRangeKnown;
		public string consoleScope;
		public string consoleSessionId;
		public int consoleStartIndex = -1;
		public int consoleEndIndex = -1;
		public int consoleScannedFrom = -1;
		public int consoleEpoch;
		public bool consoleResetDetected;
		public bool consoleWindowTruncated;
		public int matchedConsoleIndex = -1;
		public int consoleMessageMatchCount;
		public bool consoleMatchesTruncated;
		public List<PlaySessionConsoleMatch> consoleMatches = new List<PlaySessionConsoleMatch>();
		public List<int> candidateObjectIds = new List<int>();
		public List<int> candidateComponentIds = new List<int>();
		public bool candidatesTruncated;
		public List<PlaySessionObject> objects = new List<PlaySessionObject>();
	}

	internal static class PlaySessionSnapshotBuilder
	{
		internal const int MaximumObjects = 10000;
		internal const int MaximumComponents = 50000;
		internal const int MaximumReferences = 50000;
		internal const int MaximumSnapshotBytes = 8 * 1024 * 1024;
		private const int MaximumComponentsPerObject = 32;
		private const int MaximumReferencesPerComponent = 16;
		private const int MaximumSerializedProperties = 512;
		private const int MaximumPriorityScanObjects = 50000;
		internal static PlaySessionSnapshot Capture(string sessionId, string id, string reason, PlaySessionError error)
		{
			var watch = Stopwatch.StartNew();
			string active;
			var snapshot = new PlaySessionSnapshot
			{
				sessionId = sessionId, id = id, reason = reason, capturedUtc = DateTime.UtcNow.ToString("O"),
				frame = Time.frameCount, loadedScenes = LoadedSceneCapture.Capture(out active), activeScene = active,
				objectLimit = MaximumObjects, componentLimit = MaximumComponents, referenceLimit = MaximumReferences,
				error = error, errorObservedUtc = error == null ? null : error.firstUtc
			};
			DateTime errorTime;
			if (error != null && DateTime.TryParse(error.firstUtc, null, System.Globalization.DateTimeStyles.RoundtripKind, out errorTime))
				snapshot.errorCaptureDelayMilliseconds = Math.Max(0, (DateTime.UtcNow - errorTime.ToUniversalTime()).TotalMilliseconds);
			var roots = new List<GameObject>();
			for (int i = 0; i < SceneManager.sceneCount; i++)
			{
				Scene scene = SceneManager.GetSceneAt(i);
				if (!scene.IsValid() || !scene.isLoaded) continue;
				GameObject[] sceneRoots = scene.GetRootGameObjects();
				Array.Sort(sceneRoots, CompareSibling);
				roots.AddRange(sceneRoots);
			}
			if (Application.isPlaying)
			{
				// This scan happens only for an explicit snapshot. It includes inactive DDOL roots without a probe GameObject.
				GameObject[] allObjects = Resources.FindObjectsOfTypeAll<GameObject>();
				var persistentRoots = new List<GameObject>();
				for (int i = 0; i < allObjects.Length; i++)
				{
					GameObject item = allObjects[i];
					if (item && !EditorUtility.IsPersistent(item) && item.transform.parent == null &&
						item.scene.IsValid() && item.scene.isLoaded && item.scene.name == "DontDestroyOnLoad") persistentRoots.Add(item);
				}
				persistentRoots.Sort(CompareSibling);
				roots.AddRange(persistentRoots);
				snapshot.includesDontDestroyOnLoad = true;
			}
			Dictionary<string, int> errorTypes = ErrorTypes(error);
			if (error != null) NativeConsoleContext.Find(error, snapshot);
			List<Transform> priority = PriorityOwners(roots, errorTypes, snapshot);
			var stack = new Stack<Transform>();
			for (int i = roots.Count - 1; i >= 0; i--) stack.Push(roots[i].transform);
			int encodedBytes = 32768; // Reserve room for header/error/correlation metadata.
			bool room = true;
			var captured = new HashSet<int>();
			for (int i = 0; i < priority.Count && room; i++)
			{
				Transform owner = priority[i];
				if (!owner) continue;
				room = AppendObject(owner.gameObject, snapshot, ref encodedBytes);
				if (room) captured.Add(owner.gameObject.GetInstanceID());
			}
			while (room && stack.Count > 0)
			{
				Transform transform = stack.Pop();
				if (!transform) continue;
				// Prioritized owners retain their normal hierarchy traversal, without duplicate rows.
				for (int i = transform.childCount - 1; i >= 0; i--) stack.Push(transform.GetChild(i));
				if (!captured.Add(transform.gameObject.GetInstanceID())) continue;
				room = AppendObject(transform.gameObject, snapshot, ref encodedBytes);
			}
			ResolveCandidates(snapshot, errorTypes);
			watch.Stop();
			snapshot.captureMilliseconds = watch.Elapsed.TotalMilliseconds;
			return snapshot;
		}

		private static bool AppendObject(GameObject owner, PlaySessionSnapshot snapshot, ref int encodedBytes)
		{
			if (snapshot.objects.Count >= MaximumObjects) { Truncate(snapshot, "object_limit"); return false; }
			PlaySessionObject item = CaptureObject(owner, snapshot);
			int rowBytes = Encoding.UTF8.GetByteCount(JsonUtility.ToJson(item)) + 1;
			if (encodedBytes + rowBytes > MaximumSnapshotBytes) { Truncate(snapshot, "snapshot_byte_limit"); return false; }
			encodedBytes += rowBytes;
			snapshot.objects.Add(item);
			return true;
		}

		private static List<Transform> PriorityOwners(List<GameObject> roots, Dictionary<string, int> names, PlaySessionSnapshot snapshot)
		{
			var result = new List<Transform>();
			var ranks = new List<int>();
			if (snapshot.contextInstanceId != 0)
			{
				Object context = EditorUtility.InstanceIDToObject(snapshot.contextInstanceId);
				Component component = context as Component;
				GameObject owner = component ? component.gameObject : context as GameObject;
				if (owner && roots.Contains(owner.transform.root.gameObject))
				{
					AddRanked(result, ranks, owner.transform, int.MinValue, snapshot);
					snapshot.contextPrioritized = true;
				}
			}
			if (names.Count == 0) return result;
			var stack = new Stack<Transform>();
			var components = new List<Component>();
			for (int i = roots.Count - 1; i >= 0; i--) stack.Push(roots[i].transform);
			int scanned = 0;
			while (stack.Count > 0)
			{
				if (++scanned > MaximumPriorityScanObjects) { Truncate(snapshot, "priority_scan_limit"); break; }
				Transform current = stack.Pop();
				if (!current) continue;
				components.Clear();
				current.gameObject.GetComponents(components);
				if (components.Count > MaximumComponentsPerObject) snapshot.candidatesTruncated = true;
				int rank = int.MaxValue;
				for (int i = 0; i < components.Count && i < MaximumComponentsPerObject; i++)
				{
					Component component = components[i];
					if (component) rank = Math.Min(rank, TypeRank(component.GetType().FullName, component.GetType().Name, names));
				}
				if (rank != int.MaxValue && !result.Contains(current)) AddRanked(result, ranks, current, rank, snapshot);
				for (int i = current.childCount - 1; i >= 0; i--) stack.Push(current.GetChild(i));
			}
			return result;
		}

		private static int CompareSibling(GameObject left, GameObject right)
		{
			return left.transform.GetSiblingIndex().CompareTo(right.transform.GetSiblingIndex());
		}

		private static PlaySessionObject CaptureObject(GameObject gameObject, PlaySessionSnapshot snapshot)
		{
			Transform transform = gameObject.transform;
			var item = new PlaySessionObject
			{
				instanceId = gameObject.GetInstanceID(), parentInstanceId = transform.parent ? transform.parent.gameObject.GetInstanceID() : 0,
				siblingIndex = transform.GetSiblingIndex(), childCount = transform.childCount, sceneHandle = gameObject.scene.handle,
				name = gameObject.name, sceneName = gameObject.scene.name, scenePath = gameObject.scene.path,
				layer = gameObject.layer, layerName = LayerMask.LayerToName(gameObject.layer), tag = gameObject.tag,
				activeSelf = gameObject.activeSelf, activeInHierarchy = gameObject.activeInHierarchy,
				position = transform.position, rotation = transform.rotation, localPosition = transform.localPosition,
				localRotation = transform.localRotation, localScale = transform.localScale
			};
			Component[] components = gameObject.GetComponents<Component>();
			for (int slot = 0; slot < components.Length; slot++)
			{
				if (slot >= MaximumComponentsPerObject || snapshot.capturedComponents >= MaximumComponents)
				{
					item.componentsTruncated = true;
					Truncate(snapshot, "component_limit");
					break;
				}
				Component component = components[slot];
				var row = new PlaySessionComponent { slot = slot, missingScript = !component };
				item.components.Add(row);
				snapshot.capturedComponents++;
				if (!component) continue;
				Type type = component.GetType();
				row.instanceId = component.GetInstanceID();
				row.type = type.FullName;
				Behaviour behaviour = component as Behaviour;
				Collider collider = component as Collider;
				Renderer renderer = component as Renderer;
				row.hasEnabled = behaviour || collider || renderer;
				row.enabled = behaviour ? behaviour.enabled : collider ? collider.enabled : renderer && renderer.enabled;
				MonoBehaviour script = component as MonoBehaviour;
				if (!script) continue;
				MonoScript source = MonoScript.FromMonoBehaviour(script);
				row.scriptPath = source ? AssetDatabase.GetAssetPath(source) : string.Empty;
				ReadReferences(script, row, snapshot);
				object[] requirements = type.GetCustomAttributes(typeof(RequireComponent), true);
				for (int r = 0; r < requirements.Length; r++)
				{
					var requirement = (RequireComponent)requirements[r];
					CheckRequired(gameObject, requirement.m_Type0, row);
					CheckRequired(gameObject, requirement.m_Type1, row);
					CheckRequired(gameObject, requirement.m_Type2, row);
				}
			}
			return item;
		}

		private static void CheckRequired(GameObject owner, Type required, PlaySessionComponent component)
		{
			if (required != null && !owner.GetComponent(required) && !component.missingRequiredComponents.Contains(required.FullName))
				component.missingRequiredComponents.Add(required.FullName);
		}

		private static void ReadReferences(MonoBehaviour component, PlaySessionComponent row, PlaySessionSnapshot snapshot)
		{
			using (var serialized = new SerializedObject(component))
			{
				SerializedProperty property = serialized.GetIterator();
				int visited = 0;
				while (property.NextVisible(true))
				{
					if (++visited > MaximumSerializedProperties) { row.referencesTruncated = true; Truncate(snapshot, "serialized_property_limit"); break; }
					if (property.propertyType != SerializedPropertyType.ObjectReference || property.propertyPath == "m_Script") continue;
					if (row.references.Count >= MaximumReferencesPerComponent || snapshot.capturedReferences >= MaximumReferences)
					{
						row.referencesTruncated = true;
						Truncate(snapshot, "reference_limit");
						break;
					}
					int instanceId = property.objectReferenceInstanceIDValue;
					row.references.Add(new PlaySessionReference
					{
						propertyPath = Limit(property.propertyPath, 512), instanceId = instanceId,
						state = property.objectReferenceValue ? "assigned" : instanceId == 0 ? "unassigned" : "missing"
					});
					snapshot.capturedReferences++;
				}
			}
		}

		private static Dictionary<string, int> ErrorTypes(PlaySessionError error)
		{
			var names = new Dictionary<string, int>(StringComparer.Ordinal);
			if (error == null) return names;
			ParseTypes(Limit(error.message, 2048), names);
			ParseTypes(Limit(error.stackTrace, 4096), names);
			return names;
		}

		private static void ParseTypes(string text, Dictionary<string, int> names)
		{
			string[] lines = text.Split('\n');
			for (int i = 0; i < lines.Length; i++)
			{
				string line = lines[i].Trim();
				UnassignedType(line, names);
				if (line.StartsWith("at ", StringComparison.Ordinal)) line = line.Substring(3);
				int mono = line.IndexOf("(Mono JIT Code)", StringComparison.Ordinal);
				if (mono >= 0)
				{
					line = line.Substring(mono + "(Mono JIT Code)".Length).TrimStart();
					if (line.StartsWith("[", StringComparison.Ordinal))
					{
						int sourceEnd = line.IndexOf(']');
						if (sourceEnd >= 0) line = line.Substring(sourceEnd + 1).TrimStart();
					}
				}
				int call = line.IndexOf('(');
				if (call < 0) continue;
				string callName = line.Substring(0, call).Trim();
				int method = Math.Max(callName.LastIndexOf('.'), callName.LastIndexOf(':'));
				if (method > 0)
				{
					string owner = callName.Substring(0, method);
					int coroutine = owner.IndexOf("/<", StringComparison.Ordinal);
					if (coroutine < 0) coroutine = owner.IndexOf("+<", StringComparison.Ordinal);
					if (coroutine >= 0) owner = owner.Substring(0, coroutine);
					AddType(owner, names);
				}
			}
		}

		private static void UnassignedType(string line, Dictionary<string, int> names)
		{
			const string header = "UnassignedReferenceException: The variable ";
			if (line.StartsWith("UnityEngine.", StringComparison.Ordinal)) line = line.Substring("UnityEngine.".Length);
			if (!line.StartsWith(header, StringComparison.Ordinal)) return;
			int owner = line.IndexOf(" of ", header.Length, StringComparison.Ordinal);
			int end = owner < 0 ? -1 : line.IndexOf(" has not been assigned.", owner + 4, StringComparison.Ordinal);
			if (owner <= header.Length || end <= owner + 4) return;
			string type = line.Substring(owner + 4, end - owner - 4);
			for (int i = 0; i < type.Length; i++)
				if (!(char.IsLetterOrDigit(type[i]) || type[i] == '_' || type[i] == '.' || type[i] == '+')) return;
			AddType(type, names);
		}

		private static bool UniversalEngineType(string type)
		{
			// Wrapper frames occur on almost every owner and cannot identify a candidate instance.
			return type == "UnityEngine.Object" || type == "UnityEngine.GameObject" || type == "UnityEngine.Component" ||
				type == "UnityEngine.Transform" || type == "UnityEngine.Behaviour" || type == "UnityEngine.MonoBehaviour" ||
				type == "UnityEngine.Debug" || type == "UnityEngine.Logger" || type == "UnityEngine.DebugLogHandler";
		}

		private static void AddType(string type, Dictionary<string, int> names)
		{
			type = type.Replace('+', '.');
			if (!UniversalEngineType(type) && !names.ContainsKey(type)) names.Add(type, names.Count);
		}

		private static int TypeRank(string type, string simple, Dictionary<string, int> names)
		{
			if (type == null || UniversalEngineType(type)) return int.MaxValue;
			type = type.Replace('+', '.');
			if (simple == null) simple = type.Substring(type.LastIndexOf('.') + 1);
			int fullRank, simpleRank;
			if (!names.TryGetValue(type, out fullRank)) fullRank = int.MaxValue;
			if (!names.TryGetValue(simple, out simpleRank)) simpleRank = int.MaxValue;
			return Math.Min(fullRank, simpleRank);
		}

		private static void AddRanked<T>(List<T> values, List<int> ranks, T value, int rank, PlaySessionSnapshot snapshot)
		{
			int position = 0;
			while (position < ranks.Count && ranks[position] <= rank) position++;
			if (values.Count == 64)
			{
				snapshot.candidatesTruncated = true;
				if (position == 64) return;
				values.RemoveAt(63); ranks.RemoveAt(63);
			}
			values.Insert(position, value); ranks.Insert(position, rank);
		}

		private struct Candidate { public int componentId; public int objectId; }

		private static void Correlate(PlaySessionSnapshot snapshot) { ResolveCandidates(snapshot, ErrorTypes(snapshot.error)); }

		private static void ResolveCandidates(PlaySessionSnapshot snapshot, Dictionary<string, int> names)
		{
			if (snapshot.error == null) return;
			var candidates = new List<Candidate>();
			var ranks = new List<int>();
			for (int i = 0; i < snapshot.objects.Count; i++)
			{
				PlaySessionObject item = snapshot.objects[i];
				if (snapshot.contextInstanceId != 0 && item.instanceId == snapshot.contextInstanceId) snapshot.contextObjectInstanceId = item.instanceId;
				for (int j = 0; j < item.components.Count; j++)
				{
					PlaySessionComponent component = item.components[j];
					if (snapshot.contextInstanceId != 0 && component.instanceId == snapshot.contextInstanceId) snapshot.contextObjectInstanceId = item.instanceId;
					if (component.missingScript) continue;
					int rank = TypeRank(component.type, null, names);
					if (rank == int.MaxValue) continue;
					if (snapshot.contextInstanceId != 0 && (component.instanceId == snapshot.contextInstanceId || item.instanceId == snapshot.contextInstanceId)) rank = int.MinValue;
					AddRanked(candidates, ranks, new Candidate { componentId = component.instanceId, objectId = item.instanceId }, rank, snapshot);
				}
			}
			for (int i = 0; i < candidates.Count; i++)
			{
				snapshot.candidateComponentIds.Add(candidates[i].componentId);
				if (!snapshot.candidateObjectIds.Contains(candidates[i].objectId)) snapshot.candidateObjectIds.Add(candidates[i].objectId);
			}
			if (snapshot.contextInstanceId != 0 && snapshot.contextObjectInstanceId == 0)
				snapshot.contextEvidence = "unity_log_context_not_captured";
			// Candidate component types identify possible instances, not the throwing object.
			if (snapshot.contextInstanceId == 0 && snapshot.candidateComponentIds.Count > 0 && snapshot.consoleMatches.Count == 0)
				snapshot.contextEvidence = "stack_type_candidates_only";
		}

		private static void Truncate(PlaySessionSnapshot snapshot, string reason)
		{
			snapshot.truncated = true;
			if (string.IsNullOrEmpty(snapshot.truncationReason)) snapshot.truncationReason = reason;
		}

		internal static string Limit(string value, int count)
		{
			value = value ?? string.Empty;
			return value.Length > count ? value.Substring(0, count) : value;
		}
	}

	internal static class NativeConsoleContext
	{
		private const string Key = "UnityCursorToolkit.PlaySessions.Console.";
		private const int MaximumRows = 256;

		internal static void BeginSession(string sessionId)
		{
			SessionState.SetString(Key + "SessionId", sessionId);
			int count = Count();
			SessionState.SetBool(Key + "Known", count >= 0);
			SessionState.SetInt(Key + "Start", count);
			SessionState.SetInt(Key + "LastCount", count);
			SessionState.SetInt(Key + "Epoch", 0);
			SessionState.SetBool(Key + "Reset", false);
		}

		internal static void ObserveReset()
		{
			int count = Count();
			if (count >= 0) ObserveCount(count);
		}

		private static void ObserveCount(int count)
		{
			int previous = SessionState.GetInt(Key + "LastCount", -1);
			if (SessionState.GetBool(Key + "Known", false) && previous >= 0 && count < previous)
			{
				// Clear-on-Play, manual Clear or filtering can reduce indices. They invalidate the old index epoch.
				SessionState.SetInt(Key + "Start", 0);
				SessionState.SetInt(Key + "Epoch", SessionState.GetInt(Key + "Epoch", 0) + 1);
				SessionState.SetBool(Key + "Reset", true);
			}
			SessionState.SetInt(Key + "LastCount", count);
		}

		private static int Count()
		{
			Type entries = typeof(EditorApplication).Assembly.GetType("UnityEditor.LogEntries");
			MethodInfo count = entries == null ? null : entries.GetMethod("GetCount", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
			if (count == null) return -1;
			try
			{
				object value = count.Invoke(null, null);
				return value is int ? (int)value : -1;
			}
			catch (TargetInvocationException) { return -1; }
		}

		internal static int Find(PlaySessionError error, PlaySessionSnapshot snapshot)
		{
			snapshot.contextEvidence = "native_context_unavailable";
			snapshot.consoleSessionId = SessionState.GetString(Key + "SessionId", string.Empty);
			snapshot.consoleRangeKnown = SessionState.GetBool(Key + "Known", false) && snapshot.consoleSessionId == snapshot.sessionId;
			if (!snapshot.consoleRangeKnown) { snapshot.consoleScope = "session_console_boundary_unavailable"; return 0; }
			const BindingFlags flags = BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic;
			System.Reflection.Assembly editor = typeof(EditorApplication).Assembly;
			Type entries = editor.GetType("UnityEditor.LogEntries");
			Type entry = editor.GetType("UnityEditor.LogEntry");
			if (entries == null || entry == null) return 0;
			MethodInfo count = entries.GetMethod("GetCount", flags);
			MethodInfo start = entries.GetMethod("StartGettingEntries", flags, null, Type.EmptyTypes, null);
			MethodInfo end = entries.GetMethod("EndGettingEntries", flags, null, Type.EmptyTypes, null);
			MethodInfo get = entries.GetMethod("GetEntryInternal", flags, null, new[] { typeof(int), entry }, null);
			FieldInfo message = entry.GetField("message", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
			FieldInfo context = entry.GetField("instanceID", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
			if (count == null || start == null || end == null || get == null || message == null || context == null) return 0;
			try
			{
				var rows = new List<ConsoleRow>();
				start.Invoke(null, null);
				try
				{
					int total = (int)count.Invoke(null, null);
					ObserveCount(total);
					snapshot.consoleStartIndex = SessionState.GetInt(Key + "Start", -1);
					snapshot.consoleEndIndex = total;
					snapshot.consoleEpoch = SessionState.GetInt(Key + "Epoch", 0);
					snapshot.consoleResetDetected = SessionState.GetBool(Key + "Reset", false);
					snapshot.consoleScope = "current_session_index_range; reset detection covers count decreases only";
					snapshot.consoleScannedFrom = Math.Max(snapshot.consoleStartIndex, total - MaximumRows);
					snapshot.consoleWindowTruncated = snapshot.consoleScannedFrom > snapshot.consoleStartIndex;
					for (int index = snapshot.consoleScannedFrom; index < total; index++)
					{
						object row = Activator.CreateInstance(entry, true);
						object fetched = get.Invoke(null, new[] { (object)index, row });
						if (fetched is bool && !(bool)fetched) continue;
						object id = context.GetValue(row);
						rows.Add(new ConsoleRow { index = index, instanceId = id is int ? (int)id : 0, text = message.GetValue(row) as string });
					}
				}
				finally { end.Invoke(null, null); }
				MatchRows(rows, error, snapshot);
				// The threaded callback provides no native occurrence identifier. These rows are candidates, never exact context.
				return 0;
			}
			catch (TargetInvocationException)
			{
				snapshot.contextEvidence = "native_context_api_failed";
				return 0;
			}
		}

		internal sealed class ConsoleRow
		{
			public int index;
			public int instanceId;
			public string text;
		}

		internal static void MatchRows(List<ConsoleRow> rows, PlaySessionError error, PlaySessionSnapshot snapshot)
		{
			snapshot.contextEvidence = "unresolved";
			snapshot.contextInstanceId = 0;
			snapshot.contextPrioritized = false;
			string expected = Normalize(error.message);
			string expectedStack = Normalize(error.stackTrace).Trim();
			for (int i = 0; i < rows.Count; i++)
			{
				ConsoleRow row = rows[i];
				if (row.index < snapshot.consoleStartIndex || row.index >= snapshot.consoleEndIndex) continue;
				string text = Normalize(row.text);
				if (!(text == expected || text.StartsWith(expected + "\n", StringComparison.Ordinal))) continue;
				string nativeStack = text.Length > expected.Length ? text.Substring(expected.Length).Trim() : string.Empty;
				string compatible = error.textTruncated ? "callback_truncated" : nativeStack.Length == 0 || expectedStack.Length == 0 ? "unavailable" :
					nativeStack == expectedStack || nativeStack.StartsWith(expectedStack + "\n", StringComparison.Ordinal) ? "matched" : "different";
				snapshot.consoleMessageMatchCount++;
				if (snapshot.consoleMatches.Count == 16) { snapshot.consoleMatches.RemoveAt(0); snapshot.consoleMatchesTruncated = true; }
				snapshot.consoleMatches.Add(new PlaySessionConsoleMatch { index = row.index, instanceId = row.instanceId, stackCompatibility = compatible });
			}
			if (snapshot.consoleMatches.Count == 0) return;
			PlaySessionConsoleMatch latest = snapshot.consoleMatches[snapshot.consoleMatches.Count - 1];
			snapshot.matchedConsoleIndex = latest.index;
			if (latest.instanceId == 0) snapshot.contextEvidence = "native_latest_match_contextless";
			else if (latest.stackCompatibility != "matched") snapshot.contextEvidence = "native_latest_match_stack_unproven";
			else snapshot.contextEvidence = snapshot.consoleMessageMatchCount == 1 ? "native_console_candidate_only" : "native_occurrence_ambiguous";
		}

		private static string Normalize(string value) { return (value ?? string.Empty).Replace("\r\n", "\n").Replace('\r', '\n'); }
	}
}
#endif
