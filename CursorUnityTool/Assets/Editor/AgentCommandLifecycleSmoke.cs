using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Text;
using UnityCursorToolkit.AgentCommands;
using UnityEditor;
using UnityEngine;

namespace UnityCursorToolkit.InternalSmoke
{
	/// <summary>Owned command fixtures. Run the Play smoke before any project command creates a runner.</summary>
	internal static class AgentCommandLifecycleSmoke
	{
		private const string EditorPrefix = "editor.uct_lifecycle_smoke.";
		private const string PlayPrefix = "uct_lifecycle_smoke.";
		private const BindingFlags PrivateStatic = BindingFlags.Static | BindingFlags.NonPublic;
		private const BindingFlags PrivateInstance = BindingFlags.Instance | BindingFlags.NonPublic;

		[MenuItem("Tools/Unity Cursor Toolkit/Diagnostics/Validate Editor Commands")]
		public static void ValidateEditorCommands()
		{
			Require(!EditorApplication.isPlayingOrWillChangePlaymode && !EditorApplication.isCompiling && !EditorApplication.isUpdating,
				"Editor smoke requires idle Edit Mode.");
			WriteResult("editor", false, 0);
			var synchronous = new Counts();
			var yielded = new Counts();
			AgentCommandRegistry.Register(EditorPrefix + "success", "Owned synchronous fixture", context => Scope(context, synchronous, "complete"));
			AgentCommandRegistry.Register(EditorPrefix + "yield", "Owned rejected-yield fixture", context => Scope(context, yielded, "pending"));
			AgentCommandRegistry.Register(PlayPrefix + "edit_rejected", "Owned Play-mode guard fixture", context => Scope(context, new Counts(), "complete"));
			try
			{
				var complete = AgentCommandRunner.Run(EditorPrefix + "success", "{}");
				Require(complete.Status == AgentCommandStatus.Succeeded, "Synchronous nested Editor command did not complete.");
				ReleasedOnce(synchronous);
				Require(AgentCommandRunner.GetStatus(complete.RunId).Status == AgentCommandStatus.Succeeded, "Editor terminal status was not retained.");
				Require(complete.ToJson().Contains("\"executionMode\":\"editorSynchronous\""), "Editor execution mode is missing from run metadata.");
				var rejected = AgentCommandRunner.Run(EditorPrefix + "yield", "{}");
				Require(rejected.Status == AgentCommandStatus.Failed && rejected.Result.Message.Contains("editor_command_yielded"), "Asynchronous Editor yield was not rejected.");
				ReleasedOnce(yielded);
				Require(AgentCommandRunner.Run(PlayPrefix + "edit_rejected", "{}").Status == AgentCommandStatus.Failed, "A Play command ran in Edit Mode.");
				Require(Runner() == null, "Synchronous Editor commands created a runtime scene runner.");
				WriteResult("editor", true, 4);
				Debug.Log("Command lifecycle Editor smoke passed: synchronous nesting, retained mode/status, rejected yield cleanup and Play guard.");
			}
			finally
			{
				AgentCommandRegistry.Unregister(EditorPrefix + "success");
				AgentCommandRegistry.Unregister(EditorPrefix + "yield");
				AgentCommandRegistry.Unregister(PlayPrefix + "edit_rejected");
			}
		}

