#if UNITY_EDITOR

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Reflection;
using System.IO;
using UnityEditor;
using UnityEditor.Compilation;
using UnityCursorToolkit.MCP;

namespace UnityCursorToolkit.Core
{
	/// <summary>Opt-in fingerprints and latest-only transition diffs; no raw values or disk persistence.</summary>
	[InitializeOnLoad]
	internal static class StaticSnapshotter
	{
		private static StaticSnapshotState State => StaticSnapshotState.instance;
		private static int maxFields => State.maxFields;
		private static int maxScanMilliseconds => State.maxScanMilliseconds;
		internal static int Revision { get; private set; }
		internal static Snapshot Latest
		{
			get => State.latestSnapshot;
			private set
			{
				State.latestSnapshot = value;
				Revision++;
			}
		}
		internal static Diff LatestDiff => State.latestDiff;
		internal static bool Enabled => State.enabled;

		static StaticSnapshotter()
		{
			#if !UNITY_7000_0_OR_NEWER
			InitializeLifecycle();
			#endif
		}

		#if UNITY_7000_0_OR_NEWER
		[Unity.Scripting.LifecycleManagement.OnCodeInitializing]
		#endif
		internal static void InitializeLifecycle()
		{
			#if UNITY_2020_2_OR_NEWER
			if (AssetDatabase.IsAssetImportWorkerProcess()) return;
			#endif
			DetachHooks();
			if (!Enabled) return;
			EditorApplication.playModeStateChanged += OnPlayModeStateChanged;
			EditorApplication.quitting += OnEditorQuitting;
			CompilationPipeline.compilationStarted += OnCompilationStarted;
		}

		#if UNITY_7000_0_OR_NEWER
		[Unity.Scripting.LifecycleManagement.OnCodeUnloading]
		#endif
		internal static void DetachHooks()
		{
			EditorApplication.playModeStateChanged -= OnPlayModeStateChanged;
			EditorApplication.quitting -= OnEditorQuitting;
			CompilationPipeline.compilationStarted -= OnCompilationStarted;
		}

		internal static void Disable()
		{
			DetachHooks();
			var state = State;
			state.enabled = false;
			state.assemblyNames = state.assemblyVersions = Array.Empty<string>();
			Latest = null;
			state.latestDiff = null;
			state.previousTransition = "";
		}

		private static void OnEditorQuitting()
		{
			Disable();
			UnityEngine.Object.DestroyImmediate(State);
		}

		// A new compilation invalidates the loaded binary identities selected by the user.
		private static void OnCompilationStarted(object context)
		{
			Disable();
			Latest = new Snapshot { skippedReason = "compilation_changed" };
		}

		/// <summary>Begin a new Editor capture with exact project assembly names and bounded scans.</summary>
		internal static void Configure(string[] names, int fields, int milliseconds)
		{
			Disable();
			if (names == null || names.Length == 0 || names.Length > 128 || fields < 1 || fields > 1000
				|| milliseconds < 1 || milliseconds > 100)
			{
				Latest = new Snapshot { skippedReason = "invalid_configuration" };
				return;
			}

			var allowed = new HashSet<string>(StringComparer.Ordinal);
			char[] invalidNameCharacters = { '/', '\\', '\r', '\n', '\0' };
			foreach (string name in names)
			{
				if (string.IsNullOrWhiteSpace(name) || name.Length > 128 || name.IndexOfAny(invalidNameCharacters) >= 0)
				{
					Latest = new Snapshot { skippedReason = "invalid_configuration" };
					return;
				}
				allowed.Add(name);
			}
			if (EditorApplication.isCompiling || EditorApplication.isUpdating)
			{
				Latest = new Snapshot { skippedReason = "editor_busy" };
				return;
			}

			// CompilationPipeline materializes all source paths. Do this once on explicit opt-in.
			const int discoveryLimitMs = 500;
			var timer = Stopwatch.StartNew();
			var outputs = StaticInventoryTool.GetUserAssemblyOutputs(timer, discoveryLimitMs, out bool truncated);
			var comparison = Path.DirectorySeparatorChar == '\\' ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
			var selectedNames = new List<string>();
			var selectedVersions = new List<string>();
			foreach (System.Reflection.Assembly assembly in AssemblyEnumerator.GetLoaded())
			{
				string name = assembly.GetName().Name;
				if (allowed.Contains(name) && outputs.TryGetValue(name, out string output) && !assembly.IsDynamic
					&& !string.IsNullOrEmpty(assembly.Location) && string.Equals(Path.GetFullPath(assembly.Location), output, comparison))
				{
					selectedNames.Add(name);
					selectedVersions.Add(assembly.ManifestModule.ModuleVersionId.ToString());
				}
			}
			if (truncated || timer.ElapsedMilliseconds >= discoveryLimitMs)
			{
				Latest = new Snapshot { skippedReason = "assembly_discovery_budget" };
				return;
			}
			if (selectedNames.Count == 0)
			{
				Latest = new Snapshot { skippedReason = "no_eligible_assemblies" };
				return;
			}

			var state = State;
			state.assemblyNames = selectedNames.ToArray();
			state.assemblyVersions = selectedVersions.ToArray();
			state.maxFields = fields;
			state.maxScanMilliseconds = milliseconds;
			state.enabled = true;
			InitializeLifecycle();
			Capture();
		}

