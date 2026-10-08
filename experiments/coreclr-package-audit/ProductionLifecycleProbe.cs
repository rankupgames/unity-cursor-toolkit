// Actual package lifecycle proof. Only ReloadableHandler.cs changes during the run.
// Reflection observes existing private state; production has no test-only hooks.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net.Sockets;
using System.Reflection;
using System.Text;
using System.Threading;
using UnityEditor;
#if UNITY_7000_0_OR_NEWER
using Unity.Scripting.LifecycleManagement;
#endif
using UnityEngine;

[InitializeOnLoad]
public static partial class ProductionLifecycleProbe
{
	private static readonly string Evidence = Environment.GetEnvironmentVariable("UCT_LIFECYCLE_EVIDENCE_PATH");
	private static readonly int Pid = System.Diagnostics.Process.GetCurrentProcess().Id;
	private static readonly bool Owner = File.Exists(Evidence + ".owner") && File.ReadAllText(Evidence + ".owner") == Pid.ToString(CultureInfo.InvariantCulture);
	private static readonly string Generation = Guid.NewGuid().ToString("N");
	private static readonly BindingFlags Flags = BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic;
	private static readonly Dictionary<string, Type> Types = new Dictionary<string, Type>();
	private static TcpClient Client;
	private static readonly StringBuilder Pending = new StringBuilder();
	private static string FixtureResult, ProjectResult;
	private static int Stage, Port, Awaiting, Frames, PreviousFrames;
	private static string HandlerId, ProfilerId, OldMarker;
	private static DateTime Started;
	private static bool Quitting;
	private static int OriginalPortPref;
	private static string PortPrefKey;
	private static Assembly PackageAssembly;
	private static Guid PackageMvid;
	private static Thread SlowWorker;
	private const string Session = "__uct_lifecycle_stream";
	private const string ResourcePrefix = "__uct_lifecycle_resource";

