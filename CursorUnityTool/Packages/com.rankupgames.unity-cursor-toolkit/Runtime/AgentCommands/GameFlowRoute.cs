using System;
using System.Collections;
using UnityEngine;

namespace UnityCursorToolkit.AgentCommands
{
	/// <summary>Runs bounded project-selected steps inside an existing agent command.</summary>
	public static class GameFlowRoute
	{
		/// <summary>Yields each action to the command runner so it retains cancellation ownership.</summary>
		/// <param name="context">Context of the registered route command.</param>
		/// <param name="selectStep">Reads project state and selects its next action, wait, or result.</param>
		/// <param name="actionLimit">Maximum number of actions permitted before the route must finish.</param>
		public static IEnumerator Run(AgentCommandContext context, Func<GameFlowStep> selectStep, int actionLimit = 32)
		{
			if (context == null) throw new ArgumentNullException(nameof(context));
			if (selectStep == null) throw new ArgumentNullException(nameof(selectStep));
			if (actionLimit < 1) throw new ArgumentOutOfRangeException(nameof(actionLimit));

			string lastState = null;
			double stateSince = Time.realtimeSinceStartup;
			int actions = 0;
			while (!context.HasResult)
			{
				GameFlowStep step = selectStep();
				if (step == null)
				{
					context.Fail("flow_step_missing: a route must select an action, wait, or result.");
					yield break;
				}
				if (step.Result != null)
				{
					if (step.Result.Success) context.Succeed(step.Result.Message, step.Result.DataJson);
					else context.Fail(step.Result.Message);
					yield break;
				}

				double now = Time.realtimeSinceStartup;
				if (!string.Equals(lastState, step.StateKey, StringComparison.Ordinal))
				{
					lastState = step.StateKey;
					stateSince = now;
				}
				context.ReportProgress(step.Progress);
				if (step.Action != null)
				{
					if (actions == actionLimit)
					{
						context.Fail("flow_action_limit: the route exhausted its action limit.");
						yield break;
					}
					IEnumerator action = step.Action();
					if (action == null)
					{
						context.Fail("flow_action_missing: the selected action could not start.");
						yield break;
					}
					actions++;
					yield return action;
				}
				else
				{
					if (now - stateSince >= step.WaitSeconds)
					{
						context.Fail("flow_transition_timeout: the route state did not advance.");
						yield break;
					}
					yield return null;
				}
			}
		}
	}
}
