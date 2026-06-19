// =============================================================================
// Author: Miguel A. Lopez
// Company: Rank Up Games LLC
// Project: Unity Cursor Toolkit
// Description: Metadata for runtime commands exposed to MCP agents.
// Created: 2026-05-28
// Last Modified: 2026-05-28
// =============================================================================

using System.Text;

namespace UnityCursorToolkit.AgentCommands
{
	/// <summary>
	/// Describes a game-authored command so agents can discover stable command names and constraints.
	/// </summary>
	public sealed class AgentCommandDescriptor
	{
		/// <summary>
		/// Stable command identifier used by MCP callers.
		/// </summary>
		public string Name { get; }

		/// <summary>
		/// Human-readable explanation of what the command triggers.
		/// </summary>
		public string Description { get; }

		/// <summary>
		/// Creates command metadata for registry discovery.
		/// </summary>
		/// <param name="name">Stable command identifier used by MCP callers.</param>
		/// <param name="description">Human-readable explanation of what the command triggers.</param>
		public AgentCommandDescriptor(string name, string description)
		{
			Name = name;
			Description = description ?? string.Empty;
		}

		/// <summary>
		/// Appends this descriptor as a JSON object for MCP responses.
		/// </summary>
		/// <param name="builder">Response builder that receives the JSON object.</param>
		public void AppendJson(StringBuilder builder)
		{
			builder.Append("{");
			AgentCommandJson.AppendProperty(builder, "name", Name).Append(",");
			AgentCommandJson.AppendProperty(builder, "description", Description).Append(",");
			AgentCommandJson.AppendProperty(builder, "requiresPlayMode", true).Append(",");
			AgentCommandJson.AppendProperty(builder, "supportsBatchmode", false).Append(",");
			builder.Append("\"supportedHosts\":[\"editor\",\"auto\"]");
			builder.Append("}");
		}
	}
}
