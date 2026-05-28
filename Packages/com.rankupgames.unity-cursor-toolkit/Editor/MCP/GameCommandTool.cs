// =============================================================================
// Author: Miguel A. Lopez
// Company: Rank Up Games LLC
// Project: Unity Cursor Toolkit
// Description: MCP adapter for runtime game-authored agent commands.
// Created: 2026-05-28
// Last Modified: 2026-05-28
// =============================================================================

#if UNITY_EDITOR

using UnityCursorToolkit.AgentCommands;
using UnityCursorToolkit.Core;

namespace UnityCursorToolkit.MCP
{
	/// <summary>
	/// Exposes the runtime agent command registry through the existing Unity MCP bridge.
	/// </summary>
	[MCPTool("game_command")]
	internal sealed class GameCommandTool : IToolHandler
	{
		/// <summary>
		/// Tool name used by MCP clients.
		/// </summary>
		public string ToolName => "game_command";

		/// <summary>
		/// Human-readable tool description for local registry diagnostics.
		/// </summary>
		public string Description => "List, schedule, poll, or cancel game-authored runtime agent commands.";

		/// <summary>
		/// Routes game command actions to the runtime command registry and runner.
		/// </summary>
		/// <param name="argsJson">JSON string containing action and command arguments.</param>
		/// <returns>JSON result for the requested game command action.</returns>
		public string HandleCommand(string argsJson)
		{
			string action = GameCommandToolJson.GetString(argsJson, "action", "list");
			switch (action)
			{
				case "list":
					return AgentCommandRegistry.ToCatalogJson();
				case "run":
					return RunCommand(argsJson);
				case "status":
					return ReadStatus(argsJson);
				case "cancel":
					return CancelCommand(argsJson);
				default:
					return GameCommandToolJson.Error("Unknown game_command action: " + action);
			}
		}

		/// <summary>
		/// Schedules a registered command and returns its run id.
		/// </summary>
		/// <param name="argsJson">JSON arguments containing commandName and optional args object.</param>
		/// <returns>JSON status snapshot for the scheduled or rejected run.</returns>
		private string RunCommand(string argsJson)
		{
			string commandName = GameCommandToolJson.GetString(argsJson, "commandName", GameCommandToolJson.GetString(argsJson, "name", string.Empty));
			if (string.IsNullOrEmpty(commandName))
			{
				return GameCommandToolJson.Error("commandName is required for game_command action run.");
			}

			string commandArgsJson = GameCommandToolJson.GetObject(argsJson, "args") ?? "{}";
			return AgentCommandRunner.Run(commandName, commandArgsJson).ToJson();
		}

		/// <summary>
		/// Reads the retained status for a scheduled command run.
		/// </summary>
		/// <param name="argsJson">JSON arguments containing runId.</param>
		/// <returns>JSON status snapshot for the run.</returns>
		private string ReadStatus(string argsJson)
		{
			string runId = GameCommandToolJson.GetString(argsJson, "runId", GameCommandToolJson.GetString(argsJson, "id", string.Empty));
			if (string.IsNullOrEmpty(runId))
			{
				return GameCommandToolJson.Error("runId is required for game_command action status.");
			}

			return AgentCommandRunner.GetStatus(runId).ToJson();
		}

		/// <summary>
		/// Cancels a running command coroutine.
		/// </summary>
		/// <param name="argsJson">JSON arguments containing runId.</param>
		/// <returns>JSON status snapshot after cancellation.</returns>
		private string CancelCommand(string argsJson)
		{
			string runId = GameCommandToolJson.GetString(argsJson, "runId", GameCommandToolJson.GetString(argsJson, "id", string.Empty));
			if (string.IsNullOrEmpty(runId))
			{
				return GameCommandToolJson.Error("runId is required for game_command action cancel.");
			}

			return AgentCommandRunner.Cancel(runId).ToJson();
		}
	}
}

#endif