	static ProductionLifecycleProbe()
	{
#if !UNITY_7000_0_OR_NEWER && UNITY_2020_2_OR_NEWER
		if (!Owner && !string.IsNullOrEmpty(Evidence) && AssetDatabase.IsAssetImportWorkerProcess())
			File.AppendAllText(Evidence, "{\"callback\":\"assetImportWorkerObserved\",\"pid\":" + Pid + "}\n");
#endif
		if (!Owner) return;
		EditorApplication.update += Pump;
		EditorApplication.quitting += () => { Quitting = true; Record("editorQuitting"); };
#if !UNITY_7000_0_OR_NEWER
		AssemblyReloadEvents.beforeAssemblyReload += Unloading;
		EditorApplication.delayCall += Initializing;
#endif
	}
	public static void Run()
	{
		if (!Owner) throw new InvalidOperationException("Proof owner PID mismatch.");
		InitializeTypes();
		Started = DateTime.UtcNow;
		PortPrefKey = (string)Types["HotReloadHandler"].GetField("lastPortPrefKey", Flags).GetRawConstantValue();
		OriginalPortPref = EditorPrefs.GetInt(PortPrefKey, 55500);
		var portProbe = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Any, 0); portProbe.Start();
		int availablePort = ((System.Net.IPEndPoint)portProbe.LocalEndpoint).Port; portProbe.Stop();
		Call("HotReloadHandler", "Stop");
		Types["HotReloadHandler"].GetField("currentPort", Flags).SetValue(null, availablePort);
		Types["HotReloadHandler"].GetField("lastSuccessfulPort", Flags).SetValue(null, availablePort);
		Call("HotReloadHandler", "StartWithoutMutex");
		Record("proofPortSelected", "\"port\":" + availablePort);
		SessionState.SetBool("uct.production.oldOptionsEnabled", EditorSettings.enterPlayModeOptionsEnabled);
		SessionState.SetInt("uct.production.oldOptions", (int)EditorSettings.enterPlayModeOptions);
		SaveProgress();
		Record("run", "\"unityVersion\":" + Quote(Application.unityVersion) + ",\"coreLibrary\":" + Quote(typeof(object).Assembly.GetName().Name));
	}
	private static object Field(string owner, string name) { return Types[owner].GetField(name, Flags).GetValue(null); }
	private static object Call(string owner, string method, params object[] args) { return Types[owner].GetMethod(method, Flags).Invoke(null, args); }
	private static void Require(bool value, string message) { if (!value) throw new InvalidOperationException(message); }
	private static string Handler()
	{
		IDictionary handlers = (IDictionary)Field("MCPBridge", "_handlers");
		return (string)handlers["uct_lifecycle_fixture"].GetType().GetField("InstanceId").GetValue(handlers["uct_lifecycle_fixture"]);
	}
	private static int Revision()
	{
		#if UNITY_6000_5_OR_NEWER
		foreach (Assembly assembly in UnityEngine.Assemblies.CurrentAssemblies.GetLoadedAssemblies())
#else
		foreach (Assembly assembly in AppDomain.CurrentDomain.GetAssemblies())
#endif
			if (assembly.GetName().Name == "UCT.ReloadableProof") return (int)assembly.GetType("ReloadableHandler", true).GetField("Revision").GetRawConstantValue();
		return -1;
	}
	private static void Send(string command) { byte[] data = Encoding.UTF8.GetBytes(command + "\n"); Client.GetStream().Write(data, 0, data.Length); }
	private static bool ConnectedProof()
	{
		if (Client == null)
		{
			Port = (int)Call("HotReloadHandler", "GetCurrentPort");
			if (Port <= 0) return false;
			Client = new TcpClient(); Client.Connect("127.0.0.1", Port); Client.SendTimeout = 1000;
			FixtureResult = ProjectResult = null; Pending.Clear();
			Send("{\"command\":\"mcpToolCall\",\"toolName\":\"uct_lifecycle_fixture\",\"args\":{},\"_requestId\":\"fixture\"}");
			Send("{\"command\":\"mcpToolCall\",\"toolName\":\"project_info\",\"args\":{},\"_requestId\":\"project\"}");
		}
		if (!Client.Connected) { Client.Close(); Client = null; return false; }
		NetworkStream stream = Client.GetStream();
		while (stream.DataAvailable)
		{
			byte[] buffer = new byte[65536]; int read = stream.Read(buffer, 0, buffer.Length);
			if (read == 0) break;
			Pending.Append(Encoding.UTF8.GetString(buffer, 0, read));
			string text = Pending.ToString(); int end;
			while ((end = text.IndexOf('\n')) >= 0)
			{
				string line = text.Substring(0, end); text = text.Substring(end + 1);
				if (line.Contains("\"_requestId\":\"fixture\"")) FixtureResult = line;
				if (line.Contains("\"_requestId\":\"project\"")) ProjectResult = line;
				if (line.Contains("\"command\":\"viewportFrame\"") && line.Contains(Session)) Frames++;
			}
			Pending.Clear(); Pending.Append(text);
		}
		return FixtureResult != null && ProjectResult != null;
	}
	private static void CheckNetwork()
	{
		Require(FixtureResult.Contains("\"revision\":" + Awaiting), "TCP returned the previous fixture code.");
		Require(FixtureResult.Contains(Handler()), "TCP returned a stale fixture handler.");
		bool coreCLR = typeof(object).Assembly.GetName().Name == "System.Private.CoreLib";
		Require(ProjectResult.Contains("\"isCoreCLR\":" + (coreCLR ? "true" : "false")) && ProjectResult.Contains("\"hasDomainReload\":" + (coreCLR ? "false" : "true")), "Actual runtime project_info flags did not match the observed runtime.");
		Require(PackageMvid == PackageAssembly.ManifestModule.ModuleVersionId, "Package binary MVID changed.");
		Record("networkVerified", "\"revision\":" + Awaiting + ",\"port\":" + Port + ",\"handler\":" + Quote(Handler()) + ",\"packageMvid\":" + Quote(PackageMvid.ToString()));
	}
	private static IList Entries() { return (IList)Field("ConsoleToCursor", "entryBuffer"); }
	private static int MarkerCount(string marker) { int count = 0; foreach (object entry in Entries()) if ((string)entry.GetType().GetField("message").GetValue(entry) == marker) count++; return count; }
	private static void CheckReset()
	{
		Require(MarkerCount(OldMarker) == 0, "Console retained an earlier session entry.");
		string marker = "__uct_lifecycle_current_" + Guid.NewGuid().ToString("N"); Debug.Log(marker);
		Require(MarkerCount(marker) == 1, "Console log subscription duplicated or missing: count=" + MarkerCount(marker));
		string current = (string)Field("ProfilerSessionRecorder", "sessionId");
		Require(current != ProfilerId, "Profiler retained its earlier session identity.");
		ProfilerId = current;
		if (Stage <= 2) Require(((ICollection)Field("ProfilerSessionRecorder", "frameTimings")).Count == 0, "Profiler retained earlier frame timings.");
		Require(Handler() != HandlerId, "MCP retained a previous handler instance.");
		HandlerId = Handler();
		Record("sessionResetVerified", "\"profilerSession\":" + Quote(ProfilerId) + ",\"consoleMarkerCount\":1");
	}
	private static void SeedCapture()
	{
		object resources = Types["EditorWindowViewportCapture"].GetMethod("GetResources", Flags).Invoke(null, new object[] { "__uct_proof", 16, 16, 8, 8, false });
		foreach (string name in new[] { "captureRt", "scaledRt", "texture" })
			((UnityEngine.Object)resources.GetType().GetField(name).GetValue(resources)).name = ResourcePrefix + name;
	}
	private static void CheckCaptureReleased()
	{
		Require(!Resources.FindObjectsOfTypeAll<RenderTexture>().Any(value => value.name.StartsWith(ResourcePrefix, StringComparison.Ordinal))
			&& !Resources.FindObjectsOfTypeAll<Texture2D>().Any(value => value.name.StartsWith(ResourcePrefix, StringComparison.Ordinal)), "Cached native capture resources leaked across reload/play.");
		Record("captureReleased");
	}
	private static void RequestRevision(int revision)
	{
		OldMarker = "__uct_lifecycle_old_" + revision; Debug.Log(OldMarker);
		ProfilerId = (string)Field("ProfilerSessionRecorder", "sessionId"); HandlerId = Handler();
		SeedCapture(); Awaiting = revision;
		object timings = Field("ProfilerSessionRecorder", "frameTimings");
		timings.GetType().GetMethod("Enqueue").Invoke(timings, new[] { Activator.CreateInstance(timings.GetType().GetGenericArguments()[0]) });
		if (Client != null) { Client.Close(); Client = null; }
		File.WriteAllText(Path.Combine(Application.dataPath, "Reloadable", "Editor", "ReloadableHandler.cs"),
			"using System; using UnityCursorToolkit.Core; [MCPTool(\"uct_lifecycle_fixture\")] public sealed class ReloadableHandler : IToolHandler { public const int Revision = " + revision
			+ "; public readonly string InstanceId = Guid.NewGuid().ToString(\"N\"); public string ToolName => \"uct_lifecycle_fixture\"; public string Description => \"Disposable reload fixture\"; public string HandleCommand(string json) { return \"{\\\"success\\\":true,\\\"revision\\\":\" + Revision + \",\\\"instance\\\":\\\"\" + InstanceId + \"\\\"}\"; } }");
		Record("requestRevision", "\"revision\":" + revision);
		SaveProgress();
		AssetDatabase.Refresh();
	}
	private static object StreamTool() { return Activator.CreateInstance(Types["ViewportStreamTool"], true); }
	private static string StreamCall(string json) { return (string)Types["ViewportStreamTool"].GetMethod("HandleCommand").Invoke(StreamTool(), new object[] { json }); }
	private static void StartStream()
	{
		var cameraObject = new GameObject("__uct_lifecycle_camera"); cameraObject.tag = "MainCamera";
		Camera camera = cameraObject.AddComponent<Camera>(); camera.clearFlags = CameraClearFlags.SolidColor; camera.backgroundColor = Color.blue;
		Require(StreamCall("{\"action\":\"start\",\"sessionId\":\"" + Session + "\",\"view\":\"game\",\"captureMode\":\"camera\",\"width\":32,\"height\":32,\"fps\":10}").Contains("\"success\":true"), "Viewport session did not start.");
	}
	private static void CheckStream()
	{
		Require(StreamCall("{\"action\":\"status\",\"sessionId\":\"" + Session + "\"}").Contains("\"sessionId\":\"" + Session + "\""), "Viewport session was lost across play.");
		Require(Frames > PreviousFrames, "Viewport frame delivery did not continue.");
		PreviousFrames = Frames;
		Record("viewportContinued", "\"frames\":" + Frames + ",\"pixelValidityChecked\":false");
	}
	private static void CheckStopped()
	{
		Require(!(bool)Call("HotReloadHandler", "IsServerRunning") && (int)Call("HotReloadHandler", "GetConnectedClientCount") == 0, "Manual Stop did not persist.");
		Require(((IList)Field("HotReloadHandler", "clientThreads")).Cast<Thread>().All(thread => !thread.IsAlive), "Client worker survived Stop.");
		Thread listener = (Thread)Field("HotReloadHandler", "listenerThread"); Require(listener == null || !listener.IsAlive, "Listener survived Stop.");
		Require(((ICollection)Field("HotReloadHandler", "messageQueue")).Count == 0 && ((ICollection)Field("HotReloadHandler", "mainThreadActions")).Count == 0, "Stopped transport retained queued work.");
		using (var probe = new TcpClient())
		{
			try
			{
				probe.Connect("127.0.0.1", Port);
				Record("stoppedPortProbe", "\"connected\":" + (probe.Connected ? "true" : "false") + ",\"localEndpoint\":" + Quote(probe.Client.LocalEndPoint == null ? null : probe.Client.LocalEndPoint.ToString()) + ",\"listenersOnPort\":" + System.Net.NetworkInformation.IPGlobalProperties.GetIPGlobalProperties().GetActiveTcpListeners().Count(endpoint => endpoint.Port == Port));
				using (var diagnostic = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo { FileName = "powershell.exe", Arguments = "-NoProfile -Command \"Get-NetTCPConnection -State Listen -LocalPort " + Port + " -ErrorAction SilentlyContinue | ForEach-Object { $owner = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $_.OwningProcess); [pscustomobject]@{port=$_.LocalPort;pid=$_.OwningProcess;parent=$owner.ParentProcessId;process=$owner.Name;assetImportWorker=($owner.CommandLine -match '-assetImportWorker')} } | ConvertTo-Json -Compress\"", UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true }))
				{
					string diagnosticOutput = diagnostic.StandardOutput.ReadToEnd(); diagnostic.WaitForExit(5000);
					Record("stoppedPortOwner", "\"rows\":" + Quote(diagnosticOutput));
				}
				throw new InvalidOperationException("Stopped bridge port accepted a connection.");
			}
			catch (SocketException) {}
		}
		Record("manualStopVerified", "\"port\":" + Port);
	}
	private static void Pump()
	{
		if (!Owner || Quitting) return;
		try
		{
			if (File.Exists(Evidence + ".stop")) { Exit(2); return; }
			if (Started == default(DateTime)) return;
			if ((DateTime.UtcNow - Started).TotalSeconds > 80) throw new TimeoutException("Production proof execution deadline.");
			if (EditorApplication.isCompiling || EditorApplication.isUpdating) return;
			if (Stage <= 2 && !ConnectedProof()) return;
			if (Stage == 0) { CheckNetwork(); Stage = 1; RequestRevision(1); return; }
			if ((Stage == 1 || Stage == 2) && Revision() == Awaiting)
			{
				CheckNetwork(); CheckReset(); CheckCaptureReleased();
				if (Stage == 1) { Stage = 2; RequestRevision(2); }
				else { StartStream(); Stage = 3; }
				return;
			}
			if (Stage >= 3 && Stage <= 5) ConnectedProof();
			if (Stage == 3 && Frames > 0)
			{
				CheckStream(); SeedCapture(); OldMarker = "__uct_lifecycle_before_play"; Debug.Log(OldMarker);
				ProfilerId = (string)Field("ProfilerSessionRecorder", "sessionId"); HandlerId = Handler();
				EditorSettings.enterPlayModeOptionsEnabled = true; EditorSettings.enterPlayModeOptions = EnterPlayModeOptions.DisableDomainReload;
				Stage = 4; EditorApplication.isPlaying = true; return;
			}
			if (Stage == 4 && EditorApplication.isPlaying && Frames > PreviousFrames)
			{
				CheckReset(); CheckCaptureReleased(); CheckStream();
				Require((bool)Field("ProfilerSessionRecorder", "activeEnabled") && ((IList)Field("ProfilerSessionRecorder", "recorders")).Count > 0, "Profiler did not restart in Play Mode.");
				OldMarker = "__uct_lifecycle_before_edit"; Debug.Log(OldMarker); Stage = 5; EditorApplication.isPlaying = false; return;
			}
			if (Stage == 5 && !EditorApplication.isPlaying && Frames > PreviousFrames)
			{
				CheckReset(); CheckStream(); StreamCall("{\"action\":\"stop\",\"sessionId\":\"" + Session + "\"}");
				Client.Close(); Client = null; Call("HotReloadHandler", "Stop"); CheckStopped(); Stage = 6; RequestRevision(3); return;
			}
			if (Stage == 6 && Revision() == 3) { CheckStopped(); Stage = 7; EditorApplication.isPlaying = true; return; }
			if (Stage == 7 && EditorApplication.isPlaying) { CheckStopped(); Stage = 8; EditorApplication.isPlaying = false; return; }
			if (Stage == 8 && !EditorApplication.isPlaying)
			{
				CheckStopped();
				// A stalled existing worker must remain tracked and block replacement startup.
				SlowWorker = new Thread(() => Thread.Sleep(4000)); SlowWorker.IsBackground = true; SlowWorker.Start();
				Types["HotReloadHandler"].GetField("listenerThread", Flags).SetValue(null, SlowWorker);
				Call("HotReloadHandler", "Stop"); Call("HotReloadHandler", "Start");
				Require(SlowWorker.IsAlive && ReferenceEquals(SlowWorker, Field("HotReloadHandler", "listenerThread")) && !(bool)Call("HotReloadHandler", "IsServerRunning"), "Failed join discarded a live worker or started a replacement.");
				Record("joinFailureVisible", "\"expectedErrors\":2,\"replacementStarted\":false,\"liveWorkerRetained\":true"); Stage = 9; return;
			}
			if (Stage == 9 && !SlowWorker.IsAlive)
			{
				Call("HotReloadHandler", "Stop"); CheckStopped(); Record("complete"); Exit(0);
			}
		}
		catch (Exception error) { Record("failure", "\"error\":" + Quote(error.ToString())); Exit(1); }
		finally { if (!Quitting && Started != default(DateTime)) SaveProgress(); }
	}
	private static void Exit(int code)
	{
		if (Client != null) { Client.Close(); Client = null; }
		if (EditorApplication.isPlaying) { EditorApplication.isPlaying = false; return; }
		EditorSettings.enterPlayModeOptionsEnabled = SessionState.GetBool("uct.production.oldOptionsEnabled", false);
		EditorSettings.enterPlayModeOptions = (EnterPlayModeOptions)SessionState.GetInt("uct.production.oldOptions", 0);
		var camera = GameObject.Find("__uct_lifecycle_camera"); if (camera != null) UnityEngine.Object.DestroyImmediate(camera);
		try
		{
			if (Types.Count > 0)
			{
				Call("HotReloadHandler", "Stop");
				bool stopped = (bool)Field("HotReloadHandler", "stopRequested") && !(bool)Field("HotReloadHandler", "isServerRunning")
					&& ((Thread)Field("HotReloadHandler", "listenerThread") == null)
					&& ((IList)Field("HotReloadHandler", "clientThreads")).Cast<Thread>().All(thread => !thread.IsAlive);
				Record("shutdownWorkers", "\"stopped\":" + (stopped ? "true" : "false"));
			}
			if (PortPrefKey != null) EditorPrefs.SetInt(PortPrefKey, OriginalPortPref);
		}
		finally { EditorApplication.Exit(code); }
	}
	#if UNITY_7000_0_OR_NEWER
	[OnCodeUnloading]
	#endif
	private static void Unloading()
	{
		if (Client != null) { Client.Close(); Client = null; }
		if (Quitting && Types.Count > 0)
		{
			bool stopped = (bool)Field("HotReloadHandler", "stopRequested") && !(bool)Field("HotReloadHandler", "isServerRunning")
				&& ((Thread)Field("HotReloadHandler", "listenerThread") == null)
				&& ((IList)Field("HotReloadHandler", "clientThreads")).Cast<Thread>().All(thread => !thread.IsAlive);
			Record("shutdownWorkers", "\"stopped\":" + (stopped ? "true" : "false"));
		}
		#if UNITY_7000_0_OR_NEWER
		Record("OnCodeUnloading");
#else
		Record("beforeAssemblyReload");
#endif
	}
	private static void InitializeTypes()
	{
		foreach (string name in new[] { "UnityCursorToolkit.HotReloadHandler", "UnityCursorToolkit.ConsoleToCursor", "UnityCursorToolkit.ProfilerSessionRecorder", "UnityCursorToolkit.MCP.MCPBridge", "UnityCursorToolkit.MCP.ViewportStreamTool", "UnityCursorToolkit.MCP.EditorWindowViewportCapture" })
			Types[name.Substring(name.LastIndexOf('.') + 1)] = Type.GetType(name + ", UnityCursorToolkit.Editor", true);
		PackageAssembly = Types["HotReloadHandler"].Assembly;
		if (PackageMvid == Guid.Empty) PackageMvid = PackageAssembly.ManifestModule.ModuleVersionId;
	}
	private static void SaveProgress()
	{
		File.WriteAllLines(Evidence + ".state", new[] { Started.ToString("O"), Stage.ToString(), Port.ToString(), Awaiting.ToString(), Frames.ToString(), PreviousFrames.ToString(), HandlerId ?? "", ProfilerId ?? "", OldMarker ?? "", OriginalPortPref.ToString(), PackageMvid.ToString() });
	}
	#if UNITY_7000_0_OR_NEWER
	[OnCodeInitializing]
	#endif
	private static void Initializing()
	{
		if (!Owner) return;
		EditorApplication.update -= Pump; EditorApplication.update += Pump;
		if (File.Exists(Evidence + ".state"))
		{
			string[] state = File.ReadAllLines(Evidence + ".state");
			Started = DateTime.Parse(state[0], CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind);
			Stage = int.Parse(state[1]); Port = int.Parse(state[2]); Awaiting = int.Parse(state[3]); Frames = int.Parse(state[4]); PreviousFrames = int.Parse(state[5]);
			HandlerId = state[6]; ProfilerId = state[7]; OldMarker = state[8]; OriginalPortPref = int.Parse(state[9]); PackageMvid = Guid.Parse(state[10]);
			InitializeTypes(); PortPrefKey = (string)Types["HotReloadHandler"].GetField("lastPortPrefKey", Flags).GetRawConstantValue();
		}
		#if UNITY_7000_0_OR_NEWER
		Record("OnCodeInitializing");
#else
		Record("InitializeOnLoad.delayCall");
#endif
	}
	private static string Quote(string text) { return "\"" + (text ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "\\r").Replace("\n", "\\n") + "\""; }
	private static void Record(string name, string extra = null)
	{
		if (!Owner) return;
		File.AppendAllText(Evidence, "{\"utc\":" + Quote(DateTime.UtcNow.ToString("O")) + ",\"callback\":" + Quote(name) + ",\"pid\":" + Pid + ",\"generation\":" + Quote(Generation) + ",\"stage\":" + Stage + (extra == null ? "" : "," + extra) + "}\n");
	}
}
