// =============================================================================
// Author: Miguel A. Lopez
// Company: Rank Up Games LLC
// Project: Unity Cursor Toolkit
// Description: Main-thread command hosts with explicit nested-iterator ownership.
// Created: 2026-05-28
// Last Modified: 2026-11-06
// =============================================================================

using System;
using System.Collections;
using System.Collections.Generic;
using UnityEngine;
#if UNITY_EDITOR
using UnityEditor;
#endif

namespace UnityCursorToolkit.AgentCommands
{
	/// <summary>Owns every entered command iterator until completion or cancellation.</summary>
	public sealed class AgentCommandRunner : MonoBehaviour
	{
		private const int MaximumRetainedRuns = 128;
		private const int MaximumActiveRuns = 16;
		private const int MaximumIteratorDepth = 128;
		private const int MaximumImmediateAdvances = 1024;
		private const double MaximumRunSeconds = 300;
		private static AgentCommandRunner instance;
		private static int nextRunNumber;
		private readonly Dictionary<string, RunState> runs = new Dictionary<string, RunState>(StringComparer.Ordinal);
		private readonly List<string> runOrder = new List<string>();
		private int activeCount;
		private bool shuttingDown;
		private bool ticking;

		/// <summary>Cancellation unwinds entered nested iterators before returning.</summary>
		public static bool SupportsDeterministicCancellation => true;

#if UNITY_EDITOR
		static AgentCommandRunner()
		{
			AssemblyReloadEvents.beforeAssemblyReload += CancelBeforeReload;
			EditorApplication.playModeStateChanged += OnPlayModeChanged;
			EditorApplication.quitting += CancelBeforeReload;
		}

		private static void CancelBeforeReload()
		{
			if (instance)
			{
				var owner = instance;
				owner.CancelAll("command_host_reloading: the Editor command host is stopping.");
				DestroyImmediate(owner.gameObject);
			}
		}

		private static void OnPlayModeChanged(PlayModeStateChange change)
		{
			if (change == PlayModeStateChange.ExitingPlayMode && instance)
				instance.CancelAll("command_play_mode_ended: Play Mode is ending.");
		}
#endif

		/// <summary>Schedules Play commands, or executes editor.* commands synchronously in idle Edit Mode.</summary>
		public static AgentCommandRunSnapshot Run(string commandName, string argsJson)
		{
			AgentCommandDescriptor descriptor;
			AgentCommandHandler handler;
			if (!AgentCommandRegistry.TryGet(commandName, out descriptor, out handler))
				return AgentCommandRunSnapshot.Rejected(commandName, "Unknown game command: " + commandName);
			if (!descriptor.RequiresPlayMode)
			{
#if UNITY_EDITOR
				return EditorHost.Run(commandName, argsJson, handler);
#else
				return AgentCommandRunSnapshot.Rejected(commandName, "editor_command_unavailable: editor.* commands do not run in a player.");
#endif
			}
			if (!Application.isPlaying)
				return AgentCommandRunSnapshot.Rejected(commandName, "Game commands require Unity play mode: " + commandName);
			if (instance && (instance.shuttingDown || instance.activeCount >= MaximumActiveRuns))
				return AgentCommandRunSnapshot.Rejected(commandName, "command_host_unavailable: the host is stopping or its active-run limit was reached.");
			var runner = GetOrCreate();
			var state = new RunState(CreateRunId(commandName), commandName, handler, new AgentCommandContext(commandName, argsJson), runner);
			runner.runs.Add(state.RunId, state);
			runner.runOrder.Add(state.RunId);
			runner.activeCount++;
			runner.enabled = true;
			runner.TrimRetainedRuns();
			var coroutine = runner.StartCoroutine(runner.Execute(state));
			if (!state.IsTerminal) state.Coroutine = coroutine;
			return state.Snapshot();
		}

		public static AgentCommandRunSnapshot GetStatus(string runId)
		{
			RunState state;
			return TryGetState(runId, out state) ? state.Snapshot()
				: AgentCommandRunSnapshot.Rejected(string.Empty, "Unknown game command run: " + runId);
		}

		/// <summary>Disposes entered handlers inside-out, even when Unity does not dispose a stopped coroutine.</summary>
		public static AgentCommandRunSnapshot Cancel(string runId)
		{
			RunState state;
			if (!TryGetState(runId, out state))
				return AgentCommandRunSnapshot.Rejected(string.Empty, "Unknown game command run: " + runId);
			if (!state.IsTerminal)
			{
				var coroutine = state.Coroutine;
				state.Finish(AgentCommandStatus.Canceled, AgentCommandResult.Failure("Command run canceled."));
				if (coroutine != null && instance) instance.StopCoroutine(coroutine);
				if (instance) instance.TrimRetainedRuns();
			}
			return state.Snapshot();
		}

