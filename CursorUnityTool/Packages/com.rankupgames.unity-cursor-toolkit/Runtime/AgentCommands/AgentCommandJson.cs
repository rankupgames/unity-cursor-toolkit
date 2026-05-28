// =============================================================================
// Author: Miguel A. Lopez
// Company: Rank Up Games LLC
// Project: Unity Cursor Toolkit
// Description: Small JSON response helpers for runtime agent command results.
// Created: 2026-05-28
// Last Modified: 2026-05-28
// =============================================================================

using System.Text;

namespace UnityCursorToolkit.AgentCommands
{
	/// <summary>
	/// Provides deterministic JSON escaping and property formatting without taking a package dependency.
	/// </summary>
	public static class AgentCommandJson
	{
		/// <summary>
		/// Escapes a string value so it can be embedded in a JSON response.
		/// </summary>
		/// <param name="value">Unescaped string value.</param>
		/// <returns>Escaped JSON string content without wrapping quotes.</returns>
		public static string Escape(string value)
		{
			if (string.IsNullOrEmpty(value))
			{
				return string.Empty;
			}

			StringBuilder builder = new StringBuilder(value.Length);
			for (int i = 0; i < value.Length; i++)
			{
				char character = value[i];
				switch (character)
				{
					case '\\':
						builder.Append("\\\\");
						break;
					case '"':
						builder.Append("\\\"");
						break;
					case '\b':
						builder.Append("\\b");
						break;
					case '\f':
						builder.Append("\\f");
						break;
					case '\n':
						builder.Append("\\n");
						break;
					case '\r':
						builder.Append("\\r");
						break;
					case '\t':
						builder.Append("\\t");
						break;
					default:
						if (character < ' ')
						{
							builder.Append("\\u").Append(((int)character).ToString("x4"));
							break;
						}

						builder.Append(character);
						break;
				}
			}

			return builder.ToString();
		}

		/// <summary>
		/// Appends a JSON string property.
		/// </summary>
		/// <param name="builder">Response builder receiving the property.</param>
		/// <param name="name">Property name.</param>
		/// <param name="value">String value.</param>
		/// <returns>The same builder for fluent response composition.</returns>
		public static StringBuilder AppendProperty(StringBuilder builder, string name, string value)
		{
			builder.Append("\"").Append(Escape(name)).Append("\":\"").Append(Escape(value)).Append("\"");
			return builder;
		}

		/// <summary>
		/// Appends a JSON boolean property.
		/// </summary>
		/// <param name="builder">Response builder receiving the property.</param>
		/// <param name="name">Property name.</param>
		/// <param name="value">Boolean value.</param>
		/// <returns>The same builder for fluent response composition.</returns>
		public static StringBuilder AppendProperty(StringBuilder builder, string name, bool value)
		{
			builder.Append("\"").Append(Escape(name)).Append("\":").Append(value ? "true" : "false");
			return builder;
		}

		/// <summary>
		/// Appends a raw JSON value when it already represents an object or array, otherwise writes null.
		/// </summary>
		/// <param name="builder">Response builder receiving the value.</param>
		/// <param name="rawJson">Raw JSON object or array payload.</param>
		public static void AppendRawJsonOrNull(StringBuilder builder, string rawJson)
		{
			string trimmedJson = rawJson == null ? string.Empty : rawJson.Trim();
			if (trimmedJson.StartsWith("{") || trimmedJson.StartsWith("["))
			{
				builder.Append(trimmedJson);
				return;
			}

			builder.Append("null");
		}
	}
}
