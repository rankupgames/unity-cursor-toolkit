/*
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 * Project: Unity Cursor Toolkit
 * Description: Strict MCP access to opt-in Play session evidence.
 */
#if UNITY_EDITOR
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using UnityCursorToolkit.Core;
using UnityEngine;

namespace UnityCursorToolkit.MCP
{
	[MCPTool("session_monitor")]
	internal sealed class PlaySessionTool : IToolHandler
	{
		public string ToolName => "session_monitor";
		public string Description => "Opt in to Play session start/error/end evidence, then read bounded events and object snapshots.";

		public string HandleCommand(string argsJson)
		{
			Dictionary<string, Value> args;
			if (!TryArguments(argsJson, out args)) return Invalid("Supply one flat JSON object with unique properties and string, boolean or integer values.");
			string action;
			if (!Text(args, "action", "status", out action)) return Invalid("action must be a string.");
			string[] allowed;
			switch (action)
			{
				case "status": allowed = new[] { "action" }; break;
				case "configure": allowed = new[] { "action", "enabled", "captureOnError" }; break;
				case "events": allowed = new[] { "action", "afterSequence", "limit" }; break;
				case "capture": allowed = new[] { "action", "reason" }; break;
				case "read": allowed = new[] { "action", "sessionId", "snapshotId", "offset", "limit" }; break;
				default: return Invalid("Unknown session_monitor action.");
			}
			foreach (string key in args.Keys)
				if (Array.IndexOf(allowed, key) < 0) return Invalid("Unknown property for " + action + ": " + key);
			try
			{
				switch (action)
				{
					case "status": return PlaySessionMonitor.Status();
					case "configure":
						bool enabled, capture;
						if (!Boolean(args, "enabled", false, true, out enabled) || !Boolean(args, "captureOnError", true, false, out capture))
							return Invalid("configure requires enabled:boolean and optional captureOnError:boolean.");
						return PlaySessionMonitor.Configure(enabled, capture);
					case "events":
						long after, eventLimit;
						if (!Integer(args, "afterSequence", 0, 0, 9007199254740991L, out after) || !Integer(args, "limit", 50, 1, 100, out eventLimit))
							return Invalid("events requires a nonnegative safe afterSequence and limit 1..100.");
						return PlaySessionMonitor.Events(after, (int)eventLimit);
					case "capture":
						string reason;
						if (!Text(args, "reason", "manual", out reason) || string.IsNullOrWhiteSpace(reason) || reason.Length > 128)
							return Invalid("reason must be a nonempty string of at most 128 characters.");
						return PlaySessionMonitor.Capture(reason);
					case "read":
						string sessionId, snapshotId;
						long offset, pageLimit;
						if (!Text(args, "sessionId", null, out sessionId) || !PlaySessionMonitor.ValidSessionId(sessionId) ||
							!Text(args, "snapshotId", string.Empty, out snapshotId) || (snapshotId.Length > 0 && !PlaySessionMonitor.ValidSnapshotId(snapshotId)) ||
							!Integer(args, "offset", 0, 0, PlaySessionSnapshotBuilder.MaximumObjects, out offset) || !Integer(args, "limit", 100, 1, 200, out pageLimit))
							return Invalid("read requires a captured session ID, optional snapshot ID, offset 0..10000 and limit 1..200.");
						if (snapshotId.Length == 0 && (args.ContainsKey("offset") || args.ContainsKey("limit")))
							return Invalid("Object pagination requires snapshotId.");
						return PlaySessionMonitor.Read(sessionId, snapshotId, (int)offset, (int)pageLimit);
				}
			}
			catch (IOException exception) { return PlaySessionMonitor.Failure("session_storage_failed", exception.Message); }
			catch (UnauthorizedAccessException exception) { return PlaySessionMonitor.Failure("session_storage_denied", exception.Message); }
			catch (ArgumentException exception) { return PlaySessionMonitor.Failure("artifact_invalid", exception.Message); }
			return Invalid("Unknown session_monitor action.");
		}