		private static bool TryGetState(string runId, out RunState state)
		{
			state = null;
			if (string.IsNullOrEmpty(runId)) return false;
			if (instance && instance.runs.TryGetValue(runId, out state)) return true;
#if UNITY_EDITOR
			return EditorHost.Runs.TryGetValue(runId, out state);
#else
			return false;
#endif
		}

		private static AgentCommandRunner GetOrCreate()
		{
			if (instance) return instance;
			var owner = new GameObject("Unity Cursor Toolkit Agent Command Runner");
			owner.hideFlags = HideFlags.HideAndDontSave;
			DontDestroyOnLoad(owner);
			instance = owner.AddComponent<AgentCommandRunner>();
			return instance;
		}

		private static string CreateRunId(string name)
		{
			nextRunNumber++;
			return name.Replace(".", "_").Replace("/", "_") + "_" + nextRunNumber + "_" + DateTime.UtcNow.Ticks;
		}

		private static double Now => Time.realtimeSinceStartup;

		private IEnumerator Execute(RunState state)
		{
			try
			{
				object current;
				while (state.Advance(false, out current)) yield return current;
			}
			finally
			{
				if (!state.IsTerminal)
					state.Finish(AgentCommandStatus.Canceled, AgentCommandResult.Failure("command_coroutine_stopped: the Unity coroutine ended before its handler."));
				TrimRetainedRuns();
			}
		}

		// Enabled only while commands run. The realtime guard also bounds opaque Unity waits at timeScale=0.
		private void Update()
		{
			ticking = true;
			try
			{
				for (int i = runOrder.Count - 1; i >= 0; i--)
				{
					RunState state = runs[runOrder[i]];
					if (!state.IsTerminal && Now >= state.Deadline)
					{
						var coroutine = state.Coroutine;
						state.Finish(AgentCommandStatus.Failed, AgentCommandResult.Failure("command_timeout: the realtime command deadline elapsed."));
						if (coroutine != null) StopCoroutine(coroutine);
					}
				}
			}
			finally { ticking = false; TrimRetainedRuns(); }
		}

		private void OnEnable() { shuttingDown = false; }
		private void OnDisable()
		{
			if (activeCount > 0) CancelAll("command_host_disabled: the command host was disabled.");
		}
		private void OnDestroy()
		{
			CancelAll("command_host_destroyed: the command host was destroyed.");
			if (instance == this) instance = null;
		}

		private void CancelAll(string reason)
		{
			shuttingDown = true;
			for (int i = runOrder.Count - 1; i >= 0; i--)
			{
				RunState state = runs[runOrder[i]];
				if (!state.IsTerminal) state.Finish(AgentCommandStatus.Canceled, AgentCommandResult.Failure(reason));
			}
			StopAllCoroutines();
		}

		private void Completed()
		{
			activeCount--;
			if (activeCount == 0) enabled = false;
		}

		private void TrimRetainedRuns()
		{
			if (!ticking && !shuttingDown) Trim(runs, runOrder);
		}

		private static void Trim(Dictionary<string, RunState> retained, List<string> order)
		{
			for (int i = 0; i < order.Count && retained.Count > MaximumRetainedRuns; i++)
			{
				if (!retained[order[i]].IsTerminal) continue;
				retained.Remove(order[i]);
				order.RemoveAt(i--);
			}
		}

#if UNITY_EDITOR
		// No Editor update callback or scene object is needed for synchronous authoring handlers.
		private static class EditorHost
		{
			internal static readonly Dictionary<string, RunState> Runs = new Dictionary<string, RunState>(StringComparer.Ordinal);
			private static readonly List<string> order = new List<string>();
			private static int activeCount;

			internal static AgentCommandRunSnapshot Run(string name, string args, AgentCommandHandler handler)
			{
				if (EditorApplication.isPlayingOrWillChangePlaymode || EditorApplication.isCompiling || EditorApplication.isUpdating)
					return AgentCommandRunSnapshot.Rejected(name, "editor_not_ready: editor.* commands require idle Edit Mode.");
				if (activeCount >= MaximumActiveRuns)
					return AgentCommandRunSnapshot.Rejected(name, "editor_command_limit: too many nested synchronous command calls.");
				activeCount++;
				try
				{
					var state = new RunState(CreateRunId(name), name, handler, new AgentCommandContext(name, args), null);
					Runs.Add(state.RunId, state);
					order.Add(state.RunId);
					object unused;
					state.Advance(true, out unused);
					Trim(Runs, order);
					return state.Snapshot();
				}
				finally { activeCount--; }
			}
		}
#endif

