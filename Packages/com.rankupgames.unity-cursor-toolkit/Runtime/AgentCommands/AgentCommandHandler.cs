// =============================================================================
// Author: Miguel A. Lopez
// Company: Rank Up Games LLC
// Project: Unity Cursor Toolkit
// Description: Delegate contract for runtime agent command handlers.
// Created: 2026-05-28
// Last Modified: 2026-05-28
// =============================================================================

using System.Collections;

namespace UnityCursorToolkit.AgentCommands
{
	/// <summary>
	/// Runs a game-authored command as a coroutine so workflows can wait for Unity/network state.
	/// </summary>
	/// <param name="context">Command context with raw arguments and completion helpers.</param>
	/// <returns>Coroutine sequence for the command run.</returns>
	public delegate IEnumerator AgentCommandHandler(AgentCommandContext context);
}
