// =============================================================================
// Author: Miguel A. Lopez
// Company: Rank Up Games LLC
// Project: Unity Cursor Toolkit
// Description: Attribute for auto-registering MCP tool handlers.
// Created: 2026-03-12
// Last Modified: 2026-03-12
// =============================================================================

using System;

namespace UnityCursorToolkit.Core
{
	/// <summary>
	/// Marks a class as an MCP tool handler with the given name for auto-registration.
	/// </summary>
	[AttributeUsage(AttributeTargets.Class, AllowMultiple = false)]
	public class MCPToolAttribute : Attribute
	{
		/// <summary>
		/// The unique name used to register and identify this tool.
		/// </summary>
		public string Name { get; }

		/// <summary>
		/// Creates a new MCPTool attribute with the specified tool name.
		/// </summary>
		/// <param name="name">Unique identifier for the tool.</param>
		public MCPToolAttribute(string name)
		{
			Name = name;
		}
	}
}
