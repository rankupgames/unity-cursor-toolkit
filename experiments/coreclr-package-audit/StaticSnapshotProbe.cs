// Executes only in an owned disposable copy of the sample. No user Editor or license changes.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using UnityEditor;
using UnityEngine;

public static class SnapshotSentinel { public static int InitializerCalls; public static int GetterCalls; }
public static class SnapshotValues { public static int Number; public static string Text; public static int[] Items; public static object Custom; public static string Large; }
public static class SnapshotDanger { public static int Number; static SnapshotDanger() { SnapshotSentinel.InitializerCalls++; Number = 73; } }
public sealed class SnapshotCustomCollection : ICollection
{
	public int Count { get { SnapshotSentinel.GetterCalls++; throw new InvalidOperationException(); } }
	public bool IsSynchronized => false;
	public object SyncRoot => this;
	public void CopyTo(Array target, int index) { throw new InvalidOperationException(); }
	public IEnumerator GetEnumerator() { throw new InvalidOperationException(); }
	public override string ToString() { SnapshotSentinel.GetterCalls++; throw new InvalidOperationException(); }
	public override int GetHashCode() { SnapshotSentinel.GetterCalls++; throw new InvalidOperationException(); }
}

[InitializeOnLoad]
public static class StaticSnapshotProbe
{
	private static readonly BindingFlags Flags = BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic;
	private static Type Collector;
	private static string FailedCheck = "snapshot_backend";
	private static readonly List<string> Checks = new List<string>();
	private static readonly string Evidence = Environment.GetEnvironmentVariable("UCT_LIFECYCLE_EVIDENCE_PATH");
	private static readonly int Pid = System.Diagnostics.Process.GetCurrentProcess().Id;

	static StaticSnapshotProbe()
	{
		if (Environment.GetEnvironmentVariable("UCT_STATICS_TRANSITION_PROOF") != "1") return;
		EditorApplication.update += PumpTransitions;
		EditorApplication.playModeStateChanged += ObserveTransition;
	}

	public static void Run()
	{
		if (Environment.GetEnvironmentVariable("UCT_STATICS_TRANSITION_PROOF") == "1") { BeginTransitions(); return; }
		RunSnapshot();
	}

