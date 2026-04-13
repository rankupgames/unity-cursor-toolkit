/*
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 * Project: Unity Cursor Toolkit
 * Description: Captures Unity console output and sends it to Cursor for AI-assisted debugging.
 *              Provides menu items and context menu entries to send errors, warnings, or all
 *              console entries to the Cursor extension via the existing TCP bridge.
 * Created: 2026-02-22
 * Last Modified: 2026-02-22
 */

using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;

using UnityEngine;

#if UNITY_EDITOR
using UnityEditor;

[InitializeOnLoad]
public static class ConsoleToCursor
{
	public const int MAX_BUFFER_SIZE = 200;
	public const int DEFAULT_SEND_LIMIT = 50;

	#region Private Variables

	private static readonly List<ConsoleEntry> entryBuffer = new List<ConsoleEntry>();
	private static readonly object bufferLock = new object();
	private static bool autoStreamEnabled = true;

	#endregion


	#region Data Structures

	[Serializable]
	private struct TcpPayload
	{
		public string command;
		public string content;
		public int entryCount;
	}

	[Serializable]
	private struct StreamEntry
	{
		public string command;
		public string type;
		public string message;
		public string stackTrace;
		public string timestamp;
	}

	private struct ConsoleEntry
	{
		public string message;
		public string stackTrace;
		public LogType type;
		public string timestamp;
	}

	#endregion


	#region Initialization

	static ConsoleToCursor()
	{
		Application.logMessageReceived += OnLogReceived;
	}

	#endregion


	#region Log Capture

	static void OnLogReceived(string message, string stackTrace, LogType type)
	{
		var _entry = new ConsoleEntry
		{
			message = message,
			stackTrace = stackTrace,
			type = type,
			timestamp = DateTime.Now.ToString("HH:mm:ss")
		};

		lock (bufferLock)
		{
			entryBuffer.Add(_entry);
			if (entryBuffer.Count > MAX_BUFFER_SIZE)
			{
				entryBuffer.RemoveAt(0);
			}
		}

		if (autoStreamEnabled && HotReloadHandler.IsServerRunning() && HotReloadHandler.GetConnectedClientCount() > 0)
		{
			var _stream = new StreamEntry
			{
				command = "consoleEntry",
				type = type.ToString(),
				message = message,
				stackTrace = stackTrace ?? "",
				timestamp = _entry.timestamp
			};
			HotReloadHandler.BroadcastToClients(JsonUtility.ToJson(_stream));
		}
	}

	#endregion


	#region Menu Items

	[MenuItem("Tools/Hot Reload/Send Errors to Cursor")]
	public static void SendErrorsToCursor()
	{
		List<ConsoleEntry> _errors;
		lock (bufferLock)
		{
			_errors = entryBuffer
				.Where(e => e.type == LogType.Error || e.type == LogType.Exception)
				.ToList();
		}

		if (_errors.Count == 0)
		{
			Debug.Log("(ConsoleToCursor) No errors in buffer to send.");
			return;
		}

		SendEntries(_errors, "errors");
	}

	[MenuItem("Tools/Hot Reload/Send Warnings to Cursor")]
	public static void SendWarningsToCursor()
	{
		List<ConsoleEntry> _warnings;
		lock (bufferLock)
		{
			_warnings = entryBuffer
				.Where(e => e.type == LogType.Warning)
				.ToList();
		}

		if (_warnings.Count == 0)
		{
			Debug.Log("(ConsoleToCursor) No warnings in buffer to send.");
			return;
		}

		SendEntries(_warnings, "warnings");
	}

	[MenuItem("Tools/Hot Reload/Send All Console to Cursor")]
	public static void SendAllToCursor()
	{
		List<ConsoleEntry> _all;
		lock (bufferLock)
		{
			_all = entryBuffer.ToList();
		}

		if (_all.Count == 0)
		{
			Debug.Log("(ConsoleToCursor) No console entries in buffer to send.");
			return;
		}

		SendEntries(_all, "all");
	}

	[MenuItem("Tools/Hot Reload/Clear Console Buffer")]
	public static void ClearBuffer()
	{
		lock (bufferLock)
		{
			entryBuffer.Clear();
		}
		Debug.Log("(ConsoleToCursor) Console buffer cleared.");
	}

	#endregion


	#region Send Logic

	static void SendEntries(List<ConsoleEntry> entries, string label)
	{
		int _limit = Mathf.Min(entries.Count, DEFAULT_SEND_LIMIT);
		var _recent = entries.Skip(entries.Count - _limit).ToList();

		string _formatted = FormatEntries(_recent);

		bool _sentViaTcp = false;
		if (HotReloadHandler.IsServerRunning() && HotReloadHandler.GetConnectedClientCount() > 0)
		{
			var _payload = new TcpPayload
			{
				command = "consoleToCursor",
				content = _formatted,
				entryCount = _recent.Count
			};
			_sentViaTcp = HotReloadHandler.BroadcastToClients(JsonUtility.ToJson(_payload));
		}

		GUIUtility.systemCopyBuffer = _formatted;

		if (_sentViaTcp)
		{
			Debug.Log($"(ConsoleToCursor) Sent {_recent.Count} {label} to Cursor and copied to clipboard.");
		}
		else
		{
			Debug.Log($"(ConsoleToCursor) Copied {_recent.Count} {label} to clipboard. No active Cursor connection — paste manually into a new chat.");
		}
	}

	static string FormatEntries(List<ConsoleEntry> entries)
	{
		var _sb = new StringBuilder();
		_sb.AppendLine("Unity Console Output:");
		_sb.AppendLine("---");

		foreach (var _entry in entries)
		{
			string _prefix;
			switch (_entry.type)
			{
				case LogType.Error:
					_prefix = "[ERROR]";
					break;
				case LogType.Exception:
					_prefix = "[EXCEPTION]";
					break;
				case LogType.Warning:
					_prefix = "[WARNING]";
					break;
				case LogType.Assert:
					_prefix = "[ASSERT]";
					break;
				default:
					_prefix = "[LOG]";
					break;
			}

			_sb.AppendLine($"{_prefix} [{_entry.timestamp}] {_entry.message}");

			if (string.IsNullOrEmpty(_entry.stackTrace) == false)
			{
				_sb.AppendLine(_entry.stackTrace.TrimEnd());
			}

			_sb.AppendLine();
		}

		return _sb.ToString();
	}

	#endregion
}

#endif // UNITY_EDITOR