		private struct Value { internal string kind; internal string raw; }

		private static readonly Regex Property = new Regex(
			@"\G\s*""(?<key>[A-Za-z][A-Za-z0-9]*)""\s*:\s*(?:(?<text>""(?:[^""\\\x00-\x1f]|\\(?:[""\\/bfnrt]|u[0-9a-fA-F]{4}))*"")|(?<boolean>true|false)|(?<integer>-?(?:0|[1-9][0-9]*)))",
			RegexOptions.CultureInvariant);

		private static bool TryArguments(string json, out Dictionary<string, Value> values)
		{
			values = new Dictionary<string, Value>(StringComparer.Ordinal);
			if (json == null || json.Length > 4096) return false;
			string input = json.Trim();
			if (input.Length < 2 || input[0] != '{' || input[input.Length - 1] != '}') return false;
			int position = 1;
			while (position < input.Length - 1 && char.IsWhiteSpace(input[position])) position++;
			if (position == input.Length - 1) return true;
			while (position < input.Length - 1)
			{
				Match match = Property.Match(input, position);
				if (!match.Success || match.Index != position) return false;
				string key = match.Groups["key"].Value;
				if (values.ContainsKey(key)) return false;
				string kind = match.Groups["text"].Success ? "text" : match.Groups["boolean"].Success ? "boolean" : "integer";
				values.Add(key, new Value { kind = kind, raw = kind == "text" ? match.Groups["text"].Value : match.Groups[kind].Value });
				position = match.Index + match.Length;
				while (position < input.Length && char.IsWhiteSpace(input[position])) position++;
				if (position == input.Length - 1) return true;
				if (position >= input.Length - 1 || input[position] != ',') return false;
				position++;
			}
			return false;
		}

		private static bool Text(Dictionary<string, Value> args, string key, string fallback, out string value)
		{
			Value entry;
			if (!args.TryGetValue(key, out entry)) { value = fallback; return true; }
			value = null;
			if (entry.kind != "text") return false;
			var decoded = new StringBuilder();
			for (int i = 1; i < entry.raw.Length - 1; i++)
			{
				char c = entry.raw[i];
				if (c != '\\') { decoded.Append(c); continue; }
				c = entry.raw[++i];
				switch (c)
				{
					case '"': case '\\': case '/': decoded.Append(c); break;
					case 'b': decoded.Append('\b'); break;
					case 'f': decoded.Append('\f'); break;
					case 'n': decoded.Append('\n'); break;
					case 'r': decoded.Append('\r'); break;
					case 't': decoded.Append('\t'); break;
					case 'u':
						int code;
						if (!int.TryParse(entry.raw.Substring(i + 1, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out code)) return false;
						decoded.Append((char)code);
						i += 4;
						break;
					default: return false;
				}
			}
			value = decoded.ToString();
			for (int i = 0; i < value.Length; i++)
			{
				if (char.IsHighSurrogate(value[i]))
				{
					if (++i >= value.Length || !char.IsLowSurrogate(value[i])) return false;
				}
				else if (char.IsLowSurrogate(value[i])) return false;
			}
			return true;
		}

		private static bool Boolean(Dictionary<string, Value> args, string key, bool fallback, bool required, out bool value)
		{
			Value entry;
			if (!args.TryGetValue(key, out entry)) { value = fallback; return !required; }
			value = entry.raw == "true";
			return entry.kind == "boolean";
		}

		private static bool Integer(Dictionary<string, Value> args, string key, long fallback, long min, long max, out long value)
		{
			Value entry;
			value = fallback;
			if (!args.TryGetValue(key, out entry)) return true;
			return entry.kind == "integer" && long.TryParse(entry.raw, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out value) && value >= min && value <= max;
		}

		private static string Invalid(string message) { return PlaySessionMonitor.Failure("invalid_arguments", message); }
	}
}
#endif
