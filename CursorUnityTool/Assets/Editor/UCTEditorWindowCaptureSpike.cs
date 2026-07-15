// =============================================================================
// Author: Miguel A. Lopez
// Company: Rank Up Games LLC
// Project: Unity Cursor Toolkit
// Description: Spike that proves real EditorWindow capture (GUIView.GrabPixels)
//              and synthetic input (EditorWindow.SendEvent) for window streaming.
//              See docs/EDITOR_WINDOW_STREAMING_PLAN.md. Run via
//              scripts/run-editor-window-capture-spike.js or the Tools menu.
// =============================================================================

#if UNITY_EDITOR

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Text;
using UnityEditor;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace UnityCursorToolkit.InternalSmoke
{
	internal sealed class UCTSpikeProbeWindow : EditorWindow
	{
		private void OnGUI()
		{
			Color[] swatches =
			{
				new Color(0.18f, 0.45f, 0.85f),
				new Color(0.85f, 0.35f, 0.2f),
				new Color(0.28f, 0.7f, 0.38f),
				new Color(0.9f, 0.78f, 0.22f),
				new Color(0.5f, 0.32f, 0.78f),
				new Color(0.1f, 0.62f, 0.72f),
				new Color(0.88f, 0.5f, 0.12f),
				new Color(0.72f, 0.18f, 0.35f),
				new Color(0.22f, 0.22f, 0.22f)
			};

			const int columns = 3;
			const int rows = 3;
			float cellWidth = position.width / columns;
			float cellHeight = position.height / rows;
			for (int y = 0; y < rows; y++)
			{
				for (int x = 0; x < columns; x++)
				{
					EditorGUI.DrawRect(new Rect(x * cellWidth, y * cellHeight, cellWidth, cellHeight), swatches[y * columns + x]);
				}
			}

			GUI.Label(new Rect(10f, 10f, 360f, 20f), "UCT custom EditorWindow capture probe");
		}
	}

	public static class UCTEditorWindowCaptureSpike
	{
		private static bool started;
		private static bool finished;
		private static int frame;
		private static string outputDir;
		private static string resultPath;
		private static bool autoQuit;

		private static EditorWindow sceneWindow;
		private static EditorWindow gameWindow;
		private static EditorWindow inspectorWindow;
		private static EditorWindow packageWindow;
		private static EditorWindow probeWindow;

		private static readonly List<string> captureResults = new List<string>();
		private static bool allCapturesSucceeded;

		private static bool rotationCaptured;
		private static Quaternion rotationBefore;
		private static float inputAngle;
		private static bool inputChanged;
		private static string inputError = string.Empty;

		[MenuItem("Tools/Unity Cursor Toolkit/Editor Window Capture Spike")]
		public static void RunFromMenu()
		{
			Begin(false);
		}

		/// <summary>Entry point for -executeMethod (full editor session, no -batchmode).</summary>
		public static void Run()
		{
			Begin(GetBoolArg("-uctSpikeAutoQuit", true));
		}

		private static void Begin(bool quitWhenDone)
		{
			if (started && finished == false)
			{
				Debug.LogWarning("[UCTSpike] Already running.");
				return;
			}

			started = true;
			finished = false;
			frame = 0;
			captureResults.Clear();
			allCapturesSucceeded = false;
			rotationCaptured = false;
			inputAngle = 0f;
			inputChanged = false;
			inputError = string.Empty;
			autoQuit = quitWhenDone;
			outputDir = GetArg("-uctSpikeOutputDir", Path.Combine(Directory.GetCurrentDirectory(), "Temp", "uct_editor_window_spike"));
			resultPath = GetArg("-uctSpikeResultPath", Path.Combine(outputDir, "result.json"));
			Directory.CreateDirectory(outputDir);
			EditorApplication.update -= Tick;
			EditorApplication.update += Tick;
			Debug.Log("[UCTSpike] Started. Output: " + outputDir);
		}

		private static void Tick()
		{
			if (finished)
			{
				return;
			}

			if (EditorApplication.isCompiling || EditorApplication.isUpdating)
			{
				return;
			}

			frame++;
			try
			{
				Step();
			}
			catch (Exception ex)
			{
				Finish("Unhandled spike exception: " + ex.Message);
			}
		}

		private static void Step()
		{
			if (frame == 1)
			{
				SetupWindows();
				return;
			}

			// Let IMGUI/UIElements lay out and Package Manager start its refresh.
			if (frame < 90)
			{
				if (frame % 5 == 0)
				{
					RepaintAll();
				}
				return;
			}

			if (frame == 90)
			{
				CaptureAll();
				return;
			}

			if (frame == 95)
			{
				BeginInputTest();
				return;
			}

			if (frame >= 130)
			{
				EndInputTest();
				Finish(null);
			}
		}

		private static void SetupWindows()
		{
			sceneWindow = EditorWindow.GetWindow(typeof(SceneView));
			sceneWindow.position = new Rect(60f, 60f, 800f, 520f);

			GameObject[] roots = SceneManager.GetActiveScene().GetRootGameObjects();
			Selection.activeGameObject = roots.Length > 0 ? roots[roots.Length - 1] : null;

			Type inspectorType = typeof(Editor).Assembly.GetType("UnityEditor.InspectorWindow");
			if (inspectorType != null)
			{
				inspectorWindow = EditorWindow.GetWindow(inspectorType);
			}

			Type gameViewType = typeof(Editor).Assembly.GetType("UnityEditor.GameView");
			if (gameViewType != null)
			{
				gameWindow = EditorWindow.GetWindow(gameViewType);
			}

			TryOpenPackageManager();

			probeWindow = EditorWindow.GetWindow(typeof(UCTSpikeProbeWindow));
			probeWindow.position = new Rect(120f, 120f, 420f, 280f);

			RepaintAll();
		}

		private static void TryOpenPackageManager()
		{
			try
			{
				UnityEditor.PackageManager.UI.Window.Open(string.Empty);
			}
			catch (Exception)
			{
				if (EditorApplication.ExecuteMenuItem("Window/Package Manager") == false)
				{
					EditorApplication.ExecuteMenuItem("Window/Package Management/Package Manager");
				}
			}

			foreach (EditorWindow window in Resources.FindObjectsOfTypeAll<EditorWindow>())
			{
				if (window != null && window.GetType().FullName.IndexOf("PackageManagerWindow", StringComparison.OrdinalIgnoreCase) >= 0)
				{
					packageWindow = window;
					return;
				}
			}
		}

		private static void RepaintAll()
		{
			if (sceneWindow != null) sceneWindow.Repaint();
			if (gameWindow != null) gameWindow.Repaint();
			if (inspectorWindow != null) inspectorWindow.Repaint();
			if (packageWindow != null) packageWindow.Repaint();
			if (probeWindow != null) probeWindow.Repaint();
		}

		private static void CaptureAll()
		{
			allCapturesSucceeded = true;
			captureResults.Add(CaptureWindow("sceneView", sceneWindow));
			captureResults.Add(CaptureWindow("gameView", gameWindow));
			captureResults.Add(CaptureWindow("inspector", inspectorWindow));
			captureResults.Add(CaptureWindow("packageManager", packageWindow));
			captureResults.Add(CaptureWindow("customProbe", probeWindow));
		}

		private static string CaptureWindow(string name, EditorWindow window)
		{
			if (window == null)
			{
				allCapturesSucceeded = false;
				return CaptureJson(name, false, string.Empty, 0, 0, 0, "Window unavailable (type not found or failed to open).");
			}

			RenderTexture rt = null;
			Texture2D texture = null;
			RenderTexture previousActive = RenderTexture.active;
			try
			{
				FieldInfo parentField = typeof(EditorWindow).GetField("m_Parent", BindingFlags.NonPublic | BindingFlags.Instance);
				object parent = parentField == null ? null : parentField.GetValue(window);
				if (parent == null)
				{
					allCapturesSucceeded = false;
					return CaptureJson(name, false, string.Empty, 0, 0, 0, "EditorWindow.m_Parent (HostView) unavailable.");
				}

				MethodInfo grab = FindMethod(parent.GetType(), "GrabPixels");
				if (grab == null)
				{
					allCapturesSucceeded = false;
					return CaptureJson(name, false, string.Empty, 0, 0, 0, "GUIView.GrabPixels missing. Methods: " + DescribeMethods(parent.GetType()));
				}

				float ppp = EditorGUIUtility.pixelsPerPoint;
				int width = Mathf.Max(8, Mathf.RoundToInt(window.position.width * ppp));
				int height = Mathf.Max(8, Mathf.RoundToInt(window.position.height * ppp));

				MethodInfo repaintNow = typeof(EditorWindow).GetMethod("RepaintImmediately", BindingFlags.NonPublic | BindingFlags.Instance);
				if (repaintNow != null)
				{
					repaintNow.Invoke(window, null);
				}
				else
				{
					window.Repaint();
				}

				rt = new RenderTexture(width, height, 24, RenderTextureFormat.ARGB32);
				rt.Create();
				grab.Invoke(parent, new object[] { rt, new Rect(0f, 0f, width, height) });

				RenderTexture.active = rt;
				texture = new Texture2D(width, height, TextureFormat.RGB24, false);
				texture.ReadPixels(new Rect(0f, 0f, width, height), 0, 0);
				texture.Apply();

				int distinct = CountDistinctColors(texture);
				string framePath = Path.Combine(outputDir, name + ".jpg");
				File.WriteAllBytes(framePath, texture.EncodeToJPG(85));

				bool nonBlank = distinct >= 8;
				if (nonBlank == false)
				{
					allCapturesSucceeded = false;
				}

				return CaptureJson(name, nonBlank, framePath, width, height, distinct, nonBlank ? string.Empty : "Capture is blank or near-uniform.");
			}
			catch (Exception ex)
			{
				allCapturesSucceeded = false;
				return CaptureJson(name, false, string.Empty, 0, 0, 0, ex.GetType().Name + ": " + ex.Message);
			}
			finally
			{
				RenderTexture.active = previousActive;
				if (rt != null) UnityEngine.Object.DestroyImmediate(rt);
				if (texture != null) UnityEngine.Object.DestroyImmediate(texture);
			}
		}

		private static void BeginInputTest()
		{
			SceneView sceneView = sceneWindow as SceneView;
			if (sceneView == null)
			{
				sceneView = SceneView.lastActiveSceneView;
			}

			if (sceneView == null)
			{
				inputError = "No SceneView available for input test.";
				return;
			}

			try
			{
				sceneView.Focus();
				rotationBefore = sceneView.rotation;
				rotationCaptured = true;

				Vector2 center = new Vector2(sceneView.position.width * 0.5f, sceneView.position.height * 0.5f);
				Vector2 step = new Vector2(18f, 7f);
				SendMouse(sceneView, EventType.MouseDown, center, Vector2.zero);
				Vector2 cursor = center;
				for (int index = 0; index < 4; index++)
				{
					cursor += step;
					SendMouse(sceneView, EventType.MouseDrag, cursor, step);
				}
				SendMouse(sceneView, EventType.MouseUp, cursor, Vector2.zero);
			}
			catch (Exception ex)
			{
				inputError = ex.GetType().Name + ": " + ex.Message;
			}
		}

		private static void EndInputTest()
		{
			if (rotationCaptured == false)
			{
				return;
			}

			SceneView sceneView = sceneWindow as SceneView;
			if (sceneView == null)
			{
				sceneView = SceneView.lastActiveSceneView;
			}

			if (sceneView == null)
			{
				inputError = "SceneView disappeared before input verification.";
				return;
			}

			inputAngle = Quaternion.Angle(rotationBefore, sceneView.rotation);
			inputChanged = inputAngle > 0.25f;
		}

		private static void SendMouse(EditorWindow window, EventType type, Vector2 position, Vector2 delta)
		{
			Event evt = new Event();
			evt.type = type;
			evt.mousePosition = position;
			evt.delta = delta;
			evt.button = 0;
			evt.clickCount = 1;
			evt.modifiers = EventModifiers.Alt; // Alt+LMB drag = SceneView orbit
			window.SendEvent(evt);
		}

		private static void Finish(string fatalError)
		{
			if (finished)
			{
				return;
			}

			finished = true;
			EditorApplication.update -= Tick;

			StringBuilder json = new StringBuilder();
			json.Append("{");
			json.Append("\"success\":").Append(fatalError == null ? "true" : "false");
			json.Append(",\"editorVersion\":\"").Append(Escape(Application.unityVersion)).Append("\"");
			json.Append(",\"platform\":\"").Append(Escape(SystemInfo.operatingSystem)).Append("\"");
			json.Append(",\"pixelsPerPoint\":").Append(EditorGUIUtility.pixelsPerPoint.ToString(CultureInfo.InvariantCulture));
			json.Append(",\"allCapturesSucceeded\":").Append(allCapturesSucceeded ? "true" : "false");
			json.Append(",\"captures\":[").Append(string.Join(",", captureResults.ToArray())).Append("]");
			json.Append(",\"inputTest\":{");
			json.Append("\"attempted\":").Append(rotationCaptured ? "true" : "false");
			json.Append(",\"rotationAngle\":").Append(inputAngle.ToString("F3", CultureInfo.InvariantCulture));
			json.Append(",\"changed\":").Append(inputChanged ? "true" : "false");
			json.Append(",\"error\":\"").Append(Escape(inputError)).Append("\"");
			json.Append("}");
			if (fatalError != null)
			{
				json.Append(",\"fatalError\":\"").Append(Escape(fatalError)).Append("\"");
			}
			json.Append("}");

			try
			{
				Directory.CreateDirectory(Path.GetDirectoryName(resultPath));
				File.WriteAllText(resultPath, json.ToString());
				Debug.Log("[UCTSpike] Result written: " + resultPath);
			}
			catch (Exception ex)
			{
				Debug.LogError("[UCTSpike] Failed writing result: " + ex.Message);
			}

			if (autoQuit)
			{
				EditorApplication.Exit(fatalError == null ? 0 : 3);
			}
		}

		private static string CaptureJson(string name, bool success, string path, int width, int height, int distinctColors, string error)
		{
			return "{\"window\":\"" + Escape(name) + "\""
				+ ",\"success\":" + (success ? "true" : "false")
				+ ",\"path\":\"" + Escape(path) + "\""
				+ ",\"width\":" + width
				+ ",\"height\":" + height
				+ ",\"distinctColors\":" + distinctColors
				+ ",\"error\":\"" + Escape(error) + "\"}";
		}

		private static int CountDistinctColors(Texture2D texture)
		{
			HashSet<uint> colors = new HashSet<uint>();
			int stepX = Mathf.Max(1, texture.width / 32);
			int stepY = Mathf.Max(1, texture.height / 32);
			for (int y = 0; y < texture.height; y += stepY)
			{
				for (int x = 0; x < texture.width; x += stepX)
				{
					Color32 c = texture.GetPixel(x, y);
					colors.Add((uint) (c.r << 16 | c.g << 8 | c.b));
				}
			}

			return colors.Count;
		}

		private static MethodInfo FindMethod(Type type, string name)
		{
			for (Type current = type; current != null; current = current.BaseType)
			{
				MethodInfo method = current.GetMethod(name, BindingFlags.NonPublic | BindingFlags.Public | BindingFlags.Instance);
				if (method != null)
				{
					return method;
				}
			}

			return null;
		}

		private static string DescribeMethods(Type type)
		{
			List<string> names = new List<string>();
			for (Type current = type; current != null && names.Count < 60; current = current.BaseType)
			{
				foreach (MethodInfo method in current.GetMethods(BindingFlags.NonPublic | BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly))
				{
					if (names.Contains(method.Name) == false)
					{
						names.Add(method.Name);
					}
				}
			}

			return string.Join("|", names.ToArray());
		}

		private static string GetArg(string name, string fallback)
		{
			string[] args = Environment.GetCommandLineArgs();
			for (int index = 0; index < args.Length - 1; index++)
			{
				if (string.Equals(args[index], name, StringComparison.OrdinalIgnoreCase))
				{
					return args[index + 1];
				}
			}

			return fallback;
		}

		private static bool GetBoolArg(string name, bool fallback)
		{
			string value = GetArg(name, fallback ? "true" : "false");
			return string.Equals(value, "true", StringComparison.OrdinalIgnoreCase) || value == "1";
		}

		private static string Escape(string value)
		{
			if (string.IsNullOrEmpty(value))
			{
				return string.Empty;
			}

			return value.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\n", "\\n").Replace("\r", "\\r").Replace("\t", "\\t");
		}
	}
}

#endif
