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

public static class StaticSnapshotProbe
{
	private static readonly BindingFlags Flags = BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic;
	private static Type Collector;
	private static string FailedCheck = "snapshot_backend";
	private static readonly List<string> Checks = new List<string>();
	private static readonly string Evidence = Environment.GetEnvironmentVariable("UCT_LIFECYCLE_EVIDENCE_PATH");
	private static readonly int Pid = System.Diagnostics.Process.GetCurrentProcess().Id;

	public static void Run()
	{
		bool passed = false;

		try
		{
			Require(File.Exists(Evidence + ".owner") && File.ReadAllText(Evidence + ".owner") == Pid.ToString(), "owner");
			foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies()) if (assembly.GetName().Name == "UnityCursorToolkit.Editor") Collector = assembly.GetType("UnityCursorToolkit.Core.StaticSnapshotter", false);
			Require(Collector != null, "snapshot_foundation");
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

	private static void Require(bool condition, string id) { if (!condition) { FailedCheck = id; throw new InvalidOperationException(id); } if (!Checks.Contains(id)) Checks.Add(id); }
	private static void Configure(string json) { Collector.GetMethod("Configure", Flags).Invoke(null, new object[] { json }); }
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
