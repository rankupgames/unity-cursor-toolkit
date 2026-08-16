/*
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 * Project: Unity Cursor Toolkit
 * Description: Captures the complete Unity Editor application view for diagnostics.
 */

#if UNITY_EDITOR
using System;
using System.IO;

using UnityEngine;
using UnityCursorToolkit.MCP;

namespace UnityCursorToolkit
{
	/// <summary>
	/// Captures the complete Unity Editor application view to one stable temp file.
	/// </summary>
	internal static class ApplicationScreenshotCapture
	{
		private const string ScreenshotFileName = "unity-cursor-toolkit-application.png";

		internal static string ScreenshotPath => Path.Combine(Application.temporaryCachePath, ScreenshotFileName);

		internal static bool TryCapture(out string path, out string error)
		{
			path = ScreenshotPath;
			error = null;

			EditorWindowViewportCapture.Frame frame;
			if (EditorWindowViewportCapture.TryCaptureMainEditorWindow(out frame, out error) == false)
			{
				return false;
			}

			try
			{
				if (frame == null || frame.bytes == null || frame.bytes.Length == 0)
				{
					error = "Main editor root view capture returned no PNG bytes.";
					return false;
				}

				File.WriteAllBytes(path, frame.bytes);
				return true;
			}
			catch (Exception exception)
			{
				error = "Failed to write application screenshot: " + exception.Message;
				return false;
			}
		}
	}
}

#endif // UNITY_EDITOR
