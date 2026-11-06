// =============================================================================
// Author: Miguel A. Lopez
// Company: Rank Up Games LLC
// Project: Unity Cursor Toolkit
// Description: Hidden main-thread runner for MCP-scheduled project commands.
// Created: 2026-05-28
// Last Modified: 2026-05-28
// =============================================================================

using System;
using System.Collections;
using System.Collections.Generic;

using UnityEngine;

namespace UnityCursorToolkit.AgentCommands
{
	/// <summary>
	/// Schedules registered commands on Unity's main thread and retains status for MCP polling.
	/// </summary>
	public sealed class AgentCommandRunner : MonoBehaviour
	{
		/// <summary>
		/// Hidden runner created on demand for Edit Mode results and Play Mode coroutines.
		/// </summary>
		private static AgentCommandRunner instance;
		private static bool isShuttingDown;

		/// <summary>Owned iterator chains are disposed once on cancellation and runner teardown.</summary>
		public static bool SupportsDeterministicCancellation => true;

		/// <summary>
		/// Monotonic suffix used to keep run ids stable and readable.
		/// </summary>
		private static int nextRunNumber;

		/// <summary>
		/// Maximum number of retained command runs kept available for status polling.
		/// </summary>
		private const int MaximumRetainedRuns = 128;

		/// <summary>
		/// Active and completed command runs retained for status polling.
		/// </summary>
		private readonly Dictionary<string, AgentCommandRunState> runs = new Dictionary<string, AgentCommandRunState>(StringComparer.Ordinal);

		/// <summary>
		/// Run ids in schedule order so completed snapshots can be pruned deterministically.
		/// </summary>
		private readonly List<string> runOrder = new List<string>();

		/// <summary>
		/// Runs an editor command synchronously or schedules a Play Mode coroutine.
		/// </summary>
		/// <param name="commandName">Registered command name selected by MCP.</param>
		/// <param name="argsJson">Raw JSON arguments forwarded to the game command.</param>
		/// <returns>Status snapshot for the scheduled or rejected command.</returns>
		public static AgentCommandRunSnapshot Run(string commandName, string argsJson)
		{
			if (isShuttingDown)
			{
				return AgentCommandRunSnapshot.Rejected(commandName, "runner_stopping: commands cannot start during runner cleanup or assembly reload.");
			}
			AgentCommandDescriptor descriptor;
			AgentCommandHandler handler;
			if (AgentCommandRegistry.TryGet(commandName, out descriptor, out handler) == false)
			{
				return AgentCommandRunSnapshot.Rejected(commandName, "Unknown game command: " + commandName);
			}

			if (Application.isPlaying == false && descriptor.RequiresPlayMode)
			{
				return AgentCommandRunSnapshot.Rejected(commandName, "Game commands require Unity play mode: " + commandName);
			}
			if (descriptor.RequiresEditMode)
			{
#if UNITY_EDITOR
				if (UnityEditor.EditorApplication.isPlayingOrWillChangePlaymode || UnityEditor.EditorApplication.isCompiling || UnityEditor.EditorApplication.isUpdating)
					return AgentCommandRunSnapshot.Rejected(commandName, "editor_not_ready: editor commands require idle Edit Mode.");
#else
				return AgentCommandRunSnapshot.Rejected(commandName, "editor_required: editor commands are unavailable in a player.");
#endif
			}

			AgentCommandRunner runner = GetOrCreate();
			if (!runner.isActiveAndEnabled)
			{
				return AgentCommandRunSnapshot.Rejected(commandName, "runner_disabled: enable the command runner before starting a command.");
			}
			AgentCommandRunState state = new AgentCommandRunState(CreateRunId(commandName), commandName, handler, new AgentCommandContext(commandName, argsJson));
			runner.runs[state.RunId] = state;
			runner.runOrder.Add(state.RunId);
			runner.TrimRetainedRuns();
			if (descriptor.RequiresEditMode) runner.ExecuteEditorCommand(state);
			else
			{
				try
				{
					Coroutine coroutine = runner.StartCoroutine(runner.ExecuteCommand(state));
					if (!state.IsTerminal)
					{
						if (coroutine == null) runner.FinishRun(state, AgentCommandStatus.Failed, AgentCommandResult.Failure("command_start_failed: Unity did not schedule the command."));
						else state.Coroutine = coroutine;
					}
				}
				catch (Exception exception) { runner.FinishRun(state, AgentCommandStatus.Failed, AgentCommandResult.Failure(exception.Message)); }
			}
			return state.ToSnapshot();
		}

