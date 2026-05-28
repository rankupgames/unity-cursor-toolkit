// =============================================================================
// Author: Miguel A. Lopez
// Company: Rank Up Games LLC
// Project: Unity Cursor Toolkit
// Description: Serializable status snapshot for scheduled agent command runs.
// Created: 2026-05-28
// Last Modified: 2026-05-28
// =============================================================================

using System.Text;

namespace UnityCursorToolkit.AgentCommands
{
	/// <summary>
	/// Represents the current state of a scheduled command run for MCP polling.
	/// </summary>
	public sealed class AgentCommandRunSnapshot
	{
		/// <summary>
		/// Unique identifier for polling or cancellation.
		/// </summary>
		public string RunId { get; }

		/// <summary>
		/// Command name associated with this run.
		/// </summary>
		public string CommandName { get; }

		/// <summary>
		/// Current command execution status.
		/// </summary>
		public AgentCommandStatus Status { get; }

		/// <summary>
		/// Optional completion payload when the command has ended.
		/// </summary>
		public AgentCommandResult Result { get; }

		/// <summary>
		/// Creates a status snapshot for a command run.
		/// </summary>
		/// <param name="runId">Unique identifier for polling or cancellation.</param>
		/// <param name="commandName">Command name associated with this run.</param>
		/// <param name="status">Current command execution status.</param>
		/// <param name="result">Optional completion payload when the command has ended.</param>
		public AgentCommandRunSnapshot(string runId, string commandName, AgentCommandStatus status, AgentCommandResult result)
		{
			RunId = runId ?? string.Empty;
			CommandName = commandName ?? string.Empty;
			Status = status;
			Result = result;
		}

		/// <summary>
		/// Creates a failed snapshot for validation errors that prevent scheduling.
		/// </summary>
		/// <param name="commandName">Requested command name.</param>
		/// <param name="message">Failure reason.</param>
		/// <returns>Failed command snapshot.</returns>
		public static AgentCommandRunSnapshot Rejected(string commandName, string message)
		{
			return new AgentCommandRunSnapshot(string.Empty, commandName, AgentCommandStatus.Failed, AgentCommandResult.Failure(message));
		}

		/// <summary>
		/// Serializes this snapshot into a JSON object.
		/// </summary>
		/// <returns>JSON object containing run status and optional result.</returns>
		public string ToJson()
		{
			StringBuilder builder = new StringBuilder();
			builder.Append("{");
			AgentCommandJson.AppendProperty(builder, "success", Status != AgentCommandStatus.Failed && Status != AgentCommandStatus.Canceled).Append(",");
			AgentCommandJson.AppendProperty(builder, "runId", RunId).Append(",");
			AgentCommandJson.AppendProperty(builder, "commandName", CommandName).Append(",");
			AgentCommandJson.AppendProperty(builder, "status", Status.ToString()).Append(",");
			builder.Append("\"result\":");
			if (Result == null)
			{
				builder.Append("null");
			}
			else
			{
				Result.AppendJson(builder);
			}
			builder.Append("}");
			return builder.ToString();
		}
	}
}
