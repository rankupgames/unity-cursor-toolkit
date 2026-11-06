// Editor-only owner-boundary checks invoked by the existing internal batch smoke.
#if UNITY_EDITOR
using System;
using System.Collections;
using System.Collections.Generic;
using System.Reflection;
using UnityEditor;
using UnityEditor.Callbacks;
using UnityEngine;
using UnityCursorToolkit.AgentCommands;

namespace UnityCursorToolkit.InternalSmoke
{
	public static class AgentCommandRunnerCancellationSmoke
	{
		private const string CommandName = "smoke.runner.lifecycle";
		private const string ReloadCommand = "smoke.runner.reload";
		private const string ReloadPending = "UCT_RUNNER_SMOKE_RELOAD_PENDING";
		private const string ReloadObserved = "UCT_RUNNER_SMOKE_RELOAD_OBSERVED";
		private const string ReloadChildEntered = "UCT_RUNNER_SMOKE_RELOAD_CHILD_ENTERED";
		private const string ReloadRequested = "UCT_RUNNER_SMOKE_RELOAD_REQUESTED";
		private const string ReloadStarts = "UCT_RUNNER_SMOKE_RELOAD_STARTS";
		private const string ReloadParentCleanup = "UCT_RUNNER_SMOKE_RELOAD_PARENT_CLEANUP";
		private const string ReloadChildCleanup = "UCT_RUNNER_SMOKE_RELOAD_CHILD_CLEANUP";
		private const string ReloadInputHeld = "UCT_RUNNER_SMOKE_RELOAD_INPUT_HELD";
		private const string ReloadWorldOwned = "UCT_RUNNER_SMOKE_RELOAD_WORLD_OWNED";
		private const string ReloadProtection = "UCT_RUNNER_SMOKE_RELOAD_PROTECTION";

		public static void VerifyCancellationAndDestruction()
		{
			RequireBatchPlayMode();
			var canceledScope = new OwnedScope();
			WithCommand(canceledScope.Create, () =>
			{
				var run = AgentCommandRunner.Run(CommandName, "{}");
				Require(run.Status == AgentCommandStatus.Running && canceledScope.Child.Held, "The nested fixture did not acquire its input scope.");
				canceledScope.OnChildDisposed = () => AgentCommandRunner.Cancel(run.RunId);
				Require(AgentCommandRunner.Cancel(run.RunId).Status == AgentCommandStatus.Canceled, "Cancellation did not finish synchronously.");
				Require(AgentCommandRunner.Cancel(run.RunId).Status == AgentCommandStatus.Canceled, "Repeated cancellation changed the terminal result.");
				canceledScope.AssertReleased();
				Require(AgentCommandRunner.GetStatus(run.RunId).Status == AgentCommandStatus.Canceled, "Cancellation was not retained.");
			});

			var cycle = new TrackedRoutine(1);
			cycle.YieldValue = cycle;
			var routines = new[] { new TrackedRoutine(0), new TrackedRoutine(1, failMove: true), new TrackedRoutine(0, failDispose: true), cycle };
			for (int i = 0; i < routines.Length; i++)
			{
				TrackedRoutine routine = routines[i];
				AgentCommandStatus expected = i == 0 ? AgentCommandStatus.Succeeded : AgentCommandStatus.Failed;
				WithCommand(_ => routine, () =>
				{
					var run = AgentCommandRunner.Run(CommandName, "{}");
					Require(run.Status == expected, "Completion or failure returned the wrong status.");
					AgentCommandRunner.Cancel(run.RunId);
					Require(routine.DisposeCount == 1 && !routine.Held, "A terminal handler was not disposed exactly once.");
				});
			}

			var failingScope = new OwnedScope(failDispose: true);
			WithCommand(failingScope.Create, () =>
			{
				var run = AgentCommandRunner.Run(CommandName, "{}");
				var canceled = AgentCommandRunner.Cancel(run.RunId);
				Require(canceled.Status == AgentCommandStatus.Failed && canceled.Result.Message.Contains("command_cleanup_failed"), "A cleanup exception was reported as successful cancellation.");
				AgentCommandRunner.Cancel(run.RunId);
				failingScope.AssertReleased();
			});

			var destroyedScopes = new[] { new OwnedScope(failDispose: true), new OwnedScope() };
			int nextScope = 0;
			WithCommand(context => destroyedScopes[nextScope++].Create(context), () =>
			{
				AgentCommandRunner.Run(CommandName, "{}");
				AgentCommandRunner.Run(CommandName, "{}");
				AgentCommandRunner[] runners = Resources.FindObjectsOfTypeAll<AgentCommandRunner>();
				Require(runners.Length == 1 && runners[0].gameObject.hideFlags == HideFlags.HideAndDontSave, "The batch smoke cannot identify its owned runner.");
				UnityEngine.Object.DestroyImmediate(runners[0].gameObject);
				foreach (OwnedScope scope in destroyedScopes) scope.AssertReleased();
			});
			PropertyInfo capability = typeof(AgentCommandRunner).GetProperty("SupportsDeterministicCancellation", BindingFlags.Public | BindingFlags.Static);
			Require(capability != null && capability.PropertyType == typeof(bool) && capability.GetGetMethod() != null
				&& !capability.CanWrite && (bool)capability.GetValue(null, null), "Deterministic cancellation requires a public static read-only Boolean capability with value true.");
			Require(AgentCommandRegistry.ToCatalogJson().Contains("\"supportsDeterministicCancellation\":true"), "The command catalog omitted its cancellation capability.");
		}

