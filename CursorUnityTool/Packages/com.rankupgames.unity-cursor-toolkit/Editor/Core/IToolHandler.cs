// =============================================================================
// Author: Miguel A. Lopez
// Company: Rank Up Games LLC
// Project: Unity Cursor Toolkit
// Description: Interface for MCP tool handlers.
// Created: 2026-03-12
// Last Modified: 2026-03-12
// =============================================================================

namespace UnityCursorToolkit.Core
{
	/// <summary>
	/// Interface for MCP tool handlers that execute commands and return JSON results.
	/// </summary>
	public interface IToolHandler
	{
		/// <summary>
		/// Unique identifier for the tool.
		/// </summary>
		string ToolName { get; }

		/// <summary>
		/// Human-readable description of the tool's purpose.
		/// </summary>
		string Description { get; }

		/// <summary>
		/// Executes the tool with the given JSON arguments and returns a JSON result.
		/// </summary>
		/// <param name="argsJson">JSON string containing tool arguments.</param>
		/// <returns>JSON string containing the tool result.</returns>
		string HandleCommand(string argsJson);
	}
}
