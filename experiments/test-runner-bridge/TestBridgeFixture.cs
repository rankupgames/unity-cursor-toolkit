using System;
using System.IO;
using System.Reflection;
using UnityEditor;
using UnityEngine;

[InitializeOnLoad]
internal static partial class TestBridgeFixture
{
	private static readonly string DirectoryPath = Environment.GetEnvironmentVariable("UCT_TEST_BRIDGE_PROOF");
	private static readonly int Pid = System.Diagnostics.Process.GetCurrentProcess().Id;
	private static readonly bool Owner = !string.IsNullOrEmpty(DirectoryPath) && File.Exists(Path.Combine(DirectoryPath, "owner"))
		&& File.ReadAllText(Path.Combine(DirectoryPath, "owner")) == Pid.ToString();
	private const string Session = "UCT.TestBridgeProof.";
	private static readonly BindingFlags Flags = BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic;
	static TestBridgeFixture()
	{
#if !UNITY_7000_0_OR_NEWER
		Initialize();
#endif
	}
#if UNITY_7000_0_OR_NEWER
	[Unity.Scripting.LifecycleManagement.OnCodeInitializing]
#endif
	private static void Initialize()
	{
		if (!Owner) return;
		EditorApplication.update += Pump;
		EditorApplication.quitting += () => File.WriteAllText(Path.Combine(DirectoryPath, "quitting"), "normal");
	}
	public static void Run()
	{
		if (!Owner) throw new InvalidOperationException("Owned proof PID mismatch.");
		var handler = typeof(UnityCursorToolkit.HotReloadHandler);
		string key = (string)handler.GetField("lastPortPrefKey", Flags).GetRawConstantValue();
		SessionState.SetString(Session + "portKey", key);
		SessionState.SetBool(Session + "hadPort", EditorPrefs.HasKey(key));
		SessionState.SetInt(Session + "oldPort", EditorPrefs.GetInt(key, 55500));
		handler.GetField("showDebugLogs", Flags).SetValue(null, true);
		handler.GetMethod("Stop", Flags).Invoke(null, null);
		var listener = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, 0);
		listener.Start(); int port = ((System.Net.IPEndPoint)listener.LocalEndpoint).Port; listener.Stop();
		SessionState.SetInt(Session + "ownedPort", port);
		handler.GetField("currentPort", Flags).SetValue(null, port);
		handler.GetField("lastSuccessfulPort", Flags).SetValue(null, port);
		handler.GetMethod("StartWithoutMutex", Flags).Invoke(null, null);
		SessionState.SetString(Session + "started", DateTime.UtcNow.ToString("O"));
		File.WriteAllText(Path.Combine(DirectoryPath, "ready.json"), JsonUtility.ToJson(new Ready
		{
			pid = Pid, version = Application.unityVersion, port = port,
			coreLibrary = typeof(object).Assembly.GetName().Name,
			isMono = typeof(object).Assembly.GetType("Mono.Runtime") != null
		}));
	}
	private static void Pump()
	{
		if (!Owner) return;
		string started = SessionState.GetString(Session + "started", "");
		bool stop = File.Exists(Path.Combine(DirectoryPath, "stop"));
		if (!stop && !string.IsNullOrEmpty(started)) stop = DateTime.UtcNow - DateTime.Parse(started) > TimeSpan.FromSeconds(180);
		if (!stop) return;
		if (EditorApplication.isPlaying || EditorApplication.isPlayingOrWillChangePlaymode) { EditorApplication.isPlaying = false; return; }
		if (EditorApplication.isCompiling || EditorApplication.isUpdating) return;
		string key = SessionState.GetString(Session + "portKey", "");
		if (!string.IsNullOrEmpty(key) && EditorPrefs.GetInt(key, 0) == SessionState.GetInt(Session + "ownedPort", -1))
		{
			if (SessionState.GetBool(Session + "hadPort", false)) EditorPrefs.SetInt(key, SessionState.GetInt(Session + "oldPort", 55500));
			else EditorPrefs.DeleteKey(key);
		}
		EditorApplication.Exit(0);
	}
	[Serializable] private sealed class Ready { public int pid, port; public string version, coreLibrary; public bool isMono; }
}
