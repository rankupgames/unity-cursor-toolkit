// =============================================================================
// Author: Miguel A. Lopez
// Company: Rank Up Games LLC
// Project: Unity Cursor Toolkit
// Description: Hidden runtime coroutine runner for MCP-scheduled game commands.
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
		/// Hidden singleton runner created on demand during play mode.
		/// </summary>
		private static AgentCommandRunner instance;

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
		/// Schedules a registered command and returns the initial run status.
		/// </summary>
		/// <param name="commandName">Registered command name selected by MCP.</param>
		/// <param name="argsJson">Raw JSON arguments forwarded to the game command.</param>
		/// <returns>Status snapshot for the scheduled or rejected command.</returns>
		public static AgentCommandRunSnapshot Run(string commandName, string argsJson)
		{
			AgentCommandDescriptor descriptor;
			AgentCommandHandler handler;
			if (AgentCommandRegistry.TryGet(commandName, out descriptor, out handler) == false)
			{
				return AgentCommandRunSnapshot.Rejected(commandName, "Unknown game command: " + commandName);
			}

			if (Application.isPlaying == false)
			{
				return AgentCommandRunSnapshot.Rejected(commandName, "Game commands require Unity play mode: " + commandName);
			}

				AgentCommandRunner runner = GetOrCreate();
				AgentCommandRunState state = new AgentCommandRunState(CreateRunId(commandName), commandName, handler, new AgentCommandContext(commandName, argsJson));
				runner.runs[state.RunId] = state;
				runner.runOrder.Add(state.RunId);
				runner.TrimRetainedRuns();
				state.Coroutine = runner.StartCoroutine(runner.ExecuteCommand(state));
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

			if (state.Coroutine != null && (state.Status == AgentCommandStatus.Pending || state.Status == AgentCommandStatus.Running))
			{
				instance.StopCoroutine(state.Coroutine);
				state.Complete(AgentCommandStatus.Canceled, AgentCommandResult.Failure("Command run canceled."));
				instance.TrimRetainedRuns();
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

		/// <summary>
		/// Executes a command coroutine and converts handler completion into a retained status result.
		/// </summary>
		/// <param name="state">Run state being executed.</param>
		/// <returns>Coroutine sequence that mirrors the game command handler.</returns>
		private IEnumerator ExecuteCommand(AgentCommandRunState state)
		{
			state.Status = AgentCommandStatus.Running;
			IEnumerator handlerRoutine;
			try
			{
				handlerRoutine = state.Handler(state.Context);
			}
			catch (Exception exception)
			{
				state.Complete(AgentCommandStatus.Failed, AgentCommandResult.Failure(exception.Message));
				yield break;
			}

			while (true)
			{
				object currentYield;
				try
				{
					if (handlerRoutine == null || handlerRoutine.MoveNext() == false)
					{
						break;
					}

					currentYield = handlerRoutine.Current;
				}
				catch (Exception exception)
				{
					state.Complete(AgentCommandStatus.Failed, AgentCommandResult.Failure(exception.Message));
					yield break;
				}

				yield return currentYield;
			}

			if (state.Context.HasResult == false)
			{
				state.Context.Succeed("Command completed.");
			}

			AgentCommandStatus finalStatus = state.Context.Result.Success ? AgentCommandStatus.Succeeded : AgentCommandStatus.Failed;
			state.Complete(finalStatus, state.Context.Result);
			TrimRetainedRuns();
		}

		/// <summary>
		/// Clears the static runner reference when Unity destroys the hidden object.
		/// </summary>
		private void OnDestroy()
		{
			if (instance == this)
			{
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
			public AgentCommandHandler Handler { get; }

			/// <summary>
			/// Command context shared with the game-authored handler.
			/// </summary>
			public AgentCommandContext Context { get; }

			/// <summary>
			/// Coroutine handle used when cancellation is requested.
			/// </summary>
			public Coroutine Coroutine { get; set; }

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
