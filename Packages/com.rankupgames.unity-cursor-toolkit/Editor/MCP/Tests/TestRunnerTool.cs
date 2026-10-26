#if UNITY_EDITOR
using System;
using System.Reflection;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEngine;
using UnityCursorToolkit.Core;

namespace UnityCursorToolkit.MCP
{
	[MCPTool("test_runner")]
	internal sealed class TestRunnerTool : IToolHandler
	{
		private const string AdapterType = "UnityCursorToolkit.TestRunnerIntegration.TestRunnerAdapter";
		public string ToolName => "test_runner";
		public string Description => "List, run, poll or cancel an explicitly owned Editor test job.";

		public TestRunnerTool()
		{
			// Handler recreation after Play reload restores the progress sink.
			MethodInfo entry = FindEntry();
			if (entry != null) entry.Invoke(null, new object[] { null, (Action<string>)BroadcastProgress });
		}

		public string HandleCommand(string argsJson)
		{
			Request request = null;
			bool invoked = false;
			try
			{
				if (string.IsNullOrEmpty(argsJson)) return Error(null, "invalid_test_request", "A JSON request is required.");
				if (Encoding.UTF8.GetByteCount(argsJson) > 65536) return Error(null, "invalid_test_request", "The request exceeds 64KiB.");
				var parsed = JObject.Parse(argsJson, new JsonLoadSettings { DuplicatePropertyNameHandling = DuplicatePropertyNameHandling.Error });
				request = parsed.ToObject<Request>();
				string[] fields = { "action", "mode", "runId", "projectPath", "ownerToken", "editorPid", "timeoutMs", "filter" };
				if (parsed.Properties().Any(field => !fields.Contains(field.Name))
					|| parsed.Properties().Any(field => field.Name != "filter" && field.Name != "editorPid" && field.Name != "timeoutMs" && field.Value.Type != JTokenType.String))
					return Error(request, "invalid_test_request", "Unknown fields or invalid argument types are refused.");
				foreach (string number in new[] { "editorPid", "timeoutMs" })
					if (parsed[number] != null && (parsed[number].Type != JTokenType.Integer
						|| !int.TryParse(parsed[number].ToString(), out int value) || value < 1
						|| (number == "timeoutMs" && value > 600000)))
						return Error(request, "invalid_test_request", "PID and timeout must be positive bounded integers.");
				if (parsed.Properties().Any(field => field.Value.Type == JTokenType.String
					&& ((string)field.Value).IndexOfAny(new[] { '\0', '\r', '\n' }) >= 0))
					return Error(request, "invalid_test_request", "Control characters in arguments are refused.");
				JToken filter = parsed["filter"];
				string[] filters = { "assembly", "namespace", "class", "test", "category" };
				if (filter != null && filter.Type != JTokenType.Null
					&& (filter.Type != JTokenType.Object || ((JObject)filter).Properties().Any(field => !filters.Contains(field.Name)
						|| field.Value.Type != JTokenType.String || string.IsNullOrEmpty((string)field.Value)
						|| ((string)field.Value).Length > 4096 || ((string)field.Value).IndexOfAny(new[] { '\0', '\r', '\n' }) >= 0)))
					return Error(request, "invalid_test_request", "Filters must be known nonempty literal strings.");
				if (request?.action == "capabilities")
				{
					MethodInfo capabilityEntry = FindEntry();
					return capabilityEntry != null ? (string)capabilityEntry.Invoke(null, new object[] { argsJson, (Action<string>)BroadcastProgress })
						: JsonUtility.ToJson(new Capabilities { editorVersion = Application.unityVersion, projectPath = Directory.GetParent(Application.dataPath).FullName, editorPid = Process.GetCurrentProcess().Id });
				}
				if (request == null || (request.mode != "EditMode" && request.mode != "PlayMode"))
					return Error(request, "invalid_test_request", "mode must be EditMode or PlayMode.");
				MethodInfo entry = FindEntry();
				if (entry == null) return Error(request, "test_framework_unavailable",
					"The optional com.unity.test-framework integration is not loaded. No dependency was installed.");
				invoked = true;
				var result = JObject.Parse((string)entry.Invoke(null, new object[] { argsJson, (Action<string>)BroadcastProgress }));
				// Unity inline serialization can materialize an empty error class.
				if (result["error"]?.Type == JTokenType.Null || result["error"] is JObject detail && string.IsNullOrEmpty((string)detail["code"]))
					result.Remove("error");
				return result.ToString(Formatting.None);
			}
			catch (JsonException) { return Error(request, "invalid_test_request", "The request must be valid JSON with unique fields.", !invoked); }
			catch (Exception)
			{
				// Arguments can contain an ownership token. Never return reflected exception text.
				return Error(request, "test_runner_failed", "The Editor test adapter could not handle the request.", false);
			}
		}

		private static MethodInfo FindEntry()
		{
			foreach (var assembly in AssemblyEnumerator.GetLoaded())
			{
				if (assembly.GetName().Name != "UnityCursorToolkit.TestRunnerIntegration.Editor") continue;
				Type type = assembly.GetType(AdapterType, false);
				return type?.GetMethod("Handle", BindingFlags.Static | BindingFlags.NonPublic, null,
					new[] { typeof(string), typeof(Action<string>) }, null);
			}
			return null;
		}

		private static void BroadcastProgress(string json)
		{
			HotReloadHandler.BroadcastToClients("{\"command\":\"testProgress\",\"payload\":" + json + "}");
		}

		private static string Error(Request request, string code, string message, bool workStopped = true)
		{
			return JsonUtility.ToJson(new Failure
			{
				workStopped = workStopped && request?.action != "status" && request?.action != "cancel",
				runId = string.IsNullOrEmpty(request?.runId) ? Guid.NewGuid().ToString("N") : request.runId,
				editorVersion = Application.unityVersion,
				editorPid = Process.GetCurrentProcess().Id,
				mode = request != null && (request.mode == "EditMode" || request.mode == "PlayMode") ? request.mode : null,
				error = new FailureDetail { code = code, message = message, recovery = "Check the selected Editor, backend and request." }
			});
		}

		[Serializable] private sealed class Request { public string action, mode, runId; }
		[Serializable] private sealed class Capabilities
		{
			public bool success = true, available, supportsCancellation;
			public string backend = "bridge", editorVersion, projectPath;
			public int editorPid;
			public string[] modes = new string[0];
		}
		[Serializable] private sealed class Failure
		{
			public bool success, workStopped;
			public string backend = "bridge";
			public string runId;
			public string status = "error";
			public string editorVersion;
			public int editorPid;
			public string mode;
			public string[] selection = new string[0];
			public string[] tests = new string[0];
			public Summary summary = new Summary();
			public FailureDetail error;
		}
		[Serializable] private sealed class Summary
		{
			public int total, passed, failed, skipped, inconclusive, notRun;
			public double durationMs;
		}
		[Serializable] private sealed class FailureDetail { public string code, message, recovery; }
	}
}
#endif
