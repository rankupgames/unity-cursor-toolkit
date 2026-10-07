/*
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 * Project: Unity Cursor Toolkit
 * Description: Editor tool to copy compact Unity profiler and console session context to the clipboard.
 *              Adds a button to the main toolbar and a menu item under Tools.
 * Created: 2026-04-13
 * Last Modified: 2026-04-19
 */

#if UNITY_EDITOR
using UnityEditor;
#if UNITY_2021_1_OR_NEWER
using UnityEditor.Toolbars;
#endif

using UnityEngine;

namespace UnityCursorToolkit
{

/// <summary>
/// Editor tool that copies compact Unity profiler and console session context to the system clipboard.
/// Provides a main toolbar button (docked right) and a menu item under Tools.
/// </summary>
public static class ConsoleLogCopyTool
{
	/// <summary>
	/// Creates the main toolbar button with a clipboard icon docked to the right side.
	/// Uses MainToolbarButton with MainToolbarContent for native Unity toolbar rendering.
	/// </summary>
	/// <returns>A MainToolbarButton configured with clipboard icon and snapshot copy action.</returns>
#if UNITY_2021_1_OR_NEWER
	[MainToolbarElement("UnityCursorToolkit/CopyConsoleLogs", defaultDockPosition = MainToolbarDockPosition.Right)]
	static MainToolbarButton CreateMainToolbarCopyLogsButton()
	{
		Texture2D _icon = EditorGUIUtility.IconContent("Clipboard").image as Texture2D;
		return new MainToolbarButton(
			new MainToolbarContent(_icon, "Copy profiler session, console transcript, and application screenshot path"),
			() => CopyConsoleLogs());
	}
#endif

	/// <summary>
	/// Copies the current profiler session path, compact console transcript path, and grouped error summary.
	/// Accessible via the menu at Tools/Unity Cursor Toolkit/Copy Console Logs
	/// or the keyboard shortcut Cmd+Shift+L (Ctrl+Shift+L on Windows).
	/// </summary>
	[MenuItem("Tools/Unity Cursor Toolkit/Copy Console Logs %#l")]
	internal static void CopyConsoleLogs()
	{
		string clipboardContent = ProfilerSessionRecorder.BuildClipboardSnapshot(ProfilerSnapshotSettings.Current.IncludeRawFrameArrays);
		string screenshotPath;
		string screenshotError;
		if (ApplicationScreenshotCapture.TryCapture(out screenshotPath, out screenshotError))
		{
			clipboardContent += "\n\nApplication screenshot: " + screenshotPath;
		}
		else
		{
			Debug.LogWarning("(ConsoleLogCopyTool - CopyConsoleLogs) Application screenshot was not captured: " + screenshotError);
		}

		GUIUtility.systemCopyBuffer = clipboardContent;
		Debug.Log("(ConsoleLogCopyTool - CopyConsoleLogs) Copied current profiler session path, console transcript path, and error summary to clipboard");
	}
}

} // namespace UnityCursorToolkit

#endif // UNITY_EDITOR
