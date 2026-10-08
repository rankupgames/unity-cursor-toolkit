// Disposable fixture only. Observes canonical activation; no production API or handler changes.
using System;
using System.Collections;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using UnityEditor;
using UnityEngine;

public static class UnityCompatibilitySmoke
{
	private static string proof;
	private static string[] ownedPreferenceKeys;
	private static bool configured, quitting;
	private static DateTime started;
	private static readonly BindingFlags Flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static;

	public static void Run()
	{
		proof = Environment.GetEnvironmentVariable("UCT_COMPATIBILITY_PROOF");
		int pid = Process.GetCurrentProcess().Id;
		if (string.IsNullOrEmpty(proof) || !File.Exists(Path.Combine(proof, "owner.pid")) ||
			File.ReadAllText(Path.Combine(proof, "owner.pid")) != pid.ToString())
			throw new InvalidOperationException("Compatibility fixture owner mismatch.");
		started = DateTime.UtcNow;
		EditorApplication.quitting += OnQuitting;
		EditorApplication.update += Pump;
	}

	private static void Pump()
	{
		try
		{
			string stop = Path.Combine(proof, "stop.request");
			if (File.Exists(stop)) { Quit(File.ReadAllText(stop) == "0" ? 0 : 1); return; }
			if ((DateTime.UtcNow - started).TotalSeconds > 90) { Fail("fixture_timeout"); return; }
			if (!configured)
			{
				Type bridge = Type.GetType("UnityCursorToolkit.MCP.MCPBridge, UnityCursorToolkit.Editor", true);
				Type server = Type.GetType("UnityCursorToolkit.HotReloadHandler, UnityCursorToolkit.Editor", true);
				var handlers = (IDictionary)bridge.GetField("_handlers", Flags).GetValue(null);
				if (handlers == null || !handlers.Contains("project_info"))
				{
					if ((DateTime.UtcNow - started).TotalSeconds > 10) Fail("activation_unavailable");
					return;
				}
				object handler = handlers["project_info"];
				if (handler.GetType().Assembly != bridge.Assembly || server.Assembly != bridge.Assembly)
					throw new InvalidOperationException("Canonical handler assembly mismatch.");
				ownedPreferenceKeys = new[] { (string)server.GetField("lastPortPrefKey", Flags).GetRawConstantValue(), (string)server.GetField("debugPrefKey", Flags).GetRawConstantValue() };
				bool automaticListenerObserved = (bool)server.GetMethod("IsServerRunning", Flags).Invoke(null, null);
				var probe = new TcpListener(IPAddress.Loopback, 0);
				probe.Start();
				int port = ((IPEndPoint)probe.LocalEndpoint).Port;
				probe.Stop();
				configured = true;
				if (!(bool)server.GetMethod("TryStartOnSpecificPort", Flags).Invoke(null, new object[] { port }))
					throw new InvalidOperationException("Isolated fixture listener unavailable.");
				bool mono = typeof(object).Assembly.GetType("Mono.Runtime") != null;
				bool coreCLR = !mono && typeof(object).Assembly.GetName().Name == "System.Private.CoreLib";
				if (!mono && !coreCLR) throw new InvalidOperationException("Unknown Editor runtime.");
				File.WriteAllText(Path.Combine(proof, "ready.pending"), JsonUtility.ToJson(new Ready {
					pid = Process.GetCurrentProcess().Id, editorVersion = Application.unityVersion,
					platform = Application.platform.ToString(), projectPath = Path.GetDirectoryName(Application.dataPath),
					assembly = bridge.Assembly.GetName().Name, assemblyMvid = bridge.Assembly.ManifestModule.ModuleVersionId.ToString(),
					handlerCount = handlers.Count, port = port, automaticListenerObserved = automaticListenerObserved,
					isCoreCLR = coreCLR, hasDomainReload = mono
				}));
				File.Move(Path.Combine(proof, "ready.pending"), Path.Combine(proof, "ready.json"));
			}
			string request = Path.Combine(proof, "console.request");
			if (configured && File.Exists(request))
			{
				string marker = File.ReadAllText(request);
				File.Delete(request);
				if (!marker.StartsWith("UCT_COMPATIBILITY_", StringComparison.Ordinal) || marker.Length > 100)
					throw new InvalidOperationException("Invalid fixture console marker.");
				UnityEngine.Debug.Log(marker);
			}
		}
		catch (Exception ex) { Fail("fixture_failed_" + ex.GetType().Name); }
	}

	private static void Fail(string code)
	{
		if (!File.Exists(Path.Combine(proof, "error.json")))
		{
			File.WriteAllText(Path.Combine(proof, "error.pending"), "{\"code\":\"" + code + "\"}");
			File.Move(Path.Combine(proof, "error.pending"), Path.Combine(proof, "error.json"));
		}
		Quit(1);
	}

	private static void Quit(int code)
	{
		if (quitting) return;
		quitting = true;
		EditorApplication.update -= Pump;
		Type server = Type.GetType("UnityCursorToolkit.HotReloadHandler, UnityCursorToolkit.Editor", false);
		if (server != null) server.GetMethod("Stop", Flags).Invoke(null, null);
		if (ownedPreferenceKeys != null) foreach (string key in ownedPreferenceKeys) EditorPrefs.DeleteKey(key);
		EditorApplication.Exit(code);
	}

	private static void OnQuitting() { File.WriteAllText(Path.Combine(proof, "quitting"), Process.GetCurrentProcess().Id.ToString()); }
	[Serializable]
	private sealed class Ready
	{
		public int pid, port, handlerCount;
		public string editorVersion, platform, projectPath, assembly, assemblyMvid;
		public bool automaticListenerObserved, isCoreCLR, hasDomainReload;
	}
}