		public static void BeginDomainReload()
		{
			RequireBatchPlayMode();
			Require(!SessionState.GetBool(ReloadPending, false), "A runner reload smoke is already active.");
			AgentCommandDescriptor descriptor;
			AgentCommandHandler handler;
			Require(!AgentCommandRegistry.TryGet(ReloadCommand, out descriptor, out handler), "The reload fixture command is already registered.");
			SessionState.SetBool(ReloadPending, true);
			SessionState.SetBool(ReloadObserved, false);
			SessionState.SetBool(ReloadChildEntered, false);
			SessionState.SetBool(ReloadRequested, false);
			SessionState.SetInt(ReloadStarts, 0);
			SessionState.SetInt(ReloadParentCleanup, 0);
			SessionState.SetInt(ReloadChildCleanup, 0);
			AgentCommandRegistry.Register(ReloadCommand, "Owned iterator cleanup across an actual assembly reload.", CreateReloadHandler);
			Require(AgentCommandRunner.Run(ReloadCommand, "{}").Status == AgentCommandStatus.Running && SessionState.GetBool(ReloadInputHeld, false), "The reload fixture did not acquire its input scope.");
		}

		[DidReloadScripts]
		private static void ObserveReload()
		{
			if (SessionState.GetBool(ReloadPending, false) && SessionState.GetBool(ReloadRequested, false)) SessionState.SetBool(ReloadObserved, true);
		}

		public static bool VerifyAfterReload()
		{
			Require(Application.isBatchMode && SessionState.GetBool(ReloadPending, false), "The runner reload smoke has no owned batch session.");
			if (!SessionState.GetBool(ReloadObserved, false))
			{
				if (!SessionState.GetBool(ReloadRequested, false) && SessionState.GetBool(ReloadChildEntered, false))
				{
					SessionState.SetBool(ReloadRequested, true);
					EditorUtility.RequestScriptReload();
				}
				return false;
			}
			Require(Resources.FindObjectsOfTypeAll<AgentCommandRunner>().Length == 0, "Assembly reload retained the old hidden runner owner.");
			Require(SessionState.GetInt(ReloadStarts, 0) == 1 && SessionState.GetInt(ReloadParentCleanup, 0) == 1
				&& SessionState.GetInt(ReloadChildCleanup, 0) == 1, "Assembly reload did not finalize the owned iterator chain exactly once, or replayed its handler.");
			Require(!SessionState.GetBool(ReloadInputHeld, true) && !SessionState.GetBool(ReloadWorldOwned, true)
				&& !SessionState.GetBool(ReloadProtection, true), "Assembly reload left a synthetic input, world, or protection scope active.");
			AgentCommandRegistry.Unregister(ReloadCommand);
			SessionState.EraseBool(ReloadPending);
			SessionState.EraseBool(ReloadObserved);
			SessionState.EraseBool(ReloadChildEntered);
			SessionState.EraseBool(ReloadRequested);
			SessionState.EraseInt(ReloadStarts);
			SessionState.EraseInt(ReloadParentCleanup);
			SessionState.EraseInt(ReloadChildCleanup);
			SessionState.EraseBool(ReloadInputHeld);
			SessionState.EraseBool(ReloadWorldOwned);
			SessionState.EraseBool(ReloadProtection);
			return true;
		}

