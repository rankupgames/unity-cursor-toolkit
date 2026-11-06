using System;
using System.Collections;
using System.IO;
using System.Reflection;
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
