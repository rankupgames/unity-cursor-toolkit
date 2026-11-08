// Disposable fixture bootstrap; package tool implementations remain unchanged.
using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading.Tasks;
using UnityEditor;
using UnityEngine;

internal static class AssistantRelayProbe
{
	static string root;
	static DateTime deadline;
	static bool stopping;
	static object service;
	static Type serviceType;
	static Task shutdown;
	static int relayPid;
	static readonly BindingFlags Flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance;

	[InitializeOnLoadMethod]
	static void Attach()
	{
		root = Environment.GetEnvironmentVariable("UCT_ASSISTANT_PROOF_DIR");
		if (string.IsNullOrWhiteSpace(root) || !Path.IsPathRooted(root))
			throw new InvalidOperationException("Required absolute owned proof directory is missing.");
		serviceType = Find("Unity.Relay.Editor.RelayService");
		serviceType.GetMethod("SuppressAutoStart", Flags).Invoke(null, null);
		EditorApplication.update -= Pump;
		EditorApplication.update += Pump;
		EditorApplication.quitting += () => Write("quitting.json", new { quitting = true, at = DateTime.UtcNow.ToString("O") });
		EditorApplication.delayCall += Configure;
	}

	static Type Find(string name) => AppDomain.CurrentDomain.GetAssemblies()
		.Select(assembly => assembly.GetType(name, false)).FirstOrDefault(type => type != null)
		?? throw new InvalidOperationException("Required source type missing: " + name);

	static void Write(string name, object value)
	{
		var json = Find("Newtonsoft.Json.JsonConvert").GetMethod("SerializeObject", new[] { typeof(object) }).Invoke(null, new[] { value }) as string;
		File.WriteAllText(Path.Combine(root, name), json);
	}

	static void Configure()
	{
		try
		{
			deadline = DateTime.UtcNow.AddSeconds(90);
			var manager = Find("Unity.AI.MCP.Editor.Settings.MCPSettingsManager");
			var settings = manager.GetProperty("Settings", Flags).GetValue(null);
			settings.GetType().GetMethod("SetToolEnabled", Flags).Invoke(settings, new object[] { "Unity_ReadConsole", true });
			var registry = Find("Unity.AI.MCP.Editor.ToolRegistry.McpToolRegistry");
			Write("catalog.json", registry.GetMethod("GetAllToolsForSettings", Flags).Invoke(null, null));
			service = serviceType.GetProperty("Instance", Flags).GetValue(null);
			serviceType.GetMethod("Initialize", Flags).Invoke(service, null);
			Debug.Log("UCT_ASSISTANT_PROBE_SENTINEL");
			Write("bootstrap.json", new {
				version = Application.unityVersion, coreLibrary = typeof(object).Assembly.GetName().Name,
				pid = System.Diagnostics.Process.GetCurrentProcess().Id,
				isBatchMode = Application.isBatchMode, isMono = AppDomain.CurrentDomain.GetAssemblies().Any(assembly => assembly.GetType("Mono.Runtime", false) != null),
				statusDirectory = Environment.GetEnvironmentVariable("UNITY_MCP_STATUS_DIR"),
				packageVersion = "2.20.0-pre.1", at = DateTime.UtcNow.ToString("O")
			});
		}
		catch (Exception error)
		{
			Write("bootstrap-error.json", new { message = error.ToString() });
			EditorApplication.Exit(1);
		}
	}

	[Serializable]
	sealed class OwnedConnection
	{
		public int editor_pid;
		public string project_path;
		public string connection_path;
		public string protocol_version;
	}

	static void Pump()
	{
		if (File.Exists(Path.Combine(root, "stop")) || deadline != default && DateTime.UtcNow > deadline)
		{
			if (!stopping)
			{
				stopping = true;
				if (service == null) { EditorApplication.Exit(1); return; }
				shutdown = (Task)serviceType.GetMethod("StopAsync", Flags).Invoke(service, null);
			}
			if (shutdown.IsCompleted)
			{
				Write("shutdown.json", new { completed = true, faulted = shutdown.IsFaulted, relayPid,
					packageFallback = "StopAsync sends IPC shutdown then invokes KillProcessTree if its handle remains." });
				EditorApplication.update -= Pump;
				EditorApplication.Exit(shutdown.IsFaulted ? 1 : 0);
			}
			return;
		}
		if (service == null || File.Exists(Path.Combine(root, "ready.json"))) return;
		var state = serviceType.GetProperty("State", Flags).GetValue(service);
		var status = state.GetType().GetProperty("Status").GetValue(state).ToString();
		if (status == "Running")
		{
			var bridgeRunning = (bool)Find("Unity.AI.MCP.Editor.UnityMCPBridge").GetProperty("IsRunning", Flags).GetValue(null);
			if (!bridgeRunning) return;
			var registry = (string)Find("Unity.AI.MCP.Editor.Helpers.ServerDiscovery").GetMethod("GetRegistryFilePath", Flags).Invoke(null, null);
			if (!File.Exists(registry)) return;
			if (!string.Equals(Path.GetFullPath(Path.GetDirectoryName(registry)),
				Path.GetFullPath(Environment.GetEnvironmentVariable("UNITY_MCP_STATUS_DIR")), StringComparison.OrdinalIgnoreCase))
				throw new InvalidOperationException("Owned connection directory differs.");
			var connection = JsonUtility.FromJson<OwnedConnection>(File.ReadAllText(registry));
			if (connection.editor_pid != System.Diagnostics.Process.GetCurrentProcess().Id ||
				!string.Equals(Path.GetFullPath(connection.project_path), Path.GetDirectoryName(Application.dataPath), StringComparison.OrdinalIgnoreCase))
				throw new InvalidOperationException("Owned connection PID or project differs.");
			Write("connection.json", connection);
			relayPid = (int)state.GetType().GetProperty("ProcessId").GetValue(state);
			Write("ready.json", new { relayPid, status, at = DateTime.UtcNow.ToString("O") });
		}
		else if (status == "Failed")
		{
			Write("startup-error.json", state);
			File.WriteAllText(Path.Combine(root, "stop"), "");
		}
	}
}