		private static void OnPlayModeStateChanged(PlayModeStateChange transition)
		{
			var state = State;
			Snapshot before = string.IsNullOrEmpty(state.previousTransition) ? null : Latest;
			Snapshot after = Capture();
			string nextTransition = transition.ToString();
			state.latestDiff = Compare(before, after, state.previousTransition, nextTransition);
			state.previousTransition = nextTransition;
		}

		internal static Snapshot Capture()
		{
			if (!Enabled) return null;
			var result = new Snapshot();
			var timer = Stopwatch.StartNew();
			try
			{
				var state = State;
				int matched = 0;
				foreach (System.Reflection.Assembly assembly in AssemblyEnumerator.GetLoaded())
				{
					if (Expired(timer)) return Skip(result, timer, "time_budget");
					string name = assembly.GetName().Name;
					int index = Array.IndexOf(state.assemblyNames, name);
					if (index < 0 || assembly.ManifestModule.ModuleVersionId.ToString() != state.assemblyVersions[index]) continue;
					matched++;
					// Unity reflection calls cannot be preempted; check the cooperative budget afterwards too.
					var types = assembly.GetTypes();
					if (Expired(timer)) return Skip(result, timer, "time_budget");
					foreach (var type in types)
					{
						if (Expired(timer)) return Skip(result, timer, "time_budget");
						var fields = type.GetFields(BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly);
						if (Expired(timer)) return Skip(result, timer, "time_budget");
						foreach (var field in fields)
						{
							if (Expired(timer)) return Skip(result, timer, "time_budget");
							var entry = new Entry { assembly = name, type = type.FullName ?? type.Name, field = field.Name };
							if (entry.assembly.Length > 128 || entry.type.Length > 512 || entry.field.Length > 512) return Skip(result, timer, "identity_limit");
							Read(field, entry);
							if (Expired(timer)) return Skip(result, timer, "time_budget");
							result.fields.Add(entry);
							if (result.fields.Count >= maxFields) return Skip(result, timer, "field_cap");
						}
					}
				}
				if (matched != state.assemblyNames.Length) return Skip(result, timer, "assembly_identity_changed");
				result.complete = true;
				return Finish(result, timer);
			}
			catch { return Skip(result, timer, "reflection_unavailable"); }
		}

		private static bool Expired(Stopwatch timer) => timer.Elapsed.TotalMilliseconds >= maxScanMilliseconds;

		private static Snapshot Skip(Snapshot result, Stopwatch timer, string reason)
		{
			result.fields.Clear();
			result.complete = false;
			result.skippedReason = reason;
			if (reason == "field_cap" || reason == "time_budget")
				UnityEngine.Debug.LogWarning("{\"command\":\"staticsWarning\",\"code\":\"" + reason + "\",\"message\":\"Static snapshot skipped at its cooperative budget.\"}");
			return Finish(result, timer);
		}

		private static Snapshot Finish(Snapshot result, Stopwatch timer)
		{
			result.durationMs = timer.Elapsed.TotalMilliseconds;
			Latest = result;
			return result;
		}

		private static void Read(FieldInfo field, Entry entry)
		{
			try
			{
				if (field.DeclaringType.ContainsGenericParameters) { entry.unreadableReason = "open_generic_type"; return; }
				// GetValue may run a user static initializer even if the field was read before.
				if (!field.IsLiteral && field.DeclaringType.TypeInitializer != null) { entry.unreadableReason = "static_initializer"; return; }
				foreach (var attribute in CustomAttributeData.GetCustomAttributes(field))
					if (attribute.AttributeType == typeof(ThreadStaticAttribute)) { entry.unreadableReason = "thread_static"; return; }
				object value = field.IsLiteral ? field.GetRawConstantValue() : field.GetValue(null);
				if (value == null) { entry.fingerprint = "null"; return; }
				Type type = value.GetType();
				byte[] bytes;
				if (type == typeof(string))
				{
					string text = (string)value;
					if (text.Length > 4096) { entry.unreadableReason = "value_too_large"; return; }
					bytes = new byte[text.Length * 2];
					for (int i = 0; i < text.Length; i++) { bytes[i * 2] = (byte)text[i]; bytes[i * 2 + 1] = (byte)(text[i] >> 8); }
				}
				else if (type.IsArray) { entry.fingerprint = "array-count:" + ((Array)value).LongLength.ToString(System.Globalization.CultureInfo.InvariantCulture); return; }
				else if (type == typeof(bool)) bytes = new[] { (byte)((bool)value ? 1 : 0) };
				else if (type == typeof(byte)) bytes = new[] { (byte)value };
				else if (type == typeof(sbyte)) bytes = new[] { unchecked((byte)(sbyte)value) };
				else if (type == typeof(char)) bytes = BitConverter.GetBytes((char)value);
				else if (type == typeof(short)) bytes = BitConverter.GetBytes((short)value);
				else if (type == typeof(ushort)) bytes = BitConverter.GetBytes((ushort)value);
				else if (type == typeof(int)) bytes = BitConverter.GetBytes((int)value);
				else if (type == typeof(uint)) bytes = BitConverter.GetBytes((uint)value);
				else if (type == typeof(long)) bytes = BitConverter.GetBytes((long)value);
				else if (type == typeof(ulong)) bytes = BitConverter.GetBytes((ulong)value);
				else if (type == typeof(float)) bytes = BitConverter.GetBytes((float)value);
				else if (type == typeof(double)) bytes = BitConverter.GetBytes((double)value);
				else { entry.unreadableReason = "unsupported_type"; return; }
				// Fixed FNV-1a over bounded scalar bytes; never call a value's virtual methods.
				ulong hash = 14695981039346656037UL;
				foreach (byte item in bytes) { hash ^= item; hash = unchecked(hash * 1099511628211UL); }
				entry.fingerprint = type.FullName + ":fnv64:" + hash.ToString("x16", System.Globalization.CultureInfo.InvariantCulture);
			}
			catch { entry.unreadableReason = "field_read_failed"; }
		}