		private sealed class RunState
		{
			internal readonly string RunId;
			private readonly string commandName;
			private AgentCommandHandler handler;
			private readonly AgentCommandContext context;
			private readonly AgentCommandRunner owner;
			private readonly List<IEnumerator> stack = new List<IEnumerator>();
			internal double Deadline;
			internal Coroutine Coroutine;
			private AgentCommandStatus status = AgentCommandStatus.Pending;
			private AgentCommandResult result;
			private bool started;
			private bool closing;
			internal bool IsTerminal => status == AgentCommandStatus.Succeeded || status == AgentCommandStatus.Failed || status == AgentCommandStatus.Canceled;

			internal RunState(string runId, string name, AgentCommandHandler handler, AgentCommandContext context, AgentCommandRunner owner)
			{
				RunId = runId;
				commandName = name;
				this.handler = handler;
				this.context = context;
				this.owner = owner;
				Deadline = Now + MaximumRunSeconds;
			}

			internal bool Advance(bool synchronous, out object yielded)
			{
				yielded = null;
				if (IsTerminal || closing) return false;
				status = AgentCommandStatus.Running;
				// The handler and its iterators are the extension boundary. Failures must still release every entered scope.
				try
				{
					if (!started)
					{
						started = true;
						var root = handler(context);
						if (root != null) stack.Add(root);
					}
					for (int advances = 0; advances < MaximumImmediateAdvances; advances++)
					{
#if UNITY_EDITOR
						if (synchronous && (EditorApplication.isPlayingOrWillChangePlaymode || EditorApplication.isCompiling || EditorApplication.isUpdating))
						{
							Finish(AgentCommandStatus.Failed, AgentCommandResult.Failure("editor_mode_changed: the handler changed the idle Edit Mode context."));
							return false;
						}
#endif
						if (Now >= Deadline)
						{
							Finish(AgentCommandStatus.Failed, AgentCommandResult.Failure("command_timeout: the realtime command deadline elapsed."));
							return false;
						}
						if (stack.Count == 0)
						{
							if (!context.HasResult) context.Succeed("Command completed.");
							Finish(context.Result.Success ? AgentCommandStatus.Succeeded : AgentCommandStatus.Failed, context.Result);
							return false;
						}
						var top = stack[stack.Count - 1];
						if (!top.MoveNext())
						{
							stack.RemoveAt(stack.Count - 1);
							try { (top as IDisposable)?.Dispose(); }
							catch (Exception exception)
							{
								Finish(AgentCommandStatus.Failed, AgentCommandResult.Failure("command_cleanup_failed: " + exception.ToString()));
								return false;
							}
							continue;
						}
						if (IsTerminal || closing) return false;
						var current = top.Current;
						var nested = current as IEnumerator;
						if (nested != null)
						{
							if (stack.Count >= MaximumIteratorDepth)
								throw new InvalidOperationException("command_iterator_limit: nested iterator depth limit reached.");
							for (int i = 0; i < stack.Count; i++)
								if (ReferenceEquals(stack[i], nested)) throw new InvalidOperationException("command_iterator_limit: nested iterator cycle detected.");
							stack.Add(nested);
							continue;
						}
						if (synchronous)
						{
							Finish(AgentCommandStatus.Failed, AgentCommandResult.Failure("editor_command_yielded: editor.* handlers must finish synchronously without yielding a frame or Unity wait."));
							return false;
						}
						yielded = current;
						return true;
					}
					Finish(AgentCommandStatus.Failed, AgentCommandResult.Failure("command_iterator_limit: too many immediate iterator advances."));
				}
				catch (Exception exception)
				{
					Finish(AgentCommandStatus.Failed, AgentCommandResult.Failure("command_handler_failed: " + exception.ToString()));
				}
				return false;
			}

			internal void Finish(AgentCommandStatus terminal, AgentCommandResult completion)
			{
				if (IsTerminal || closing) return;
				closing = true;
				string cleanupFailure = null;
				while (stack.Count > 0)
				{
					var current = stack[stack.Count - 1];
					stack.RemoveAt(stack.Count - 1);
					try { (current as IDisposable)?.Dispose(); }
					catch (Exception exception)
					{
						cleanupFailure = (cleanupFailure == null ? string.Empty : cleanupFailure + "; ") + exception.ToString();
					}
				}
				status = cleanupFailure == null ? terminal : AgentCommandStatus.Failed;
				result = cleanupFailure == null ? completion : AgentCommandResult.Failure(completion.Message + " command_cleanup_failed: " + cleanupFailure);
				Coroutine = null;
				handler = null;
				closing = false;
				if (owner) owner.Completed();
			}

			internal AgentCommandRunSnapshot Snapshot() => new AgentCommandRunSnapshot(RunId, commandName, status, result);
		}
	}
}
