// =============================================================================
// Author: Miguel A. Lopez
// Company: Rank Up Games LLC
// Project: Unity Cursor Toolkit
// Description: Runtime status values for scheduled agent command runs.
// Created: 2026-05-28
// Last Modified: 2026-05-28
// =============================================================================

namespace UnityCursorToolkit.AgentCommands
{
	/// <summary>
	/// Represents the lifecycle state of a command scheduled through the MCP bridge.
	/// </summary>
	public enum AgentCommandStatus
	{
		/// <summary>
		/// The run has been created but the handler has not started yet.
		/// </summary>
		Pending,

		/// <summary>
		/// The handler coroutine is still executing.
		/// </summary>
		Running,

		/// <summary>
		/// The handler completed and reported success.
		/// </summary>
		Succeeded,

		/// <summary>
		/// The handler failed validation, threw an exception, or reported failure.
		/// </summary>
		Failed,

		/// <summary>
		/// The run was stopped by a cancellation request.
		/// </summary>
		Canceled
	}
}