		private static IEnumerator CreateReloadHandler(AgentCommandContext context)
		{
			SessionState.SetInt(ReloadStarts, SessionState.GetInt(ReloadStarts, 0) + 1);
			return ReloadHandler();
		}

		private static IEnumerator ReloadHandler()
		{
			SessionState.SetBool(ReloadInputHeld, true);
			SessionState.SetBool(ReloadWorldOwned, true);
			SessionState.SetBool(ReloadProtection, true);
			try { yield return ReloadChild(); }
			finally
			{
				SessionState.SetBool(ReloadInputHeld, false);
				SessionState.SetBool(ReloadWorldOwned, false);
				SessionState.SetBool(ReloadProtection, false);
				SessionState.SetInt(ReloadParentCleanup, SessionState.GetInt(ReloadParentCleanup, 0) + 1);
			}
		}

		private static IEnumerator ReloadChild()
		{
			SessionState.SetBool(ReloadChildEntered, true);
			try { while (true) yield return null; }
			finally { SessionState.SetInt(ReloadChildCleanup, SessionState.GetInt(ReloadChildCleanup, 0) + 1); }
		}

		private static void WithCommand(AgentCommandHandler handler, Action verify)
		{
			AgentCommandDescriptor existing;
			AgentCommandHandler existingHandler;
			Require(!AgentCommandRegistry.TryGet(CommandName, out existing, out existingHandler), "The lifecycle fixture command is already registered.");
			AgentCommandRegistry.Register(CommandName, "Runner-owned iterator lifecycle fixture.", handler);
			try { verify(); }
			finally { AgentCommandRegistry.Unregister(CommandName); }
		}

		private static void RequireBatchPlayMode()
		{
			Require(Application.isBatchMode && Application.isPlaying, "Runner lifecycle smoke requires a disposable batch Editor in Play Mode.");
		}

		private static void Require(bool condition, string message)
		{
			if (!condition) throw new InvalidOperationException(message);
		}

		private sealed class OwnedScope
		{
			internal readonly TrackedRoutine Child;
			internal Action OnChildDisposed;
			private readonly List<string> cleanupOrder = new List<string>();
			private int starts;
			private int rootCleanup;
			private bool worldOwned;
			private bool protection;

			internal OwnedScope(bool failDispose = false)
			{
				Child = new TrackedRoutine(int.MaxValue, failDispose: failDispose);
				Child.OnDispose = () => { cleanupOrder.Add("child"); OnChildDisposed?.Invoke(); };
			}

			internal IEnumerator Create(AgentCommandContext context)
			{
				starts++;
				return Execute();
			}

			private IEnumerator Execute()
			{
				worldOwned = protection = true;
				try { yield return Child; }
				finally
				{
					worldOwned = protection = false;
					rootCleanup++;
					cleanupOrder.Add("root");
				}
			}

			internal void AssertReleased()
			{
				Require(starts == 1 && rootCleanup == 1 && Child.DisposeCount == 1 && !Child.Held && !worldOwned && !protection
					&& string.Join(",", cleanupOrder) == "child,root", "Owned cleanup was skipped, duplicated, replayed, or ran outside-in.");
			}
		}

		private sealed class TrackedRoutine : IEnumerator, IDisposable
		{
			private int remaining;
			private readonly bool failMove;
			private readonly bool failDispose;
			internal int DisposeCount;
			internal bool Held;
			internal Action OnDispose;
			internal object YieldValue;
			public object Current => YieldValue;

			internal TrackedRoutine(int remaining, bool failMove = false, bool failDispose = false)
			{
				this.remaining = remaining;
				this.failMove = failMove;
				this.failDispose = failDispose;
				Held = true;
			}

			public bool MoveNext()
			{
				Held = true;
				if (failMove) throw new InvalidOperationException("expected iterator step failure");
				return remaining-- > 0;
			}

			public void Dispose()
			{
				DisposeCount++;
				Held = false;
				OnDispose?.Invoke();
				if (failDispose) throw new InvalidOperationException("expected iterator cleanup failure");
			}

			public void Reset() { throw new NotSupportedException(); }
		}
	}
}
#endif
