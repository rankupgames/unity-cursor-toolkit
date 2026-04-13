// =============================================================================
// Author: Miguel A. Lopez
// Company: Rank Up Games LLC
// Project: Unity Cursor Toolkit
// Description: MCP tool registry and dispatch.
// Created: 2026-03-12
// Last Modified: 2026-03-12
// =============================================================================

#if UNITY_EDITOR

using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using UnityEngine;
using UnityEditor;
using UnityCursorToolkit.Core;

namespace UnityCursorToolkit.MCP
{
	/// <summary>
	/// Registry and dispatcher for MCP tool handlers. Discovers [MCPTool] types via reflection
	/// and routes HandleToolCall invocations to the correct handler.
	/// </summary>
	public static class MCPBridge
	{
		private static Dictionary<string, IToolHandler> _handlers;
		private static bool _initialized;

		/// <summary>
		/// Discovers and registers all [MCPTool] handlers from loaded assemblies.
		/// </summary>
		public static void Initialize()
		{
			if (_initialized == true)
			{
				return;
			}

			_handlers = new Dictionary<string, IToolHandler>();

			foreach (Assembly asm in AppDomain.CurrentDomain.GetAssemblies())
			{
				try
				{
					foreach (Type type in asm.GetTypes())
					{
						var attr = type.GetCustomAttribute<MCPToolAttribute>();
						if (attr == null)
						{
							continue;
						}

						if (typeof(IToolHandler).IsAssignableFrom(type) == false)
						{
							Debug.LogWarning($"[MCPBridge] Type {type.FullName} has [MCPTool] but does not implement IToolHandler.");
							continue;
						}

						try
						{
							var instance = (IToolHandler) Activator.CreateInstance(type);
							string name = attr.Name;
							if (_handlers.ContainsKey(name) == true)
							{
								Debug.LogWarning($"[MCPBridge] Duplicate tool name: {name}. Overwriting.");
							}
							_handlers[name] = instance;
						}
						catch (Exception ex)
						{
							Debug.LogError($"[MCPBridge] Failed to instantiate {type.FullName}: {ex.Message}");
						}
					}
				}
				catch (ReflectionTypeLoadException)
				{
					// Skip assemblies that fail to load
				}
			}

			_initialized = true;
			Debug.Log($"[MCPBridge] Registered {_handlers.Count} tool(s): {string.Join(", ", _handlers.Keys)}");
		}

		/// <summary>
		/// Dispatches a tool call to the registered handler and sends the result via BroadcastToClients.
		/// Runs on main thread via EditorApplication.delayCall.
		/// </summary>
		/// <param name="toolName">Name of the tool.</param>
		/// <param name="argsJson">JSON arguments for the tool.</param>
		public static void HandleToolCall(string toolName, string argsJson)
		{
			EditorApplication.delayCall += () =>
			{
				string result = null;
				try
				{
					if (_initialized == false)
					{
						Initialize();
					}

					if (_handlers.TryGetValue(toolName, out IToolHandler handler) == false)
					{
						result = BuildErrorJson($"Unknown tool: {toolName}");
					}
					else
					{
						result = handler.HandleCommand(argsJson ?? "{}");
					}
				}
				catch (Exception ex)
				{
					result = BuildErrorJson(ex.Message);
				}

				if (result != null)
				{
					string payload = "{\"command\":\"mcpToolResult\",\"tool\":\"" + EscapeJson(toolName) + "\",\"result\":" + result + "}";
					HotReloadHandler.BroadcastToClients(payload);
				}
			};
		}

		private static string BuildErrorJson(string message)
		{
			return "{\"success\":false,\"error\":\"" + EscapeJson(message) + "\"}";
		}

		private static string EscapeJson(string s)
		{
			if (string.IsNullOrEmpty(s) == true) return "";
			return s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\n", "\\n").Replace("\r", "\\r").Replace("\t", "\\t");
		}
	}
}

#endif