		/// <summary>
		/// Returns the current status for a scheduled command run.
		/// </summary>
		/// <param name="runId">Run id returned by the schedule call.</param>
		/// <returns>Status snapshot, or a failed snapshot when the run is unknown.</returns>
		public static AgentCommandRunSnapshot GetStatus(string runId)
		{
			AgentCommandRunState state;
			if (TryGetState(runId, out state) == false)
			{
				return AgentCommandRunSnapshot.Rejected(string.Empty, "Unknown game command run: " + runId);
			}

			return state.ToSnapshot();
		}

		/// <summary>
		/// Cancels a running command coroutine and returns the resulting status.
		/// </summary>
		/// <param name="runId">Run id returned by the schedule call.</param>
		/// <returns>Status snapshot after cancellation, or a failed snapshot when the run is unknown.</returns>
		public static AgentCommandRunSnapshot Cancel(string runId)
		{
			AgentCommandRunState state;
			if (TryGetState(runId, out state) == false)
			{
				return AgentCommandRunSnapshot.Rejected(string.Empty, "Unknown game command run: " + runId);
			}

			if (!state.IsTerminal && !state.IsFinishing)
			{
				state.CancellationRequested = true;
				// A reentrant request must wait until the current MoveNext/Dispose call returns.
				if (!state.IsExecuting) instance.FinishRun(state, AgentCommandStatus.Canceled, AgentCommandResult.Failure("Command run canceled."), true);
			}

			return state.ToSnapshot();
		}

		/// <summary>
		/// Creates or returns the hidden runner object used for command coroutines.
		/// </summary>
		/// <returns>Runtime command runner singleton.</returns>
		private static AgentCommandRunner GetOrCreate()
		{
			if (instance != null)
			{
				return instance;
			}

			GameObject runnerObject = new GameObject("Unity Cursor Toolkit Agent Command Runner");
			runnerObject.hideFlags = HideFlags.HideAndDontSave;
			if (Application.isPlaying)
			{
				DontDestroyOnLoad(runnerObject);
			}

			instance = runnerObject.AddComponent<AgentCommandRunner>();
#if UNITY_EDITOR
			UnityEditor.AssemblyReloadEvents.beforeAssemblyReload -= OnBeforeAssemblyReload;
			UnityEditor.AssemblyReloadEvents.beforeAssemblyReload += OnBeforeAssemblyReload;
#endif
			return instance;
		}

		/// <summary>
		/// Attempts to resolve a retained run by id.
		/// </summary>
		/// <param name="runId">Run id returned by the schedule call.</param>
		/// <param name="state">Resolved run state when found.</param>
		/// <returns>True when the run exists.</returns>
		private static bool TryGetState(string runId, out AgentCommandRunState state)
		{
			state = null;
			if (instance == null || string.IsNullOrEmpty(runId))
			{
				return false;
			}

			return instance.runs.TryGetValue(runId, out state);
		}

		/// <summary>
		/// Builds a readable unique run id from the command name and schedule order.
		/// </summary>
		/// <param name="commandName">Command name associated with the run.</param>
		/// <returns>Unique run id.</returns>
		private static string CreateRunId(string commandName)
		{
			nextRunNumber++;
			string safeName = string.IsNullOrEmpty(commandName) ? "command" : commandName.Replace(".", "_").Replace("/", "_");
			return safeName + "_" + nextRunNumber + "_" + DateTime.UtcNow.Ticks;
		}

		/// <summary>
		/// Removes oldest terminal runs after the status cache grows past its retention cap.
		/// </summary>
		private void TrimRetainedRuns()
		{
			if (runs.Count <= MaximumRetainedRuns)
			{
				return;
			}

			for (int i = 0; i < runOrder.Count && runs.Count > MaximumRetainedRuns; i++)
			{
				string runId = runOrder[i];
				AgentCommandRunState state;
				if (runs.TryGetValue(runId, out state) == false)
				{
					runOrder.RemoveAt(i);
					i--;
					continue;
				}

				if (state.IsTerminal == false)
				{
					continue;
				}

				runs.Remove(runId);
				runOrder.RemoveAt(i);
				i--;
			}
		}

		/// <summary>Executes an editor handler once and rejects waits or missing completion evidence.</summary>
		private void ExecuteEditorCommand(AgentCommandRunState state)
		{
			state.Status = AgentCommandStatus.Running;
			Exception failure = null;
			state.IsExecuting = true;
			try
			{
				IEnumerator routine = state.Handler(state.Context);
				state.PushRoutine(routine);
				if (routine != null && !state.CancellationRequested && routine.MoveNext())
					state.Context.Fail("editor_command_yielded: editor commands must complete synchronously.");
				else if (!state.Context.HasResult)
					state.Context.Fail("editor_command_result_missing: explicitly report command completion.");
			}
			catch (Exception exception)
			{
				failure = exception;
			}
			finally
			{
				state.IsExecuting = false;
			}
			if (failure != null) FinishRun(state, AgentCommandStatus.Failed, AgentCommandResult.Failure(failure.Message));
			else CompleteCommand(state);
		}

