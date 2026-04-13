/*
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 * Project: Unity Cursor Toolkit
 * Description: Editor tool to copy all Unity console log entries to the clipboard.
 *              Adds a button to the main toolbar and a menu item under Tools.
 * Created: 2026-04-13
 * Last Modified: 2026-04-13
 */

#if UNITY_EDITOR
using System;
using System.Reflection;
using System.Text;

using UnityEditor;
using UnityEditor.Toolbars;

using UnityEngine;

namespace UnityCursorToolkit
{

public static class ConsoleLogCopyTool
{
	[MainToolbarElement("UnityCursorToolkit/CopyConsoleLogs", defaultDockPosition = MainToolbarDockPosition.Right)]
	static MainToolbarButton CreateMainToolbarCopyLogsButton()
	{
		var _icon = EditorGUIUtility.IconContent("Clipboard").image as Texture2D;
		return new MainToolbarButton(
			new MainToolbarContent(_icon, "Copy all console logs to clipboard"),
			() => CopyConsoleLogs());
	}

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
