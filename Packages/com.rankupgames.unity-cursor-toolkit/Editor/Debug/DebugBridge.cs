/*
 * DebugBridge.cs
 *
 * Provides debug port discovery for Unity's Mono soft debugger.
 * Reads -debuggerPort from command line or uses default. Broadcasts port via HotReloadHandler.
 *
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 */

#if UNITY_EDITOR

using System;
using System.Linq;

using UnityEngine;
using UnityCursorToolkit;

namespace UnityCursorToolkit.Debugging
{
	/// <summary>
	/// Bridge for debug port discovery and broadcast. Editor-only.
	/// </summary>
	public static class DebugBridge
	{
		private const int DEFAULT_MONO_DEBUG_PORT = 56000;
		private const string DEBUGGER_PORT_ARG = "-debuggerPort";

		private static int? _cachedPort;

		/// <summary>
		/// Gets the Mono debug port from Unity command line args or default.
		/// </summary>
		public static int GetDebugPort()
		{
			if (_cachedPort.HasValue)
			{
				return _cachedPort.Value;
			}

			string[] args = Environment.GetCommandLineArgs();
			if (args == null)
			{
				_cachedPort = DEFAULT_MONO_DEBUG_PORT;
				return _cachedPort.Value;
			}

			for (int i = 0; i < args.Length - 1; i++)
			{
				if (string.Equals(args[i], DEBUGGER_PORT_ARG, StringComparison.OrdinalIgnoreCase) == true)
				{
					if (int.TryParse(args[i + 1], out int port) == true && port > 0)
					{
						_cachedPort = port;
						return _cachedPort.Value;
					}
				}
			}

			_cachedPort = DEFAULT_MONO_DEBUG_PORT;
			return _cachedPort.Value;
		}

		/// <summary>
		/// Returns whether the editor supports debugging.
		/// </summary>
		public static bool IsDebuggable()
		{
			return Application.isEditor == true;
		}

		/// <summary>
		/// Broadcasts the debug port to connected clients via HotReloadHandler.
		/// Call when the extension requests debug port info.
		/// </summary>
		public static bool BroadcastDebugPort()
		{
			int port = GetDebugPort();
			string payload = "{\"command\":\"debugPort\",\"port\":" + port + "}";
			return HotReloadHandler.BroadcastToClients(payload);
		}
	}
}

#endif