		/// <summary>
		/// Executes a command coroutine and converts handler completion into a retained status result.
		/// </summary>
		/// <param name="state">Run state being executed.</param>
		/// <returns>Coroutine sequence that mirrors the game command handler.</returns>
		private IEnumerator ExecuteCommand(AgentCommandRunState state)
		{
			state.Status = AgentCommandStatus.Running;
			Exception failure = null;
			IEnumerator routine = null;
			state.IsExecuting = true;
			try
			{
				routine = state.Handler(state.Context);
				state.PushRoutine(routine);
			}
			catch (Exception exception)
			{
				failure = exception;
			}
			finally { state.IsExecuting = false; }

			if (failure != null)
			{
				FinishRun(state, AgentCommandStatus.Failed, AgentCommandResult.Failure(failure.Message));
				yield break;
			}
			if (routine == null || state.CancellationRequested)
			{
				CompleteCommand(state);
				yield break;
			}
			IEnumerator driver = ExecuteOwnedRoutine(state, routine, true);
			using (driver as IDisposable)
			{
				while (driver.MoveNext()) yield return driver.Current;
			}
		}

		/// <summary>Unity schedules nested waits; only the actual handler iterators belong to the run.</summary>
		private IEnumerator ExecuteOwnedRoutine(AgentCommandRunState state, IEnumerator routine, bool isRoot)
		{
			while (!state.IsTerminal && !state.CancellationRequested)
			{
				object currentYield = null;
				bool completed = false;
				Exception failure = null;
				state.IsExecuting = true;
				try
				{
					if (!routine.MoveNext())
					{
						state.PopRoutine();
						completed = true;
					}
					else if (!state.CancellationRequested)
					{
						currentYield = routine.Current;
						IEnumerator nested = currentYield as IEnumerator;
						if (nested != null)
						{
							state.PushRoutine(nested);
							currentYield = ExecuteOwnedRoutine(state, nested, false);
						}
					}
				}
				catch (Exception exception)
				{
					failure = exception;
				}
				finally { state.IsExecuting = false; }

				if (failure != null)
				{
					FinishRun(state, AgentCommandStatus.Failed, AgentCommandResult.Failure(failure.Message));
					yield break;
				}
				if (state.CancellationRequested)
				{
					CompleteCommand(state);
					yield break;
				}
				if (completed)
				{
					if (isRoot) CompleteCommand(state);
					yield break;
				}
				yield return currentYield;
			}
			if (state.CancellationRequested) CompleteCommand(state);
		}

		private void CompleteCommand(AgentCommandRunState state)
		{
			if (state.IsTerminal || state.IsFinishing) return;
			if (state.CancellationRequested)
			{
				FinishRun(state, AgentCommandStatus.Canceled, AgentCommandResult.Failure("Command run canceled."));
				return;
			}
			if (state.Context.HasResult == false)
			{
				state.Context.Succeed("Command completed.");
			}

			AgentCommandStatus finalStatus = state.Context.Result.Success ? AgentCommandStatus.Succeeded : AgentCommandStatus.Failed;
			FinishRun(state, finalStatus, state.Context.Result);
		}

		/// <summary>Detach ownership before calling cleanup so reentrant cancellation cannot dispose twice.</summary>
		private void FinishRun(AgentCommandRunState state, AgentCommandStatus status, AgentCommandResult result, bool stopCoroutine = false)
		{
			if (state.IsTerminal || state.IsFinishing) return;
			state.IsFinishing = true;
			Coroutine coroutine = state.Coroutine;
			state.Coroutine = null;
			Exception cleanupFailure = null;
			try
			{
				if (stopCoroutine && coroutine != null) StopCoroutine(coroutine);
			}
			catch (Exception exception) { cleanupFailure = exception; }
			while (state.Routines.Count > 0)
			{
				try { state.PopRoutine(); }
				catch (Exception exception) { if (cleanupFailure == null) cleanupFailure = exception; }
			}
			state.Complete(cleanupFailure == null ? status : AgentCommandStatus.Failed,
				cleanupFailure == null ? result : AgentCommandResult.Failure("command_cleanup_failed: " + cleanupFailure.Message));
			TrimRetainedRuns();
		}

