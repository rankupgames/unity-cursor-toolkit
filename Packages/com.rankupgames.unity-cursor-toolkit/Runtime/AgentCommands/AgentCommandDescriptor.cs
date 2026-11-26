// =============================================================================
// Author: Miguel A. Lopez
// Company: Rank Up Games LLC
// Project: Unity Cursor Toolkit
// Description: Metadata for runtime commands exposed to MCP agents.
// Created: 2026-05-28
// Last Modified: 2026-05-28
// =============================================================================

using System;
using System.Collections.Generic;
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

		/// <summary>Optional project-authored destinations displayed by the Game Flow window.</summary>
		public IReadOnlyList<GameFlowDestination> FlowDestinations { get; }

		/// <summary>editor.* commands are synchronous authoring operations and are excluded from player execution.</summary>
		public bool RequiresPlayMode => string.IsNullOrEmpty(Name) || !Name.StartsWith("editor.", StringComparison.Ordinal);

		/// <summary>The host contract used for command execution.</summary>
		public string ExecutionMode => RequiresPlayMode ? "play" : "editorSynchronous";


		/// <summary>
		/// True when this command is intended as a viewport input adapter.
		/// </summary>
		public bool SupportsViewportInput
		{
			get
			{
				return string.IsNullOrEmpty(Name) == false && Name.StartsWith("viewport.");
			}
		}

		/// <summary>
		/// Creates command metadata for registry discovery.
		/// </summary>
		/// <param name="name">Stable command identifier used by MCP callers.</param>
		/// <param name="description">Human-readable explanation of what the command triggers.</param>
		public AgentCommandDescriptor(string name, string description)
			: this(name, description, null)
		{
		}

		internal AgentCommandDescriptor(string name, string description, IEnumerable<GameFlowDestination> flowDestinations)
		{
			Name = name;
			Description = description ?? string.Empty;
			FlowDestinations = Array.Empty<GameFlowDestination>();
			if (flowDestinations == null) return;

			var items = new List<GameFlowDestination>();
			var ids = new HashSet<string>(StringComparer.Ordinal);
			foreach (GameFlowDestination destination in flowDestinations)
			{
				if (destination == null || !ids.Add(destination.Id))
					throw new ArgumentException("Flow destinations must have unique IDs.", nameof(flowDestinations));
				items.Add(destination);
			}
			FlowDestinations = items.AsReadOnly();
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
			AgentCommandJson.AppendProperty(builder, "executionMode", ExecutionMode).Append(",");
			AgentCommandJson.AppendProperty(builder, "requiresPlayMode", RequiresPlayMode).Append(",");
			AgentCommandJson.AppendProperty(builder, "supportsBatchmode", !RequiresPlayMode).Append(",");
			AgentCommandJson.AppendProperty(builder, "supportsViewportInput", SupportsViewportInput).Append(",");
			builder.Append(RequiresPlayMode ? "\"supportedHosts\":[\"editor\",\"player\",\"auto\"]" : "\"supportedHosts\":[\"editor\",\"editorBatchmode\"]");
			builder.Append("}");
		}
	}
}
