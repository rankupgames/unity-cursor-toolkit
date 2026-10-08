// Standalone Unity 7 observation fixture. No toolkit package is loaded.
// Lifecycle callbacks use pure managed logging, including during engine shutdown.
using System;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Threading;
using UnityEditor;
using UnityEditor.Compilation;
using Unity.Scripting.LifecycleManagement;
using UnityEngine;

[InitializeOnLoad]
public static partial class LifecycleProbe
{
	private const string Prefix = "uct.lifecycle.";
	private static readonly string Evidence = Environment.GetEnvironmentVariable("UCT_LIFECYCLE_EVIDENCE_PATH");
	private static readonly int Pid = System.Diagnostics.Process.GetCurrentProcess().Id;
	private static readonly bool Owner = File.Exists(Evidence + ".owner")
		&& File.ReadAllText(Evidence + ".owner") == Pid.ToString(CultureInfo.InvariantCulture);
	private static string Generation = Guid.NewGuid().ToString("N");
	private static string UnityVersion = Environment.GetEnvironmentVariable("UCT_LIFECYCLE_EDITOR_VERSION");
	private static bool ActualVersionObserved;
	private static int Stage;
	private static bool DomainReloadDisabled;
	private static int PlayUpdates;

	static LifecycleProbe()
	{
		Record("staticConstructor");
		Attach();
	}

	public static void Run()
	{
		if (!Owner) throw new InvalidOperationException("The lifecycle fixture owner PID does not match.");
		UnityVersion = Application.unityVersion;
		ActualVersionObserved = true;
		SessionState.SetString(Prefix + "started", DateTime.UtcNow.ToString("O"));
		SetStage(1);
		SessionState.SetBool(Prefix + "oldOptionsEnabled", EditorSettings.enterPlayModeOptionsEnabled);
		SessionState.SetInt(Prefix + "oldOptions", (int)EditorSettings.enterPlayModeOptions);
		Record("run");
		ObserveEntityId();
		RequestRevision(1);
	}

