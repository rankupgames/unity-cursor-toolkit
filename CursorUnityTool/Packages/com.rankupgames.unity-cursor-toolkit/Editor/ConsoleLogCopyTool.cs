/*
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 * Project: Unity Cursor Toolkit
 * Description: Editor tool to copy all Unity console log entries to the clipboard.
 *              Adds a button to the main toolbar and a menu item under Tools.
 * Created: 2026-04-13
 * Last Modified: 2026-04-19
 */

#if UNITY_EDITOR
using System;
using System.Reflection;
using System.Text;

using UnityEditor;
#if UNITY_2021_1_OR_NEWER
using UnityEditor.Toolbars;
#endif

using UnityEngine;

namespace UnityCursorToolkit
{

/// <summary>
/// Editor tool that copies all Unity console log entries to the system clipboard.
/// Provides a main toolbar button (docked right) and a menu item under Tools.
/// Uses reflection to access internal Unity LogEntries API across editor versions.
/// </summary>
public static class ConsoleLogCopyTool
{
	/// <summary>
	/// Creates the main toolbar button with a clipboard icon docked to the right side.
	/// Uses MainToolbarButton with MainToolbarContent for native Unity toolbar rendering.
	/// </summary>
	/// <returns>A MainToolbarButton configured with clipboard icon and copy action.</returns>
#if UNITY_2021_1_OR_NEWER
	[MainToolbarElement("UnityCursorToolkit/CopyConsoleLogs", defaultDockPosition = MainToolbarDockPosition.Right)]
	static MainToolbarButton CreateMainToolbarCopyLogsButton()
	{
		Texture2D _icon = EditorGUIUtility.IconContent("Clipboard").image as Texture2D;
		return new MainToolbarButton(
			new MainToolbarContent(_icon, "Copy all console logs to clipboard"),
			() => CopyConsoleLogs());
	}
#endif

	/// <summary>
	/// Copies all console log entries to the system clipboard.
	/// Accessible via the menu at Tools/Unity Cursor Toolkit/Copy Console Logs
	/// or the keyboard shortcut Cmd+Shift+L (Ctrl+Shift+L on Windows).
	/// </summary>
	[MenuItem("Tools/Unity Cursor Toolkit/Copy Console Logs %#l")]
	internal static void CopyConsoleLogs()
	{
		var _entries = GetConsoleLogEntries();
		if (string.IsNullOrEmpty(_entries))
		{
			Debug.Log("(ConsoleLogCopyTool - CopyConsoleLogs) Console is empty, nothing to copy");
			return;
		}

		GUIUtility.systemCopyBuffer = _entries;
		Debug.Log("(ConsoleLogCopyTool - CopyConsoleLogs) Copied all console logs to clipboard");
	}