	private static void RunSnapshot()
	{
		bool passed = false;

		try
		{
			Require(File.Exists(Evidence + ".owner") && File.ReadAllText(Evidence + ".owner") == Pid.ToString(), "owner");
			foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies()) if (assembly.GetName().Name == "UnityCursorToolkit.Editor") Collector = assembly.GetType("UnityCursorToolkit.Core.StaticSnapshotter", false);
			Require(Collector != null, "snapshot_foundation");
			CheckDifferences();
			Configure("{\"enabled\":false}"); Require(Latest() == null && Capture() == null, "disabled_no_snapshot");
			foreach (var invalid in new[] { "null", "1", "\"true\"", "[]", "{}" })
			{
				Configure("{\"enabled\":" + invalid + "}");
				Require(Reason(Latest()) == "invalid_configuration" && Capture() == null, "invalid_enabled_refused");
			}
			SnapshotValues.Number = 31; SnapshotValues.Text = "snapshot fixture value"; SnapshotValues.Items = new int[3];
			SnapshotValues.Custom = new SnapshotCustomCollection(); SnapshotValues.Large = new string('x', 4097);
			string editorAssembly = typeof(SnapshotValues).Assembly.GetName().Name;
			string runtimeAssembly = "Assembly-CSharp";
			string allowlist = "[\"" + runtimeAssembly + "\",\"" + editorAssembly + "\",\"UnityEngine.CoreModule\",\"mscorlib\",\"UnityCursorToolkit.Editor\"]";
			Configure(Settings(allowlist, 1000, 100));
			object before = Latest();
			for (int attempt = 0; !Complete(before) && attempt < 3; attempt++) before = Capture();
			Require(Complete(before), "complete_owned_snapshot");
			foreach (var field in Fields(before)) Require(Read(field, "assembly").ToString() != "UnityEngine.CoreModule" && Read(field, "assembly").ToString() != "mscorlib" && Read(field, "assembly").ToString() != "UnityCursorToolkit.Editor", "source_ownership_excludes_system_engine_package");
			string original = Fingerprint(before, "SnapshotValues", "Number");
			Require(original == Fingerprint(Capture(), "SnapshotValues", "Number"), "unchanged_fingerprint_stable");
			SnapshotValues.Number++; Require(original != Fingerprint(Capture(), "SnapshotValues", "Number"), "changed_fingerprint_changes");
			Require(Fingerprint(before, "SnapshotValues", "Items") == "array-count:3", "array_count");
			SnapshotValues.Items = new int[4]; Require(Fingerprint(Capture(), "SnapshotValues", "Items") == "array-count:4", "array_count_changes");
			SnapshotValues.Text = null; Require(Fingerprint(Capture(), "SnapshotValues", "Text") == "null", "null_fingerprint");
			Require(Unreadable(before, "SnapshotDanger", "Number") == "static_initializer" && SnapshotSentinel.InitializerCalls == 0, "no_user_initializer");
			Require(Unreadable(before, "SnapshotValues", "Custom") == "unsupported_type" && SnapshotSentinel.GetterCalls == 0, "no_user_collection_or_virtual_methods");
			Require(Unreadable(before, "SnapshotValues", "Large") == "value_too_large", "bounded_string");
			int warnings = 0;
			Application.LogCallback warning = (message, stack, type) => { if (type == LogType.Warning && message.Contains("\"command\":\"staticsWarning\"")) warnings++; };
			Application.logMessageReceived += warning;
			try
			{
				Configure(Settings("[\"UCT.StaticsExactProof\"]", 1, 100));
				Require(!Complete(Latest()) && Reason(Latest()) == "field_cap" && Fields(Latest()).Count == 0 && warnings == 1, "reaching_cap_discards_and_warns_once");
				warnings = 0;
				Configure(Settings(allowlist, 1, 100));
				Require(!Complete(Latest()) && Reason(Latest()) == "field_cap" && Fields(Latest()).Count == 0 && warnings == 1, "cap_discards_partial_and_warns_once");
				warnings = 0; Configure(Settings("[\"UCT.StaticsBudgetProof\"]", 1000, 1));
				Require(!Complete(Latest()) && Reason(Latest()) == "time_budget" && Fields(Latest()).Count == 0 && warnings == 1, "time_budget_discards_partial_and_warns_once");
			}
			finally { Application.logMessageReceived -= warning; }
			var measurements = new List<string>();
			for (int sample = 0; sample < 10; sample++)
			{
				var wall = Stopwatch.StartNew(); Configure(Settings(allowlist, 1000, 10)); wall.Stop();
				var snapshot = Latest();
				measurements.Add("{\"scanDurationMs\":" + ((double)Read(snapshot, "durationMs")).ToString(System.Globalization.CultureInfo.InvariantCulture)
					+ ",\"totalConfigureMilliseconds\":" + wall.Elapsed.TotalMilliseconds.ToString(System.Globalization.CultureInfo.InvariantCulture)
					+ ",\"complete\":" + (Complete(snapshot) ? "true" : "false") + ",\"skippedReason\":\"" + Reason(snapshot) + "\",\"fieldCount\":" + Fields(snapshot).Count + "}");
			}
			Configure("{\"enabled\":false}"); Require(Latest() == null && Capture() == null, "hard_off_clears_latest");
			File.AppendAllText(Evidence, "{\"callback\":\"snapshotMeasurement\",\"pid\":" + Pid + ",\"editorVersion\":\"" + Application.unityVersion + "\",\"checks\":[\"" + string.Join("\",\"", Checks.ToArray()) + "\"],\"samples\":[" + string.Join(",", measurements.ToArray()) + "]}\n");
			passed = true;
		}
		catch
		{
			object snapshot = Collector != null ? Latest() : null;
			string reason = snapshot == null ? "none" : Reason(snapshot);
			if (reason != "" && reason != "field_cap" && reason != "time_budget" && reason != "invalid_configuration" && reason != "reflection_unavailable" && reason != "identity_limit") reason = "unknown";
			File.AppendAllText(Evidence, "{\"callback\":\"snapshotFailure\",\"pid\":" + Pid + ",\"check\":\"" + FailedCheck + "\",\"snapshotReason\":\"" + reason + "\",\"fieldCount\":" + (snapshot == null ? 0 : Fields(snapshot).Count) + "}\n");
		}
		finally
		{
			if (Collector != null) Configure("{\"enabled\":false}");
			File.AppendAllText(Evidence, "{\"callback\":\"complete\",\"pid\":" + Pid + ",\"passed\":" + (passed ? "true" : "false") + "}\n");
			EditorApplication.Exit(passed ? 0 : 1);
		}
	}

	[Serializable] private sealed class ProofEvent
	{
		public string callback, round, transition;
		public int phase, pid, originalOptions;
		public bool originalOptionsEnabled, complete;
	}
	private static void Record(string json) { File.AppendAllText(Evidence, json + "\n"); }
	private static List<ProofEvent> ProofEvents()
	{
		var result = new List<ProofEvent>();
		if (!File.Exists(Evidence)) return result;
		foreach (var line in File.ReadAllLines(Evidence)) { var value = JsonUtility.FromJson<ProofEvent>(line); if (value != null && value.pid == Pid) result.Add(value); }
		return result;
	}
	private static int Phase(List<ProofEvent> events) { int phase = -1; foreach (var item in events) if (item.callback == "transitionPhase") phase = item.phase; return phase; }
	private static string Round(int phase) { return phase < 3 ? "fast" : phase < 6 ? "cap" : "mono"; }
	private static void SetPhase(int phase) { Record("{\"callback\":\"transitionPhase\",\"pid\":" + Pid + ",\"phase\":" + phase + "}"); }
	private static object Report() { return Collector.GetProperty("LatestDiff", Flags).GetValue(null, null); }
	private static void FindCollector()
	{
		if (Collector != null) return;
		foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies()) if (assembly.GetName().Name == "UnityCursorToolkit.Editor") Collector = assembly.GetType("UnityCursorToolkit.Core.StaticSnapshotter", false);
		Require(Collector != null, "snapshot_foundation");
	}
	private static void BeginTransitions()
	{
		try
		{
			Require(File.Exists(Evidence + ".owner") && File.ReadAllText(Evidence + ".owner") == Pid.ToString(), "owner");
			FindCollector(); CheckDifferences();
			Record("{\"callback\":\"transitionStart\",\"pid\":" + Pid + ",\"originalOptionsEnabled\":" + (EditorSettings.enterPlayModeOptionsEnabled ? "true" : "false") + ",\"originalOptions\":" + (int)EditorSettings.enterPlayModeOptions + "}");
			EditorSettings.enterPlayModeOptionsEnabled = true;
			EditorSettings.enterPlayModeOptions = EnterPlayModeOptions.DisableDomainReload | EnterPlayModeOptions.DisableSceneReload;
			Configure(Settings("[\"Assembly-CSharp\"]", 1000, 100)); StaticTransitionValues.Bug = 31; StaticTransitionValues.Reset = 31;
			EditorApplication.playModeStateChanged -= ObserveTransition; EditorApplication.playModeStateChanged += ObserveTransition;
			SetPhase(0); EditorApplication.isPlaying = true;
		}
		catch { FinishTransitions(false); }
	}
	private static void ObserveTransition(PlayModeStateChange transition)
	{
		try
		{
			var events = ProofEvents(); int phase = Phase(events); if (phase < 0) return;
			Record("{\"callback\":\"transitionObserved\",\"pid\":" + Pid + ",\"round\":\"" + Round(phase) + "\",\"transition\":\"" + transition + "\"}");
			FindCollector(); RecordReport(events, phase, transition.ToString());
		}
		catch { FinishTransitions(false); }
	}
	private static void RecordReport(List<ProofEvent> events, int phase, string transition)
	{
		foreach (var item in events) if (item.callback == "transitionReport" && item.round == Round(phase) && item.transition == transition) return;
		object report = Report(); if (report == null || (string)Read(report, "transition") != transition) return;
		string extra = "";
		if (Complete(report)) foreach (var name in new[] { "Bug", "Reset" })
		{
			var entry = Entry(report, "StaticTransitionValues", name);
			extra += ",\"" + name.ToLowerInvariant() + "Classification\":\"" + (string)Read(entry, "classification") + "\"";
		}
		Record("{\"callback\":\"transitionReport\",\"pid\":" + Pid + ",\"round\":\"" + Round(phase) + "\",\"transition\":\"" + transition + "\",\"beforeTransition\":\"" + (string)Read(report, "beforeTransition")
			+ "\",\"complete\":" + (Complete(report) ? "true" : "false") + ",\"incompleteReason\":\"" + (string)Read(report, "incompleteReason") + "\",\"fieldCount\":" + Fields(report).Count + extra + "}");
	}
	private static void CheckRound(List<ProofEvent> events, string round)
	{
		foreach (var transition in new[] { "ExitingEditMode", "EnteredPlayMode", "ExitingPlayMode", "EnteredEditMode" })
		{
			Require(events.Exists(x => x.callback == "transitionObserved" && x.round == round && x.transition == transition), "four_" + round + "_callbacks");
			Require(events.Exists(x => x.callback == "transitionReport" && x.round == round && x.transition == transition), "four_" + round + "_reports");
		}
	}
	private static void PumpTransitions()
	{
		if (!File.Exists(Evidence + ".owner") || File.ReadAllText(Evidence + ".owner") != Pid.ToString()) return;
		try
		{
			var events = ProofEvents(); int phase = Phase(events); if (phase < 0) return;
			if (File.Exists(Evidence + ".stop")) { if (EditorApplication.isPlaying) EditorApplication.isPlaying = false; else FinishTransitions(false); return; }
			FindCollector();
			if (phase == 0 || phase == 3 || phase == 6)
			{
				if (!EditorApplication.isPlaying || !events.Exists(x => x.callback == "transitionObserved" && x.round == Round(phase) && x.transition == "EnteredPlayMode")) return;
				RecordReport(events, phase, "EnteredPlayMode"); object report = Report();
				Require(report != null && (string)Read(report, "transition") == "EnteredPlayMode", "entered_report");
				if (phase == 3) Require(!Complete(report) && Fields(report).Count == 0, "cap_report_incomplete");
				else
				{
					Require(Complete(report), "entered_complete");
					Require((string)Read(Entry(report, "StaticTransitionValues", "Bug"), "classification") == (phase == 0 ? "carried" : "reset"), phase == 0 ? "fast_bug_carried" : "mono_reset_observed");
					Require((string)Read(report, "beforeTransition") == "ExitingEditMode", "before_survives_reload");
					object previous = report; Configure(Settings("[\"Assembly-CSharp\"]", 1000, 100)); Require(ReferenceEquals(previous, Report()), "identical_config_preserves_diff");
				}
				SetPhase(phase + 1); EditorApplication.isPlaying = false;
			}
			else if (phase == 1 || phase == 4 || phase == 7)
			{
				if (EditorApplication.isPlayingOrWillChangePlaymode || !events.Exists(x => x.callback == "transitionObserved" && x.round == Round(phase) && x.transition == "EnteredEditMode")) return;
				RecordReport(events, phase, "EnteredEditMode"); events = ProofEvents(); CheckRound(events, Round(phase));
				if (phase == 1) { Configure(Settings("[\"Assembly-CSharp\"]", 1, 100)); SetPhase(3); EditorApplication.isPlaying = true; }
				else if (phase == 4)
				{
					Require(events.FindAll(x => x.callback == "transitionReport" && x.round == "cap" && !x.complete).Count == 4, "cap_round_incomplete");
					EditorSettings.enterPlayModeOptionsEnabled = false;
					Configure(Settings("[\"Assembly-CSharp\"]", 1000, 100)); StaticTransitionValues.Bug = 31; StaticTransitionValues.Reset = 31;
					SetPhase(6); EditorApplication.isPlaying = true;
				}
				else
				{
					Require(Complete(Report()), "mono_exit_complete");
					Configure("{\"enabled\":false}"); Require(Latest() == null && Report() == null && Capture() == null, "disable_clears_reports"); FinishTransitions(true);
				}
			}
		}
		catch { FinishTransitions(false); }
	}
	private static void FinishTransitions(bool passed)
	{
		EditorApplication.update -= PumpTransitions; EditorApplication.playModeStateChanged -= ObserveTransition;
		if (EditorApplication.isPlaying) { EditorApplication.isPlaying = false; EditorApplication.delayCall += () => FinishTransitions(false); return; }
		var start = ProofEvents().Find(x => x.callback == "transitionStart");
		if (start != null) { EditorSettings.enterPlayModeOptionsEnabled = start.originalOptionsEnabled; EditorSettings.enterPlayModeOptions = (EnterPlayModeOptions)start.originalOptions; }
		if (Collector != null) Configure("{\"enabled\":false}");
		Record("{\"callback\":\"transitionMeasurement\",\"pid\":" + Pid + ",\"passed\":" + (passed ? "true" : "false") + ",\"check\":\"" + (passed ? "all_rounds" : FailedCheck) + "\"}");
		Record("{\"callback\":\"complete\",\"pid\":" + Pid + ",\"passed\":" + (passed ? "true" : "false") + "}"); EditorApplication.Exit(passed ? 0 : 1);
	}

	private static void CheckDifferences()
	{
		Require(Collector.GetMethod("Compare", Flags) != null, "diff_foundation");
		var before = DiffSnapshot(new[] { "Carried:same", "Reset:before", "Removed:gone", "Unreadable:unreadable" });
		var after = DiffSnapshot(new[] { "Carried:same", "Reset:after", "Added:new", "Unreadable:unreadable" });
		var report = Compare(before, after, "ExitingEditMode", "EnteredPlayMode");
		Require(Complete(report) && Fields(report).Count == 5, "diff_complete_union");
		foreach (var pair in new[] { "Carried:carried", "Reset:reset", "Added:added", "Removed:removed", "Unreadable:unreadable" })
		{
			var parts = pair.Split(':'); object entry = Entry(report, "DiffFixture", parts[0]);
			Require((string)Read(entry, "classification") == parts[1], "diff_" + parts[1]);
		}
		Require((string)Read(Entry(report, "DiffFixture", "Reset"), "beforeFingerprint") == "before"
			&& (string)Read(Entry(report, "DiffFixture", "Reset"), "afterFingerprint") == "after", "diff_fingerprints");
		Require(Complete(Compare(before, before, "EnteredPlayMode", "ExitingPlayMode")), "diff_same_snapshot");
		Require(!Complete(Compare(null, after, "", "ExitingEditMode")), "diff_missing_before");
		Require(!Complete(Compare(before, after, "EnteredPlayMode", "EnteredEditMode")), "diff_transition_gap");
		before.GetType().GetField("complete").SetValue(before, false);
		Require(!Complete(Compare(before, after, "ExitingEditMode", "EnteredPlayMode")), "diff_skipped_snapshot");
	}

	private static object DiffSnapshot(string[] entries)
	{
		var snapshot = Activator.CreateInstance(Collector.GetNestedType("Snapshot", BindingFlags.NonPublic));
		snapshot.GetType().GetField("complete").SetValue(snapshot, true);
		foreach (var encoded in entries)
		{
			var parts = encoded.Split(':');
			var entry = Activator.CreateInstance(Collector.GetNestedType("Entry", BindingFlags.NonPublic));
			foreach (var pair in new[] { "assembly:Fixture", "type:DiffFixture", "field:" + parts[0],
				"fingerprint:" + (parts[1] == "unreadable" ? "" : parts[1]), "unreadableReason:" + (parts[1] == "unreadable" ? "unsupported_type" : "") })
			{
				int separator = pair.IndexOf(':'); entry.GetType().GetField(pair.Substring(0, separator)).SetValue(entry, pair.Substring(separator + 1));
			}
			Fields(snapshot).Add(entry);
		}
		return snapshot;
	}

	private static object Compare(object before, object after, string previous, string transition)
	{ return Collector.GetMethod("Compare", Flags).Invoke(null, new[] { before, after, previous, transition }); }

	private static void Require(bool condition, string id) { if (!condition) { FailedCheck = id; throw new InvalidOperationException(id); } if (!Checks.Contains(id)) Checks.Add(id); }
	[UnityEditor.Callbacks.DidReloadScripts]
	private static void OrderObserver()
	{
		if (Environment.GetEnvironmentVariable("UCT_STATICS_TRANSITION_PROOF") != "1") return;
		EditorApplication.playModeStateChanged -= ObserveTransition; EditorApplication.playModeStateChanged += ObserveTransition;
	}
	private static void Configure(string json) { Collector.GetMethod("Configure", Flags).Invoke(null, new object[] { json }); OrderObserver(); }
	private static object Capture() { return Collector.GetMethod("Capture", Flags).Invoke(null, null); }
	private static object Latest() { return Collector.GetProperty("Latest", Flags).GetValue(null, null); }
	private static object Read(object item, string name) { return item.GetType().GetField(name).GetValue(item); }
	private static bool Complete(object snapshot) { return (bool)Read(snapshot, "complete"); }
	private static string Reason(object snapshot) { return (string)Read(snapshot, "skippedReason"); }
	private static IList Fields(object snapshot) { return (IList)Read(snapshot, "fields"); }
	private static object Entry(object snapshot, string type, string field) { foreach (var entry in Fields(snapshot)) if ((string)Read(entry, "type") == type && (string)Read(entry, "field") == field) return entry; throw new InvalidOperationException("entry_missing"); }
	private static string Fingerprint(object snapshot, string type, string field) { return (string)Read(Entry(snapshot, type, field), "fingerprint"); }
	private static string Unreadable(object snapshot, string type, string field) { return (string)Read(Entry(snapshot, type, field), "unreadableReason"); }
	private static string Settings(string allowlist, int fields, int milliseconds) { return "{\"enabled\":true,\"assemblyAllowlist\":" + allowlist + ",\"maxFields\":" + fields + ",\"maxScanMilliseconds\":" + milliseconds + "}"; }
}
