/*
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 * Project: Unity Cursor Toolkit
 * Description: Captures the current application camera view for editor diagnostics.
 */

#if UNITY_EDITOR
using System;
using System.IO;

using UnityEngine;

namespace UnityCursorToolkit
{
	/// <summary>
	/// Captures the current application view from the main camera to one stable temp file.
	/// </summary>
	internal static class ApplicationScreenshotCapture
	{
		private const string ScreenshotFileName = "unity-cursor-toolkit-application.png";

		internal static string ScreenshotPath => Path.Combine(Application.temporaryCachePath, ScreenshotFileName);

		internal static bool TryCapture(out string path, out string error)
		{
			path = ScreenshotPath;
			error = null;

			Camera camera = Camera.main;
			if (camera == null)
			{
				error = "No main camera found";
				return false;
			}

			int width = Math.Max(1, Screen.width);
			int height = Math.Max(1, Screen.height);
			RenderTexture previousTarget = camera.targetTexture;
			RenderTexture previousActive = RenderTexture.active;
			RenderTexture renderTexture = null;
			Texture2D texture = null;

			try
			{
				renderTexture = RenderTexture.GetTemporary(width, height, 24);
				camera.targetTexture = renderTexture;
				camera.Render();

				RenderTexture.active = renderTexture;
				texture = new Texture2D(width, height, TextureFormat.RGB24, false);
				texture.ReadPixels(new Rect(0, 0, width, height), 0, 0);
				texture.Apply();
				File.WriteAllBytes(path, texture.EncodeToPNG());
				return true;
			}
			catch (Exception exception)
			{
				error = exception.Message;
				return false;
			}
			finally
			{
				camera.targetTexture = previousTarget;
				RenderTexture.active = previousActive;
				if (texture != null)
				{
					UnityEngine.Object.DestroyImmediate(texture);
				}
				if (renderTexture != null)
				{
					RenderTexture.ReleaseTemporary(renderTexture);
				}
			}
		}
	}
}

#endif // UNITY_EDITOR