		internal static Diff Compare(Snapshot before, Snapshot after, string beforeTransition, string transition)
		{
			var result = new Diff { beforeTransition = beforeTransition ?? "", transition = transition ?? "" };
			if (before == null) { result.incompleteReason = "missing_before"; return result; }
			if (after == null) { result.incompleteReason = "missing_after"; return result; }
			bool consecutive = beforeTransition == "ExitingEditMode" && transition == "EnteredPlayMode"
				|| beforeTransition == "EnteredPlayMode" && transition == "ExitingPlayMode"
				|| beforeTransition == "ExitingPlayMode" && transition == "EnteredEditMode"
				|| beforeTransition == "EnteredEditMode" && transition == "ExitingEditMode";
			if (!consecutive) { result.incompleteReason = "transition_gap"; return result; }
			if (!before.complete || !after.complete) { result.incompleteReason = "snapshot_skipped"; return result; }
			if (before.fields == null || after.fields == null || before.fields.Count > 1000 || after.fields.Count > 1000)
			{ result.incompleteReason = "invalid_snapshot"; return result; }
			var left = new Dictionary<string, Entry>(StringComparer.Ordinal);
			var right = new Dictionary<string, Entry>(StringComparer.Ordinal);
			for (int side = 0; side < 2; side++)
			{
				var index = side == 0 ? left : right;
				foreach (var entry in side == 0 ? before.fields : after.fields)
				{
					if (entry == null || string.IsNullOrEmpty(entry.assembly) || string.IsNullOrEmpty(entry.type) || string.IsNullOrEmpty(entry.field)
						|| entry.assembly.Length > 128 || entry.type.Length > 512 || entry.field.Length > 512
						|| string.IsNullOrEmpty(entry.fingerprint) && string.IsNullOrEmpty(entry.unreadableReason))
					{ result.incompleteReason = "invalid_snapshot"; return result; }
					string key = entry.assembly + "\0" + entry.type + "\0" + entry.field;
					if (index.ContainsKey(key)) { result.incompleteReason = "invalid_snapshot"; return result; }
					index.Add(key, entry);
				}
			}
			var keys = new SortedSet<string>(left.Keys, StringComparer.Ordinal); keys.UnionWith(right.Keys);
			foreach (var key in keys)
			{
				Entry previous, current; left.TryGetValue(key, out previous); right.TryGetValue(key, out current);
				var identity = current ?? previous;
				result.fields.Add(new Difference {
					assembly = identity.assembly, type = identity.type, field = identity.field,
					beforeUnreadableReason = previous?.unreadableReason ?? "", afterUnreadableReason = current?.unreadableReason ?? "",
					classification = !string.IsNullOrEmpty(previous?.unreadableReason) || !string.IsNullOrEmpty(current?.unreadableReason)
						? "unreadable" : previous == null ? "added" : current == null ? "removed"
						: previous.fingerprint == current.fingerprint ? "carried" : "reset"
				});
			}
			result.complete = true;
			return result;
		}

		[Serializable]
		internal sealed class Diff
		{
			public bool complete;
			public string incompleteReason = "";
			public string beforeTransition = "";
			public string transition = "";
			public List<Difference> fields = new List<Difference>();
		}

		[Serializable]
		internal sealed class Difference
		{
			public string assembly, type, field, classification;
			public string beforeUnreadableReason, afterUnreadableReason;
		}

		[Serializable]
		internal sealed class Snapshot
		{
			public bool complete;
			public string skippedReason = "";
			public double durationMs;
			public List<Entry> fields = new List<Entry>();
		}

		[Serializable]
		internal sealed class Entry
		{
			public string assembly;
			public string type;
			public string field;
			public string fingerprint = "";
			public string unreadableReason = "";
		}
	}
}

#endif