	/// <summary>
	/// Retrieves all console log entries via reflection into the internal LogEntries API.
	/// Supports both UnityEditor.LogEntries and UnityEditorInternal.LogEntries.
	/// </summary>
	/// <returns>All log entries as a single string with log-level prefixes, or null if empty.</returns>
	private static string GetConsoleLogEntries()
	{
		var _logEntriesType = Type.GetType("UnityEditor.LogEntries, UnityEditor");
		if (_logEntriesType == null)
		{
			_logEntriesType = Type.GetType("UnityEditorInternal.LogEntries, UnityEditor");
		}

		if (_logEntriesType == null)
		{
			Debug.LogError("(ConsoleLogCopyTool - GetConsoleLogEntries) Could not find LogEntries type");
			return null;
		}

		var _getCount = _logEntriesType.GetMethod("GetCount", BindingFlags.Static | BindingFlags.Public);
		var _startGettingEntries = _logEntriesType.GetMethod("StartGettingEntries", BindingFlags.Static | BindingFlags.Public);
		var _endGettingEntries = _logEntriesType.GetMethod("EndGettingEntries", BindingFlags.Static | BindingFlags.Public);
		var _getEntryInternal = _logEntriesType.GetMethod("GetEntryInternal", BindingFlags.Static | BindingFlags.Public);

		if (_getCount == null || _startGettingEntries == null || _endGettingEntries == null || _getEntryInternal == null)
		{
			return GetConsoleLogEntriesFallback(_logEntriesType);
		}

		var _logEntryType = Type.GetType("UnityEditor.LogEntry, UnityEditor");
		if (_logEntryType == null)
		{
			_logEntryType = Type.GetType("UnityEditorInternal.LogEntry, UnityEditor");
		}

		if (_logEntryType == null)
		{
			return GetConsoleLogEntriesFallback(_logEntriesType);
		}

		int _count = (int)_getCount.Invoke(null, null);
		if (_count == 0)
		{
			return null;
		}

		var _sb = new StringBuilder();
		var _entry = Activator.CreateInstance(_logEntryType);

		var _messageField = _logEntryType.GetField("message", BindingFlags.Instance | BindingFlags.Public);
		var _conditionField = _logEntryType.GetField("condition", BindingFlags.Instance | BindingFlags.Public);
		var _modeField = _logEntryType.GetField("mode", BindingFlags.Instance | BindingFlags.Public);

		_startGettingEntries.Invoke(null, null);

		for (int i = 0; i < _count; i++)
		{
			_getEntryInternal.Invoke(null, new object[] { i, _entry });

			string _text = null;
			if (_conditionField != null)
			{
				_text = _conditionField.GetValue(_entry) as string;
			}

			if (string.IsNullOrEmpty(_text) && _messageField != null)
			{
				_text = _messageField.GetValue(_entry) as string;
			}

			if (string.IsNullOrEmpty(_text) == false)
			{
				string _prefix = "";
				if (_modeField != null)
				{
					int _mode = (int)_modeField.GetValue(_entry);
					_prefix = GetLogPrefix(_mode);
				}

				_sb.AppendLine($"{_prefix}{_text}");
			}
		}

		_endGettingEntries.Invoke(null, null);

		return _sb.ToString();
	}

	/// <summary>
	/// Fallback method for retrieving log entries when the primary internal API
	/// methods are unavailable. Uses the simpler GetEntryStringAt method.
	/// </summary>
	/// <param name="logEntriesType">The resolved LogEntries type to query.</param>
	/// <returns>All log entries as a single string, or null if empty.</returns>
	private static string GetConsoleLogEntriesFallback(Type logEntriesType)
	{
		var _getCount = logEntriesType.GetMethod("GetCount", BindingFlags.Static | BindingFlags.Public);
		if (_getCount == null)
		{
			Debug.LogError("(ConsoleLogCopyTool - GetConsoleLogEntriesFallback) GetCount method not found");
			return null;
		}

		int _count = (int)_getCount.Invoke(null, null);
		if (_count == 0)
		{
			return null;
		}

		var _getEntry = logEntriesType.GetMethod("GetEntryStringAt", BindingFlags.Static | BindingFlags.Public);
		if (_getEntry == null)
		{
			Debug.LogError("(ConsoleLogCopyTool - GetConsoleLogEntriesFallback) No usable entry retrieval method found");
			return null;
		}

		var _sb = new StringBuilder();
		for (int i = 0; i < _count; i++)
		{
			string _text = _getEntry.Invoke(null, new object[] { i }) as string;
			if (string.IsNullOrEmpty(_text) == false)
			{
				_sb.AppendLine(_text);
			}
		}

		return _sb.ToString();
	}

	/// <summary>
	/// Converts an internal Unity log mode bitmask to a human-readable prefix.
	/// </summary>
	/// <param name="mode">Unity internal log entry mode bitmask.</param>
	/// <returns>A string prefix: [ERROR], [WARNING], or [LOG].</returns>
	private static string GetLogPrefix(int mode)
	{
		bool _isError = (mode & (1 << 0)) != 0;
		bool _isWarning = (mode & (1 << 1)) != 0;

		if (_isError) return "[ERROR] ";
		if (_isWarning) return "[WARNING] ";
		return "[LOG] ";
	}
}

} // namespace UnityCursorToolkit

#endif // UNITY_EDITOR