	private static void ObserveEntityId()
	{
		var ownedObject = new GameObject("__uctEntityIdProof");
		try {
			var method = typeof(UnityEngine.Object).GetMethod("GetEntityId", BindingFlags.Public | BindingFlags.Instance);
			var id = method.Invoke(ownedObject, null);
			var type = id.GetType();
			var signatures = new System.Collections.Generic.List<string>();
			MethodInfo conversion = null;
			foreach (var candidate in type.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance | BindingFlags.DeclaredOnly)) {
				signatures.Add(Quote((candidate.IsPublic ? "public " : "nonpublic ") + candidate.ToString()));
				var parameters = candidate.GetParameters();
				if (candidate.IsPublic && candidate.ReturnType == typeof(ulong)
					&& ((!candidate.IsStatic && candidate.Name == "ToULong" && parameters.Length == 0)
						|| (candidate.IsStatic && (candidate.Name == "ToULong" || candidate.Name == "op_Explicit" || candidate.Name == "op_Implicit")
							&& parameters.Length == 1 && parameters[0].ParameterType == type))) { if (conversion == null || candidate.Name == "ToULong") conversion = candidate; }
			}
			var parse = type.GetMethod("Parse", BindingFlags.Public | BindingFlags.Static, null, new[] { typeof(string) }, null);
			string json = "{\"utc\":" + Quote(DateTime.UtcNow.ToString("O")) + ",\"callback\":\"entityIdMetadata\",\"pid\":" + Pid
				+ ",\"type\":" + Quote(type.FullName) + ",\"signatures\":[" + string.Join(",", signatures) + "]"
				+ ",\"sample\":" + Quote(id.ToString()) + ",\"stringParseAvailable\":" + Bool(parse != null)
				+ ",\"publicULongConversionAvailable\":" + Bool(conversion != null) + "}";
			File.AppendAllText(Evidence, json + "\n");
			if (conversion == null) return;
			try {
				var fromULong = type.GetMethod("FromULong", BindingFlags.Public | BindingFlags.Static, null, new[] { typeof(ulong) }, null);
				ulong numeric = (ulong)conversion.Invoke(conversion.IsStatic ? null : id, conversion.IsStatic ? new[] { id } : null);
				bool roundtrip = fromULong != null && id.Equals(fromULong.Invoke(null, new object[] { numeric }));
				File.AppendAllText(Evidence, "{\"callback\":\"entityIdRoundtrip\",\"pid\":" + Pid
					+ ",\"conversion\":" + Quote(conversion.ToString()) + ",\"wireSample\":" + Quote(numeric.ToString(CultureInfo.InvariantCulture))
					+ ",\"ulongRoundtrip\":" + Bool(roundtrip) + "}\n");
			} catch (Exception error) {
				File.AppendAllText(Evidence, "{\"callback\":\"entityIdRoundtripError\",\"pid\":" + Pid + ",\"error\":" + Quote(error.Message) + "}\n");
			}
		} finally { UnityEngine.Object.DestroyImmediate(ownedObject); }
	}

	private static void Attach()
	{
		if (!Owner) return;
		EditorApplication.update -= Pump;
		EditorApplication.update += Pump;
		EditorApplication.playModeStateChanged -= PlayState;
		EditorApplication.playModeStateChanged += PlayState;
		AssemblyReloadEvents.beforeAssemblyReload -= BeforeReload;
		AssemblyReloadEvents.beforeAssemblyReload += BeforeReload;
		AssemblyReloadEvents.afterAssemblyReload -= AfterReload;
		AssemblyReloadEvents.afterAssemblyReload += AfterReload;
		CompilationPipeline.compilationStarted -= CompilationStarted;
		CompilationPipeline.compilationStarted += CompilationStarted;
		CompilationPipeline.compilationFinished -= CompilationFinished;
		CompilationPipeline.compilationFinished += CompilationFinished;
	}

	[OnCodeLoaded] private static void CodeLoaded() { Record("OnCodeLoaded"); Attach(); }
	[OnCodeUnloading] private static void CodeUnloading() { Record("OnCodeUnloading"); }
	[OnCodeInitializing] private static void CodeInitializing() { Record("OnCodeInitializing"); Attach(); }
	[OnCodeDeinitializing] private static void CodeDeinitializing() { Record("OnCodeDeinitializing"); }
	[OnAssemblyUnloading] private static void AssemblyUnloading() { Record("OnAssemblyUnloading"); }
	private static void BeforeReload() { Record("beforeAssemblyReload"); }
	private static void AfterReload() { Record("afterAssemblyReload"); Attach(); }
	private static void CompilationStarted(object context) { Record("compilationStarted"); }
	private static void CompilationFinished(object context) { Record("compilationFinished"); }

	private static void SetStage(int stage) { Stage = stage; SessionState.SetInt(Prefix + "stage", stage); }

	private static void RequestRevision(int revision)
	{
		SessionState.SetInt(Prefix + "awaiting", revision);
		Record("requestRevision" + revision);
		File.WriteAllText(Path.Combine(Application.dataPath, "Editor", "RecompiledMarker.cs"),
			"public static class RecompiledMarker { public const int Revision = " + revision + "; }");
		AssetDatabase.Refresh();
	}

	private static void Stop()
	{
		if (EditorApplication.isPlaying) { EditorApplication.isPlaying = false; return; }
		EditorApplication.Exit(2);
	}

	private static void Pump()
	{
		// The external stop request remains effective if SessionState is missing.
		if (File.Exists(Evidence + ".stop")) { Record("normalStopRequested"); Stop(); return; }
		string started = SessionState.GetString(Prefix + "started", "");
		if (started.Length == 0) return;
		if ((DateTime.UtcNow - DateTime.Parse(started).ToUniversalTime()).TotalSeconds > 80) {
			Record("executionTimeout"); Stop(); return;
		}
		if (EditorApplication.isCompiling || EditorApplication.isUpdating) return;
		UnityVersion = Application.unityVersion;
		ActualVersionObserved = true;
		Stage = SessionState.GetInt(Prefix + "stage", 0);
		DomainReloadDisabled = EditorSettings.enterPlayModeOptionsEnabled
			&& (EditorSettings.enterPlayModeOptions & EnterPlayModeOptions.DisableDomainReload) != 0;
		int awaiting = SessionState.GetInt(Prefix + "awaiting", 0);
		if ((Stage == 1 || Stage == 2) && RecompiledMarker.Revision == awaiting) {
			Record("revisionObserved" + awaiting);
			if (Stage == 1) { SetStage(2); RequestRevision(2); }
			else {
				SetStage(3);
				EditorSettings.enterPlayModeOptionsEnabled = true;
				EditorSettings.enterPlayModeOptions = EnterPlayModeOptions.DisableDomainReload;
				DomainReloadDisabled = true;
				Record("requestEnterPlay");
				EditorApplication.isPlaying = true;
			}
		}
		if (Stage == 4 && EditorApplication.isPlaying && ++PlayUpdates >= 5) {
			SetStage(5); Record("requestExitPlay"); EditorApplication.isPlaying = false;
		}
	}

	private static void PlayState(PlayModeStateChange state)
	{
		Record("playMode:" + state);
		if (state == PlayModeStateChange.EnteredPlayMode) { PlayUpdates = 0; SetStage(4); }
		if (state == PlayModeStateChange.EnteredEditMode && Stage == 5) {
			SetStage(6);
			Record("complete");
			EditorSettings.enterPlayModeOptionsEnabled = SessionState.GetBool(Prefix + "oldOptionsEnabled", false);
			EditorSettings.enterPlayModeOptions = (EnterPlayModeOptions)SessionState.GetInt(Prefix + "oldOptions", 0);
			DomainReloadDisabled = false;
			EditorApplication.delayCall += () => EditorApplication.Exit(0);
		}
	}

	private static void Record(string callback)
	{
		if (!Owner || string.IsNullOrEmpty(Evidence)) return;
		// No Unity API calls here. OnCodeDeinitializing also runs after SessionState is disposed on exit.
		string json = "{\"utc\":" + Quote(DateTime.UtcNow.ToString("O")) + ",\"callback\":" + Quote(callback)
			+ ",\"pid\":" + Pid + ",\"owner\":" + Bool(Owner) + ",\"generation\":" + Quote(Generation)
			+ ",\"revision\":" + RecompiledMarker.Revision + ",\"stage\":" + Stage
			+ ",\"unityVersion\":" + Quote(UnityVersion) + ",\"actualVersionObserved\":" + Bool(ActualVersionObserved)
			+ ",\"coreLibrary\":" + Quote(typeof(object).Assembly.GetName().Name)
			+ ",\"coreLibraryVersion\":" + Quote(typeof(object).Assembly.GetName().Version.ToString())
			+ ",\"environmentVersion\":" + Quote(Environment.Version.ToString())
			+ ",\"isMono\":" + Bool(typeof(object).Assembly.GetType("Mono.Runtime") != null)
			+ ",\"thread\":" + Thread.CurrentThread.ManagedThreadId + ",\"domainReloadDisabled\":" + Bool(DomainReloadDisabled) + "}";
		File.AppendAllText(Evidence, json + "\n");
	}

	private static string Bool(bool value) { return value ? "true" : "false"; }
	private static string Quote(string value) {
		return "\"" + (value ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "\\r").Replace("\n", "\\n") + "\"";
	}
}
