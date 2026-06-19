// =============================================================================
// Author: Miguel A. Lopez
// Company: Rank Up Games LLC
// Project: Unity Cursor Toolkit
// Description: Runtime registry for game-authored commands exposed through MCP.
// Created: 2026-05-28
// Last Modified: 2026-05-28
// =============================================================================

using System;
using System.Collections.Generic;
using System.Text;

namespace UnityCursorToolkit.AgentCommands
{
	/// <summary>
	/// Stores game-authored commands that agents can discover and schedule through the MCP bridge.
	/// </summary>
	public static class AgentCommandRegistry
	{
		/// <summary>
		/// Registered command metadata and handler pairs keyed by stable command name.
		/// </summary>
		private static readonly Dictionary<string, AgentCommandRegistration> registrations = new Dictionary<string, AgentCommandRegistration>(StringComparer.Ordinal);

		/// <summary>
		/// Registers or replaces a command callable through the generic MCP game command tool.
		/// </summary>
		/// <param name="name">Stable command identifier used by MCP callers.</param>
		/// <param name="description">Human-readable explanation of what the command triggers.</param>
		/// <param name="handler">Coroutine handler that executes the command.</param>
		public static void Register(string name, string description, AgentCommandHandler handler)
		{
			if (string.IsNullOrEmpty(name))
			{
				throw new ArgumentException("Command name is required.", "name");
			}

			if (handler == null)
			{
				throw new ArgumentNullException("handler");
			}

			AgentCommandDescriptor descriptor = new AgentCommandDescriptor(name, description);
			registrations[name] = new AgentCommandRegistration(descriptor, handler);
		}

		/// <summary>
		/// Removes a command registration owned by a game subsystem.
		/// </summary>
		/// <param name="name">Stable command identifier to remove.</param>
		/// <returns>True when a command was removed.</returns>
		public static bool Unregister(string name)
		{
			if (string.IsNullOrEmpty(name))
			{
				return false;
			}

			return registrations.Remove(name);
		}

		/// <summary>
		/// Attempts to resolve a command descriptor and handler by name.
		/// </summary>
		/// <param name="name">Stable command identifier requested by MCP.</param>
		/// <param name="descriptor">Resolved command metadata when found.</param>
		/// <param name="handler">Resolved command handler when found.</param>
		/// <returns>True when the command exists.</returns>
		public static bool TryGet(string name, out AgentCommandDescriptor descriptor, out AgentCommandHandler handler)
		{
			descriptor = null;
			handler = null;

			if (string.IsNullOrEmpty(name))
			{
				return false;
			}

			AgentCommandRegistration registration;
			if (registrations.TryGetValue(name, out registration) == false)
			{
				return false;
			}

			descriptor = registration.Descriptor;
			handler = registration.Handler;
			return true;
		}

		/// <summary>
		/// Returns a snapshot of all registered command descriptors.
		/// </summary>
		/// <returns>Registered command descriptors sorted by command name.</returns>
		public static AgentCommandDescriptor[] GetCommands()
		{
			AgentCommandDescriptor[] descriptors = new AgentCommandDescriptor[registrations.Count];
			int index = 0;

			foreach (AgentCommandRegistration registration in registrations.Values)
			{
				descriptors[index] = registration.Descriptor;
				index++;
			}

			Array.Sort(descriptors, CompareDescriptorsByName);
			return descriptors;
		}

		/// <summary>
		/// Orders command descriptors by stable command name so catalog output is deterministic.
		/// </summary>
		/// <param name="left">First descriptor being compared.</param>
		/// <param name="right">Second descriptor being compared.</param>
		/// <returns>Ordinal name comparison result.</returns>
		private static int CompareDescriptorsByName(AgentCommandDescriptor left, AgentCommandDescriptor right)
		{
			string leftName = left == null ? string.Empty : left.Name;
			string rightName = right == null ? string.Empty : right.Name;
			return string.Compare(leftName, rightName, StringComparison.Ordinal);
		}

		/// <summary>
		/// Serializes the registered command catalog for MCP list responses.
		/// </summary>
		/// <returns>JSON object containing the command catalog.</returns>
		public static string ToCatalogJson()
		{
			AgentCommandDescriptor[] descriptors = GetCommands();
			StringBuilder builder = new StringBuilder();
			builder.Append("{\"success\":true,\"commands\":[");

			for (int i = 0; i < descriptors.Length; i++)
			{
				if (i > 0)
				{
					builder.Append(",");
				}

				descriptors[i].AppendJson(builder);
			}

			builder.Append("],\"capabilities\":{");
			builder.Append("\"supportedHosts\":[\"editor\",\"editorBatchmode\",\"auto\"],");
			builder.Append("\"batchmodeEntry\":\"UnityCursorToolkit.AgentCommands.BatchCommandEntry.Run\"");
			builder.Append("}}");
			return builder.ToString();
		}

		/// <summary>
		/// Internal pair of metadata and command execution delegate.
		/// </summary>
		private sealed class AgentCommandRegistration
		{
			/// <summary>
			/// Metadata returned to agents during command discovery.
			/// </summary>
			public AgentCommandDescriptor Descriptor { get; }

			/// <summary>
			/// Coroutine delegate used when the command is scheduled.
			/// </summary>
			public AgentCommandHandler Handler { get; }

			/// <summary>
			/// Creates an immutable registry entry.
			/// </summary>
			/// <param name="descriptor">Metadata returned to agents during command discovery.</param>
			/// <param name="handler">Coroutine delegate used when the command is scheduled.</param>
			public AgentCommandRegistration(AgentCommandDescriptor descriptor, AgentCommandHandler handler)
			{
				Descriptor = descriptor;
				Handler = handler;
			}
		}
	}
}
