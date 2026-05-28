// =============================================================================
// Author: Miguel A. Lopez
// Company: Rank Up Games LLC
// Project: Unity Cursor Toolkit
// Description: Structured completion payload for runtime agent commands.
// Created: 2026-05-28
// Last Modified: 2026-05-28
// =============================================================================

using System.Text;

namespace UnityCursorToolkit.AgentCommands
{
	/// <summary>
	/// Captures success, failure, and optional command-specific JSON output.
	/// </summary>
	public sealed class AgentCommandResult
	{
		/// <summary>
		/// True when the command completed successfully.
		/// </summary>
		public bool Success { get; }

		/// <summary>
		/// Human-readable completion or failure message.
		/// </summary>
		public string Message { get; }

		/// <summary>
		/// Optional command-specific JSON object or array.
		/// </summary>
		public string DataJson { get; }

		/// <summary>
		/// Creates a structured command result.
		/// </summary>
		/// <param name="success">True when the command completed successfully.</param>
		/// <param name="message">Human-readable completion or failure message.</param>
		/// <param name="dataJson">Optional command-specific JSON object or array.</param>
		private AgentCommandResult(bool success, string message, string dataJson)
		{
			Success = success;
			Message = message ?? string.Empty;
			DataJson = dataJson;
		}

		/// <summary>
		/// Creates a successful command result.
		/// </summary>
		/// <param name="message">Human-readable completion summary.</param>
		/// <param name="dataJson">Optional command-specific JSON object or array.</param>
		/// <returns>Successful command result.</returns>
		public static AgentCommandResult Succeeded(string message = "", string dataJson = null)
		{
			return new AgentCommandResult(true, message, dataJson);
		}

		/// <summary>
		/// Creates a failed command result.
		/// </summary>
		/// <param name="message">Failure reason visible to MCP status polling.</param>
		/// <returns>Failed command result.</returns>
		public static AgentCommandResult Failure(string message)
		{
			return new AgentCommandResult(false, message, null);
		}

		/// <summary>
		/// Serializes this result into a JSON object.
		/// </summary>
		/// <returns>JSON object containing success, message, and data fields.</returns>
		public string ToJson()
		{
			StringBuilder builder = new StringBuilder();
			AppendJson(builder);
			return builder.ToString();
		}

		/// <summary>
		/// Appends this result into an existing JSON response.
		/// </summary>
		/// <param name="builder">Response builder receiving the result object.</param>
		public void AppendJson(StringBuilder builder)
		{
			builder.Append("{");
			AgentCommandJson.AppendProperty(builder, "success", Success).Append(",");
			AgentCommandJson.AppendProperty(builder, "message", Message).Append(",");
			builder.Append("\"data\":");
			AgentCommandJson.AppendRawJsonOrNull(builder, DataJson);
			builder.Append("}");
		}
	}
}