		private void CancelOwnedRuns(string reason)
		{
			bool wasShuttingDown = isShuttingDown;
			isShuttingDown = true;
			try
			{
				// Cleanup callbacks can cancel other runs and trim retained entries.
				var ownedRuns = new AgentCommandRunState[runs.Count];
				runs.Values.CopyTo(ownedRuns, 0);
				foreach (AgentCommandRunState state in ownedRuns)
				{
					if (state.IsTerminal) continue;
					state.CancellationRequested = true;
					if (!state.IsExecuting) FinishRun(state, AgentCommandStatus.Canceled, AgentCommandResult.Failure(reason), true);
				}
			}
			finally { isShuttingDown = wasShuttingDown; }
		}

#if UNITY_EDITOR
		private static void OnBeforeAssemblyReload()
		{
			isShuttingDown = true;
			AgentCommandRunner runner = instance;
			if (runner == null) return;
			runner.CancelOwnedRuns("Command canceled before assembly reload.");
			// The hidden owner must not survive with an empty, reconstructed run table.
			if (runner != null) DestroyImmediate(runner.gameObject);
		}
#endif

		private void OnDisable()
		{
			CancelOwnedRuns("Command canceled because its runner was disabled.");
		}

		/// <summary>
		/// Clears the static runner reference when Unity destroys the hidden object.
		/// </summary>
		private void OnDestroy()
		{
			CancelOwnedRuns("Command canceled because its runner was destroyed.");
			if (instance == this)
			{
#if UNITY_EDITOR
				UnityEditor.AssemblyReloadEvents.beforeAssemblyReload -= OnBeforeAssemblyReload;
#endif
				instance = null;
			}
		}

		/// <summary>
		/// Mutable state retained for a scheduled command run.
		/// </summary>
		private sealed class AgentCommandRunState
		{
			/// <summary>
			/// Unique identifier for polling or cancellation.
			/// </summary>
			public string RunId { get; }

			/// <summary>
			/// Registered command name selected by MCP.
			/// </summary>
			public string CommandName { get; }

			/// <summary>
			/// Coroutine delegate that executes the game command.
			/// </summary>
			public AgentCommandHandler Handler { get; private set; }

			/// <summary>
			/// Command context shared with the game-authored handler.
			/// </summary>
			public AgentCommandContext Context { get; }

			/// <summary>
			/// Coroutine handle used when cancellation is requested.
			/// </summary>
			public Coroutine Coroutine { get; set; }
			public readonly List<IEnumerator> Routines = new List<IEnumerator>();
			public bool CancellationRequested;
			public bool IsExecuting;
			public bool IsFinishing;

			public void PushRoutine(IEnumerator routine)
			{
				if (routine == null) return;
				foreach (IEnumerator owned in Routines)
				{
					if (ReferenceEquals(owned, routine)) throw new InvalidOperationException("command_iterator_cycle: an iterator cannot yield its active owner.");
				}
				Routines.Add(routine);
			}

			public void PopRoutine()
			{
				IEnumerator routine = Routines[Routines.Count - 1];
				Routines.RemoveAt(Routines.Count - 1);
				(routine as IDisposable)?.Dispose();
			}

			/// <summary>
			/// Current execution status.
			/// </summary>
			public AgentCommandStatus Status { get; set; }

			/// <summary>
			/// Completion payload once the run reaches a terminal state.
			/// </summary>
			public AgentCommandResult Result { get; private set; }

			/// <summary>
			/// True after the run has ended and no coroutine remains active.
			/// </summary>
			public bool IsTerminal
			{
				get
				{
					return Status == AgentCommandStatus.Succeeded || Status == AgentCommandStatus.Failed || Status == AgentCommandStatus.Canceled;
				}
			}

			/// <summary>
			/// Creates retained state for a scheduled command.
			/// </summary>
			/// <param name="runId">Unique identifier for polling or cancellation.</param>
			/// <param name="commandName">Registered command name selected by MCP.</param>
			/// <param name="handler">Coroutine delegate that executes the game command.</param>
			/// <param name="context">Command context shared with the game-authored handler.</param>
			public AgentCommandRunState(string runId, string commandName, AgentCommandHandler handler, AgentCommandContext context)
			{
				RunId = runId;
				CommandName = commandName;
				Handler = handler;
				Context = context;
				Status = AgentCommandStatus.Pending;
			}

			/// <summary>
			/// Moves the run into a terminal state.
			/// </summary>
			/// <param name="status">Terminal status to expose through polling.</param>
			/// <param name="result">Completion payload associated with the terminal state.</param>
			public void Complete(AgentCommandStatus status, AgentCommandResult result)
			{
				Status = status;
				Result = result;
				Coroutine = null;
				Handler = null;
			}

			/// <summary>
			/// Converts retained state into an immutable polling snapshot.
			/// </summary>
			/// <returns>Status snapshot for MCP responses.</returns>
			public AgentCommandRunSnapshot ToSnapshot()
			{
				return new AgentCommandRunSnapshot(RunId, CommandName, Status, Result);
			}
		}
	}
}
