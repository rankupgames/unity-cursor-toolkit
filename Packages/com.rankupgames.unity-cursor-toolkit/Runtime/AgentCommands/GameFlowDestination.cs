using System;

namespace UnityCursorToolkit.AgentCommands
{
	/// <summary>A project-authored destination listed under a registered command in Game Flow.</summary>
	public sealed class GameFlowDestination
	{
		/// <summary>Stable selection key unique within the command.</summary>
		public string Id { get; }

		/// <summary>Project-defined group, such as menus or diagnostics.</summary>
		public string Category { get; }

		/// <summary>Display name in the Game Flow window.</summary>
		public string Label { get; }

		/// <summary>Arguments supplied to the registered command when this destination is chosen.</summary>
		public string ArgumentsJson { get; }

		/// <summary>Reason that a destination cannot run. An empty value means it is available.</summary>
		public string UnavailableReason { get; }

		/// <summary>Creates one selectable destination for a project-owned command.</summary>
		public GameFlowDestination(string id, string category, string label, string argumentsJson = "{}", string unavailableReason = "")
		{
			if (string.IsNullOrWhiteSpace(id)) throw new ArgumentException("A destination ID is required.", nameof(id));
			if (string.IsNullOrWhiteSpace(category)) throw new ArgumentException("A destination category is required.", nameof(category));
			if (string.IsNullOrWhiteSpace(label)) throw new ArgumentException("A destination label is required.", nameof(label));
			Id = id;
			Category = category;
			Label = label;
			ArgumentsJson = string.IsNullOrWhiteSpace(argumentsJson) ? "{}" : argumentsJson;
			UnavailableReason = unavailableReason ?? string.Empty;
		}
	}
}