		[MenuItem("Tools/Unity Cursor Toolkit/Diagnostics/Validate Runtime Command Cleanup")]
		public static void ValidateRuntimeCleanup()
		{
			Require(EditorApplication.isPlaying && !EditorApplication.isCompiling, "Runtime smoke requires stable Play Mode.");
			Require(Runner() == null, "Run the isolated lifecycle smoke before any project command creates the hidden runner; existing command evidence is preserved.");
			WriteResult("play", false, 0);
			Require(AgentCommandRunner.SupportsDeterministicCancellation, "Cancellation capability was not declared.");
			try
			{
				var canceled = new Counts();
				var run = Schedule("cancel", canceled, "pending");
				Require(canceled.Held && canceled.Entered == 1, "Nested handler did not enter before cancellation.");
				Require(AgentCommandRunner.Cancel(run.RunId).Status == AgentCommandStatus.Canceled, "Cancellation did not become terminal.");
				ReleasedOnce(canceled);
				AgentCommandRunner.Cancel(run.RunId);
				ReleasedOnce(canceled);

				var completed = new Counts();
				Require(Schedule("complete", completed, "complete").Status == AgentCommandStatus.Succeeded, "Natural completion failed.");
				ReleasedOnce(completed);

				var failed = new Counts();
				var failure = Schedule("failure", failed, "throw");
				Require(failure.Status == AgentCommandStatus.Failed && failure.Result.Message.Contains("command_handler_failed"), "Nested failure did not become an explicit failed result.");
				ReleasedOnce(failed);

				var cleanup = new Counts();
				var cleanupRun = Schedule("cleanup", cleanup, "dispose-throw");
				var cleanupResult = AgentCommandRunner.Cancel(cleanupRun.RunId);
				Require(cleanupResult.Status == AgentCommandStatus.Failed && cleanupResult.Result.Message.Contains("command_cleanup_failed"), "Cleanup failure was reported as cancellation success.");
				ReleasedOnce(cleanup);

				var timeout = new Counts();
				var timeoutRun = Schedule("timeout", timeout, "wait");
				var owner = Runner();
				var states = (IDictionary)typeof(AgentCommandRunner).GetField("runs", PrivateInstance).GetValue(owner);
				var state = states[timeoutRun.RunId];
				state.GetType().GetField("Deadline", BindingFlags.Instance | BindingFlags.NonPublic).SetValue(state, (double)Time.realtimeSinceStartup - 1);
				typeof(AgentCommandRunner).GetMethod("Update", PrivateInstance).Invoke(owner, null);
				var timedOut = AgentCommandRunner.GetStatus(timeoutRun.RunId);
				Require(timedOut.Status == AgentCommandStatus.Failed && timedOut.Result.Message.Contains("command_timeout"), "Opaque Unity wait escaped the realtime timeout.");
				ReleasedOnce(timeout);

				var disabled = new Counts();
				var disabledRun = Schedule("disabled", disabled, "pending");
				owner.enabled = false;
				Require(AgentCommandRunner.GetStatus(disabledRun.RunId).Status == AgentCommandStatus.Canceled, "Disabling the host did not cancel its handler.");
				ReleasedOnce(disabled);
				owner.enabled = true;

				var playExit = new Counts();
				var exitRun = Schedule("play_exit", playExit, "pending");
				typeof(AgentCommandRunner).GetMethod("OnPlayModeChanged", PrivateStatic).Invoke(null, new object[] { PlayModeStateChange.ExitingPlayMode });
				Require(AgentCommandRunner.GetStatus(exitRun.RunId).Status == AgentCommandStatus.Canceled, "The Play exit callback did not cancel its handler.");
				ReleasedOnce(playExit);
				owner.enabled = true;

				var reload = new Counts();
				Schedule("reload", reload, "pending");
				typeof(AgentCommandRunner).GetMethod("CancelBeforeReload", PrivateStatic).Invoke(null, null);
				ReleasedOnce(reload);
				Require(Runner() == null, "Reload cleanup retained its hidden scene host.");
				WriteResult("play", true, 8);
				Debug.Log("Command lifecycle runtime smoke passed: nested finally/disposal, repeat cancel, completion, handler/cleanup failure, realtime timeout, host disable and lifecycle callbacks. Actual domain reload wiring and game-specific device release still need their live flow.");
			}
			finally
			{
				// This smoke required an unused host; release only its own runner even if an assertion fails.
				if (Runner()) UnityEngine.Object.DestroyImmediate(Runner().gameObject);
				foreach (string name in new[] { "cancel", "complete", "failure", "cleanup", "timeout", "disabled", "play_exit", "reload" })
					AgentCommandRegistry.Unregister(PlayPrefix + name);
			}
		}

		[MenuItem("Tools/Unity Cursor Toolkit/Diagnostics/Validate Command Result Framing")]
		public static void ValidateResultFraming()
		{
			ResultFraming.Begin();
		}

		// This exercises the real TCP broadcaster, not a reflection call directly to HandleCommand.
		private static class ResultFraming
		{
			private const string CommandName = EditorPrefix + "framing";
			private static readonly List<byte> pending = new List<byte>();
			private static readonly byte[] receive = new byte[31];
			private static TcpClient client;
			private static IAsyncResult connecting;
			private static NetworkStream stream;
			private static double deadline;
			private static int caseIndex;
			private static int responses;
			private static string requestId;
			private static string runId;

