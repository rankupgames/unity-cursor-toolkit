using System;
using System.Collections;

namespace UnityCursorToolkit.AgentCommands
{
	/// <summary>The action, wait, or result selected by a project for the current route state.</summary>
	public sealed class GameFlowStep
	{
		internal string StateKey { get; }
		internal string Progress { get; }
		internal Func<IEnumerator> Action { get; }
		internal double WaitSeconds { get; }
		internal AgentCommandResult Result { get; }

		private GameFlowStep(string stateKey, string progress, Func<IEnumerator> action, double waitSeconds, AgentCommandResult result)
		{
			StateKey = stateKey;
			Progress = progress;
			Action = action;
			WaitSeconds = waitSeconds;
			Result = result;
		}

		/// <summary>Creates one owned action after the route checks its limit. The state key should change only when the project actually advances.</summary>
		public static GameFlowStep Act(string stateKey, string progress, Func<IEnumerator> action)
		{
			if (action == null) throw new ArgumentNullException(nameof(action));
			return new GameFlowStep(stateKey, progress, action, 0, null);
		}

		/// <summary>Waits for the observed state to change within the supplied realtime limit.</summary>
		public static GameFlowStep Wait(string stateKey, string progress, double seconds)
		{
			if (seconds <= 0 || double.IsNaN(seconds) || double.IsInfinity(seconds))
				throw new ArgumentOutOfRangeException(nameof(seconds));
			return new GameFlowStep(stateKey, progress, null, seconds, null);
		}

		/// <summary>Ends the route with the project-owned success or failure result.</summary>
		public static GameFlowStep Finish(AgentCommandResult result)
		{
			if (result == null) throw new ArgumentNullException(nameof(result));
			return new GameFlowStep(null, null, null, 0, result);
		}
	}
}
