// =============================================================================
// Author: Miguel A. Lopez
// Company: Rank Up Games LLC
// Project: Unity Cursor Toolkit
// Description: Runtime context passed to game-authored agent command handlers.
// Created: 2026-05-28
// Last Modified: 2026-05-28
// =============================================================================

using UnityEngine;

namespace UnityCursorToolkit.AgentCommands
{
	/// <summary>
	/// Provides command metadata, raw JSON arguments, and completion helpers to game-authored command handlers.
	/// </summary>
	public sealed class AgentCommandContext
	{
		/// <summary>
		/// Registered command name selected by the MCP caller.
		/// </summary>
		public string CommandName { get; }

		/// <summary>
		/// Raw JSON object supplied as the command arguments.
		/// </summary>
		public string ArgsJson { get; }

		/// <summary>
		/// True after a command explicitly reports success or failure.
		/// </summary>
		public bool HasResult { get; private set; }

		/// <summary>
		/// Structured command completion payload captured for status polling.
		/// </summary>
		public AgentCommandResult Result { get; private set; }

		/// <summary>
		/// Creates a context for a scheduled command run.
		/// </summary>
		/// <param name="commandName">Registered command name selected by the MCP caller.</param>
		/// <param name="argsJson">Raw JSON object supplied as the command arguments.</param>
		public AgentCommandContext(string commandName, string argsJson)
		{
			CommandName = commandName;
			ArgsJson = string.IsNullOrEmpty(argsJson) ? "{}" : argsJson;
		}

		/// <summary>
		/// Parses the raw argument object into a Unity-serializable type owned by the game command.
		/// </summary>
		/// <typeparam name="T">Serializable argument type expected by the command.</typeparam>
		/// <returns>Parsed argument instance.</returns>
		public T ReadArgs<T>()
		{
			return JsonUtility.FromJson<T>(ArgsJson);
		}

		/// <summary>
		/// Marks the command as completed successfully.
		/// </summary>
		/// <param name="message">Human-readable completion summary.</param>
		/// <param name="dataJson">Optional raw JSON object or array with command-specific output.</param>
		public void Succeed(string message = "", string dataJson = null)
		{
			HasResult = true;
			Result = AgentCommandResult.Succeeded(message, dataJson);
		}

		/// <summary>
		/// Marks the command as failed and stops the runner from reporting a successful coroutine completion.
		/// </summary>
		/// <param name="message">Failure reason visible to MCP status polling.</param>
		public void Fail(string message)
		{
			HasResult = true;
			Result = AgentCommandResult.Failure(message);
		}
	}
}