			internal static void Begin()
			{
				Require(!EditorApplication.isPlayingOrWillChangePlaymode && !EditorApplication.isCompiling && !EditorApplication.isUpdating,
					"Framing smoke requires idle Edit Mode.");
				Require(client == null, "A framing smoke is already running.");
				int port = HotReloadHandler.GetCurrentPort();
				Require(port > 0, "The current Editor's bridge must already be listening.");
				WriteResult("framing", false, 0);
				caseIndex = 0;
				responses = 0;
				runId = null;
				pending.Clear();
				bool configured = false;
				try
				{
					AgentCommandRegistry.Register(CommandName, "Owned real-TCP result framing fixture", Handler);
					client = new TcpClient(AddressFamily.InterNetwork);
					connecting = client.BeginConnect(IPAddress.Loopback, port, null, null);
					deadline = EditorApplication.timeSinceStartup + 20;
					EditorApplication.update += Tick;
					AssemblyReloadEvents.beforeAssemblyReload += Cleanup;
					configured = true;
				}
				finally { if (!configured) Cleanup(); }
			}

			private static IEnumerator Handler(AgentCommandContext context)
			{
				var args = JsonUtility.FromJson<FramingArgs>(context.ArgsJson);
				string data = JsonUtility.ToJson(Fixture(), args.index != 2 && args.index != 4);
				if (args.index == 1) data = data.Replace("\n", "\r\n");
				if (args.index == 3) data = "{\"text\":\"invalid literal\nnewline\"}";
				context.Succeed("Owned framing fixture.", data);
				yield break;
			}

			private static void Tick()
			{
				bool tickCompleted = false;
				try
				{
					Require(!EditorApplication.isPlayingOrWillChangePlaymode && !EditorApplication.isCompiling && !EditorApplication.isUpdating,
						"The framing smoke's idle Editor context changed.");
					Require(EditorApplication.timeSinceStartup < deadline, "Real TCP framing smoke timed out; no result was accepted.");
					if (stream == null)
					{
						if (!connecting.IsCompleted) { tickCompleted = true; return; }
						client.EndConnect(connecting);
						stream = client.GetStream();
						Send(false);
					}
					while (client != null && stream.DataAvailable)
					{
						int count = stream.Read(receive, 0, receive.Length);
						Require(count > 0, "The real bridge closed the smoke connection.");
						for (int i = 0; i < count; i++)
						{
							if (receive[i] != 10)
							{
								pending.Add(receive[i]);
								Require(pending.Count <= 65536, "The framing fixture exceeded its bounded receive buffer.");
								continue;
							}
							string line = Encoding.UTF8.GetString(pending.ToArray());
							pending.Clear();
							if (string.IsNullOrWhiteSpace(line)) continue;
							var response = JsonUtility.FromJson<FramingEnvelope>(line);
							if (response._requestId != requestId) continue;
							Accept(response);
							if (client == null) break;
						}
					}
					tickCompleted = true;
				}
				finally { if (!tickCompleted) Cleanup(); }
			}

			private static void Send(bool status)
			{
				requestId = "uct_framing_" + Guid.NewGuid().ToString("N");
				string args = status ? "{\"action\":\"status\",\"runId\":\"" + runId + "\"}"
					: "{\"action\":\"run\",\"commandName\":\"" + CommandName + "\",\"args\":{\"index\":" + caseIndex + "}}";
				byte[] request = Encoding.UTF8.GetBytes("{\"command\":\"mcpToolCall\",\"toolName\":\"game_command\",\"_requestId\":\"" + requestId + "\",\"args\":" + args + "}\n");
				stream.Write(request, 0, request.Length);
			}

