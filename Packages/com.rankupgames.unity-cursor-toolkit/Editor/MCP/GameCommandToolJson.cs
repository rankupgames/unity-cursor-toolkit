// =============================================================================
// Author: Miguel A. Lopez
// Company: Rank Up Games LLC
// Project: Unity Cursor Toolkit
// Description: JSON argument helpers for the game command MCP adapter.
// Created: 2026-05-28
// Last Modified: 2026-05-28
// =============================================================================

#if UNITY_EDITOR

using UnityCursorToolkit.AgentCommands;

namespace UnityCursorToolkit.MCP
{
	/// <summary>
	/// Reads simple values from MCP JSON payloads without requiring a third-party JSON package.
	/// </summary>
	internal static class GameCommandToolJson
	{
		/// <summary>
		/// Extracts a string property from a JSON object.
		/// </summary>
		/// <param name="json">JSON object to inspect.</param>
		/// <param name="key">Property name to read.</param>
		/// <param name="defaultValue">Fallback value when the property is missing.</param>
		/// <returns>String property value or the fallback.</returns>
		internal static string GetString(string json, string key, string defaultValue)
		{
			string search = "\"" + key + "\"";
			int keyIndex = string.IsNullOrEmpty(json) ? -1 : json.IndexOf(search);
			if (keyIndex < 0)
			{
				return defaultValue;
			}

			int colonIndex = json.IndexOf(':', keyIndex + search.Length);
			if (colonIndex < 0)
			{
				return defaultValue;
			}

			int quoteStart = json.IndexOf('"', colonIndex + 1);
			if (quoteStart < 0)
			{
				return defaultValue;
			}

			int quoteEnd = json.IndexOf('"', quoteStart + 1);
			if (quoteEnd < 0)
			{
				return defaultValue;
			}

			return json.Substring(quoteStart + 1, quoteEnd - quoteStart - 1);
		}

		/// <summary>
		/// Extracts a nested JSON object by property name.
		/// </summary>
		/// <param name="json">JSON object to inspect.</param>
		/// <param name="key">Property name to read.</param>
		/// <returns>Raw nested object JSON, or null when missing.</returns>
		internal static string GetObject(string json, string key)
		{
			string search = "\"" + key + "\"";
			int keyIndex = string.IsNullOrEmpty(json) ? -1 : json.IndexOf(search);
			if (keyIndex < 0)
			{
				return null;
			}

			int colonIndex = json.IndexOf(':', keyIndex + search.Length);
			if (colonIndex < 0)
			{
				return null;
			}

			int objectStart = json.IndexOf('{', colonIndex + 1);
			if (objectStart < 0)
			{
				return null;
			}

			int depth = 0;
			bool inString = false;
			for (int i = objectStart; i < json.Length; i++)
			{
				char character = json[i];
				bool escaped = i > 0 && json[i - 1] == '\\';
				if (character == '"' && escaped == false)
				{
					inString = !inString;
				}

				if (inString)
				{
					continue;
				}

				if (character == '{')
				{
					depth++;
				}
				else if (character == '}')
				{
					depth--;
					if (depth == 0)
					{
						return json.Substring(objectStart, i - objectStart + 1);
					}
				}
			}

			return null;
		}

		/// <summary>
		/// Builds a fail-closed MCP error response.
		/// </summary>
		/// <param name="message">Failure reason visible to the MCP caller.</param>
		/// <returns>JSON error object.</returns>
		internal static string Error(string message)
		{
			return "{\"success\":false,\"error\":\"" + AgentCommandJson.Escape(message) + "\"}";
		}
	}
}

#endif