			private static void Accept(FramingEnvelope envelope)
			{
				Require(envelope.command == "mcpToolResult" && envelope.tool == "game_command" && envelope.result != null,
					"A complete matching MCP response must fit in one newline-delimited record.");
				responses++;
				if (caseIndex == 3)
					Require(!envelope.result.success && envelope.result.error != null && envelope.result.error.Contains("transport_json_invalid"),
						"An invalid quoted newline must fail explicitly, not be silently removed or split into records.");
				else
				{
					Require(envelope.result.success && envelope.result.status == "Succeeded" && envelope.result.result != null && envelope.result.result.success,
						"The real run/status response did not preserve command success.");
					Require(JsonUtility.ToJson(envelope.result.result.data) == JsonUtility.ToJson(Fixture()),
						"Transport compaction changed string spaces, escaped controls, quotes, backslashes, nested objects or arrays.");
					if (runId == null)
					{
						runId = envelope.result.runId;
						Require(!string.IsNullOrEmpty(runId), "The command run ID was lost in transport.");
						Send(true);
						return;
					}
				}
				runId = null;
				caseIndex++;
				if (caseIndex < 5) { Send(false); return; }
				Require(responses == 9, "Expected five framing cases and nine real run/status response records.");
				Cleanup();
				WriteResult("framing", true, 5);
				Debug.Log("Command result framing smoke passed: five real TCP cases and nine run/status responses, including LF/CRLF pretty JSON, escaped values, rejected quoted controls and recovery.");
			}

			private static FramingData Fixture() => new FramingData
			{
				text = "two  spaces\nsecond\r\nthird\ttab",
				quote = "{\"quoted\":\"value\"}",
				slash = "ends\\",
				child = new FramingChild { number = 7 },
				values = new[] { 1, 2, 3 }
			};

			private static void Cleanup()
			{
				EditorApplication.update -= Tick;
				AssemblyReloadEvents.beforeAssemblyReload -= Cleanup;
				AgentCommandRegistry.Unregister(CommandName);
				stream?.Dispose();
				client?.Close();
				stream = null;
				client = null;
				connecting = null;
				pending.Clear();
			}

			[Serializable] private sealed class FramingArgs { public int index; }
			[Serializable] private sealed class FramingEnvelope { public string command; public string tool; public string _requestId; public FramingRun result; }
			[Serializable] private sealed class FramingRun { public bool success; public string status; public string runId; public string error; public FramingCompletion result; }
			[Serializable] private sealed class FramingCompletion { public bool success; public FramingData data; }
			[Serializable] private sealed class FramingData { public string text; public string quote; public string slash; public FramingChild child; public int[] values; }
			[Serializable] private sealed class FramingChild { public int number; }
		}

		private static AgentCommandRunner Runner() => (AgentCommandRunner)typeof(AgentCommandRunner).GetField("instance", PrivateStatic).GetValue(null);

		private static AgentCommandRunSnapshot Schedule(string name, Counts counts, string mode)
		{
			AgentCommandRegistry.Register(PlayPrefix + name, "Owned lifecycle fixture", context => Scope(context, counts, mode));
			return AgentCommandRunner.Run(PlayPrefix + name, "{}");
		}

		private static IEnumerator Scope(AgentCommandContext context, Counts counts, string mode)
		{
			counts.Held = true;
			try
			{
				yield return new Probe(counts, mode);
				context.Succeed();
			}
			finally { counts.Held = false; counts.Finally++; }
		}

		private sealed class Counts
		{
			internal bool Held;
			internal int Entered;
			internal int Disposed;
			internal int Finally;
		}

		private sealed class Probe : IEnumerator, IDisposable
		{
			private readonly Counts counts;
			private readonly string mode;
			internal Probe(Counts counts, string mode) { this.counts = counts; this.mode = mode; }
			public object Current => mode == "wait" ? (object)new WaitForSeconds(1000) : null;
			public bool MoveNext()
			{
				counts.Entered++;
				if (mode == "throw") throw new InvalidOperationException("Owned nested failure.");
				return mode != "complete";
			}
			public void Reset() { throw new NotSupportedException(); }
			public void Dispose()
			{
				counts.Disposed++;
				if (mode == "dispose-throw") throw new InvalidOperationException("Owned cleanup failure.");
			}
		}

		private static void ReleasedOnce(Counts counts)
		{
			Require(!counts.Held && counts.Disposed == 1 && counts.Finally == 1, "Entered nested scopes were not released exactly once.");
		}

		private static void Require(bool condition, string message)
		{
			if (!condition) throw new InvalidOperationException(message);
		}

		private static void WriteResult(string mode, bool passed, int checks)
		{
			string folder = Path.Combine("Library", "UnityCursorToolkit", "CommandLifecycleSmoke");
			Directory.CreateDirectory(folder);
			File.WriteAllText(Path.Combine(folder, mode + ".json"), "{\"mode\":\"" + mode + "\",\"state\":\"" + (passed ? "passed" : "running") + "\",\"checks\":" + checks + "}");
		}
	}
}
