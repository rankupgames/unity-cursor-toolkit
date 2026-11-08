// =============================================================================
// Author: Miguel A. Lopez
// Company: Rank Up Games LLC
// Project: Unity Cursor Toolkit
// Description: Spike that proves real EditorWindow capture (GUIView.GrabPixels)
//              and synthetic input (EditorWindow.SendEvent) for window streaming.
//              See docs/REMOTE_SHELL.md. Run via
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
using UnityEditor.SceneManagement;
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
		private static DateTime deadline;
		private static string stopPath;
		private static bool ownedFixture;
		private static string firstFrameAt;
		private static MethodInfo captureMethod;
		private static MethodInfo inputMethod;

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
			ownedFixture = GetBoolArg("-uctSpikeOwned", false);
			stopPath = GetArg("-uctSpikeStopPath", string.Empty);
			deadline = DateTime.UtcNow.AddSeconds(double.Parse(GetArg("-uctSpikeTimeout", "300"), CultureInfo.InvariantCulture));
			firstFrameAt = null;
			visibilityEvidence.Clear();
			Type captureType = typeof(UnityCursorToolkit.HotReloadHandler).Assembly.GetType("UnityCursorToolkit.MCP.EditorWindowViewportCapture");
			Type frameType = captureType == null ? null : captureType.GetNestedType("Frame", BindingFlags.NonPublic);
			captureMethod = frameType == null ? null : captureType.GetMethod("TryCapture", BindingFlags.Static | BindingFlags.NonPublic, null, new[] { typeof(string), typeof(int), frameType.MakeByRefType(), typeof(string).MakeByRefType() }, null);
			inputMethod = captureType == null ? null : captureType.GetMethod("TrySendInput", BindingFlags.Static | BindingFlags.NonPublic);
			outputDir = GetArg("-uctSpikeOutputDir", Path.Combine(Directory.GetCurrentDirectory(), "Temp", "uct_editor_window_spike"));
			resultPath = GetArg("-uctSpikeResultPath", Path.Combine(outputDir, "result.json"));
			Directory.CreateDirectory(outputDir);
			if (ownedFixture)
			{
				int port = int.Parse(GetArg("-uctSpikePort", "0"), CultureInfo.InvariantCulture);
				MethodInfo start = typeof(UnityCursorToolkit.HotReloadHandler).GetMethod("TryStartOnSpecificPort", BindingFlags.NonPublic | BindingFlags.Static);
				if (port <= 0 || start == null || !(bool)start.Invoke(null, new object[] { port }))
					throw new InvalidOperationException("bridge_start_failed: explicit owned port unavailable");
			}
			EditorApplication.update -= Tick;
			EditorApplication.update += Tick;
			EditorApplication.quitting -= OnQuitting;
			EditorApplication.quitting += OnQuitting;
			Debug.Log("[UCTSpike] Started. Output: " + outputDir);
		}

		private static void Tick()
		{
			if (ownedFixture && ((!string.IsNullOrEmpty(stopPath) && File.Exists(stopPath)) || DateTime.UtcNow > deadline))
			{
				if (!finished) Finish("proof_timeout: Owned spike reached its stop deadline.");
				EditorApplication.Exit(allCapturesSucceeded && inputChanged ? 0 : 3);
				return;
			}
			if (finished)
			{
				return;
			}

			if (EditorApplication.isCompiling || EditorApplication.isUpdating || (ownedFixture && ShaderUtil.anythingCompiling))
			{
				return;
			}

			if (frame == 1 && ownedFixture && GetBoolArg("-uctSpikeHiddenGate", false) && !File.Exists(Path.Combine(outputDir, "hidden-ready.txt"))) return;
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
				if (ownedFixture) File.WriteAllText(Path.Combine(outputDir, "windows-ready.txt"), "owned windows initialized");
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
			if (ownedFixture)
			{
				EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
				GameObject cube = GameObject.CreatePrimitive(PrimitiveType.Cube);
				cube.name = "UCT owned cube";
				GameObject sphere = GameObject.CreatePrimitive(PrimitiveType.Sphere);
				sphere.transform.position = new Vector3(1.8f, 0.25f, 0f);
				GameObject cameraObject = new GameObject("UCT owned camera");
				Camera camera = cameraObject.AddComponent<Camera>();
				camera.transform.position = new Vector3(0f, 1f, -6f);
				camera.transform.LookAt(new Vector3(0.5f, 0f, 0f));
				camera.clearFlags = CameraClearFlags.SolidColor;
				camera.backgroundColor = new Color(0.08f, 0.2f, 0.35f);
				GameObject lightObject = new GameObject("UCT owned light");
				Light light = lightObject.AddComponent<Light>();
				light.type = LightType.Directional;
				light.transform.rotation = Quaternion.Euler(35f, -30f, 0f);
				Shader shader = Shader.Find("Universal Render Pipeline/Lit");
				if (shader == null) throw new InvalidOperationException("fixture_shader_unavailable");
				Material redMaterial = new Material(shader);
				redMaterial.SetColor("_BaseColor", Color.red);
				Material greenMaterial = new Material(shader);
				greenMaterial.SetColor("_BaseColor", Color.green);
				cube.GetComponent<Renderer>().sharedMaterial = redMaterial;
				sphere.GetComponent<Renderer>().sharedMaterial = greenMaterial;
				EditorSceneManager.SaveScene(SceneManager.GetActiveScene(), "Assets/UCTViewportProof.unity");
			}
			sceneWindow = EditorWindow.GetWindow(typeof(SceneView));
			sceneWindow.position = new Rect(60f, 60f, 800f, 520f);
			if (ownedFixture)
			{
				SceneView scene = (SceneView)sceneWindow;
				scene.pivot = new Vector3(0.5f, 0f, 0f);
				scene.rotation = Quaternion.Euler(20f, -15f, 0f);
				scene.size = 5f;
			}

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
			packageWindow = null;
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
			// Window.Open can defer creation until EditorApplication.delayCall.
			foreach (EditorWindow window in Resources.FindObjectsOfTypeAll<EditorWindow>())
			{
				if (window != null && window.GetType().FullName.IndexOf("PackageManagerWindow", StringComparison.OrdinalIgnoreCase) >= 0)
				{
					packageWindow = window;
					break;
				}
			}

			allCapturesSucceeded = true;
			captureResults.Add(CaptureWindow("sceneView", sceneWindow));
			captureResults.Add(CaptureWindow("gameView", gameWindow));
			captureResults.Add(CaptureWindow("inspector", inspectorWindow));
			captureResults.Add(CaptureWindow("packageManager", packageWindow));
			captureResults.Add(CaptureWindow("customProbe", probeWindow));
		}

		private static string CaptureWindow(string name, EditorWindow window)
		{
			Texture2D texture = null;
			try
			{
				if (window == null) throw new InvalidOperationException("window_unavailable: " + name);
				FieldInfo parentField = typeof(EditorWindow).GetField("m_Parent", BindingFlags.NonPublic | BindingFlags.Instance);
				object parent = parentField == null ? null : parentField.GetValue(window);
				if (parent == null) throw new InvalidOperationException("capture_api_missing: m_Parent; methods=" + DescribeMethods(window.GetType()));
				MethodInfo grab = FindMethod(parent.GetType(), "GrabPixels", new[] { typeof(RenderTexture), typeof(Rect) });
				if (grab == null) throw new InvalidOperationException("capture_api_missing: GrabPixels(RenderTexture,Rect); methods=" + DescribeMethods(parent.GetType()));
				if (captureMethod == null) throw new InvalidOperationException("capture_api_missing: production TryCapture");
				string view = name == "sceneView" ? "scene" : name == "gameView" ? "game" : name == "customProbe" ? "window:" + window.GetType().FullName : name;
				object[] args = { view, 85, null, null };
				RecordVisibility("before_capture:" + name);
				bool captured = (bool)captureMethod.Invoke(null, args);
				RecordVisibility("after_capture:" + name);
				if (!captured || args[2] == null) throw new InvalidOperationException("capture_failed: " + args[3]);
				object capture = args[2];
				Type type = capture.GetType();
				byte[] bytes = (byte[])type.GetField("bytes").GetValue(capture);
				int width = (int)type.GetField("width").GetValue(capture);
				int height = (int)type.GetField("height").GetValue(capture);
				texture = new Texture2D(2, 2, TextureFormat.RGB24, false);
				if (!ImageConversion.LoadImage(texture, bytes)) throw new InvalidOperationException("frame_decode_failed");
				int distinct = CountDistinctColors(texture);
				string framePath = Path.Combine(outputDir, name + ".jpg");
				File.WriteAllBytes(framePath, bytes);
				if (firstFrameAt == null) firstFrameAt = DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture);
				bool nonBlank = distinct >= 8 && (!ownedFixture || name != "gameView" || HasFixtureColors(texture));
				if (!nonBlank) allCapturesSucceeded = false;
				return CaptureJson(name, nonBlank, framePath, width, height, distinct, nonBlank ? string.Empty : "blank_frame_or_scene_missing: Capture must contain expected red cube and green sphere.");
			}
			catch (Exception ex)
			{
				allCapturesSucceeded = false;
				return CaptureJson(name, false, string.Empty, 0, 0, 0, ex.GetType().Name + ": " + ex.Message);
			}
			finally
			{
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
				MethodInfo send = FindMethod(typeof(EditorWindow), "SendEvent", new[] { typeof(Event) });
				if (send == null || send.ReturnType != typeof(bool))
					throw new InvalidOperationException("input_api_missing: SendEvent(Event); methods=" + DescribeMethods(typeof(EditorWindow)));
				if (inputMethod == null) throw new InvalidOperationException("input_api_missing: production TrySendInput");
				object[] args = { "scene", "sceneDrag", center.x, center.y, center.x + step.x * 4f, center.y + step.y * 4f, step.x * 4f, step.y * 4f, 0f, null, null, null };
				if (!(bool)inputMethod.Invoke(null, args)) throw new InvalidOperationException("input_refused: " + args[11]);
				RecordVisibility("after_input");
				string result = args[11] as string;
				if (result != null && result.IndexOf("\"success\":false", StringComparison.Ordinal) >= 0)
					throw new InvalidOperationException("input_failed: " + result);
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

		private static void OnQuitting()
		{
			if (!ownedFixture) return;
			foreach (string key in GetArg("-uctSpikePrefs", string.Empty).Split(','))
				if (key.StartsWith("UCTViewportProof_", StringComparison.Ordinal)) EditorPrefs.DeleteKey(key);
			File.WriteAllText(Path.Combine(outputDir, "quitting.txt"), "normal EditorApplication.quitting");
		}

		private static void Finish(string fatalError)
		{
			if (finished)
			{
				return;
			}

			finished = true;
			if (autoQuit || !ownedFixture) EditorApplication.update -= Tick;

			StringBuilder json = new StringBuilder();
			json.Append("{");
			json.Append("\"success\":").Append(fatalError == null && allCapturesSucceeded && inputChanged ? "true" : "false");
			json.Append(",\"editorVersion\":\"").Append(Escape(Application.unityVersion)).Append("\"");
			json.Append(",\"platform\":\"").Append(Escape(SystemInfo.operatingSystem)).Append("\"");
			json.Append(",\"coreLibrary\":\"").Append(Escape(typeof(object).Assembly.GetName().Name)).Append("\"");
			json.Append(",\"editorPid\":").Append(System.Diagnostics.Process.GetCurrentProcess().Id);
			json.Append(",\"firstFrameAt\":\"").Append(Escape(firstFrameAt)).Append("\"");
			json.Append(",\"pixelsPerPoint\":").Append(EditorGUIUtility.pixelsPerPoint.ToString(CultureInfo.InvariantCulture));
			json.Append(",\"visibilityEvidence\":[").Append(string.Join(",", visibilityEvidence.ToArray())).Append("]");
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
				EditorApplication.Exit(fatalError == null && allCapturesSucceeded && inputChanged ? 0 : 3);
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

		#if UNITY_EDITOR_WIN
		private delegate bool EnumWindowCallback(IntPtr window, IntPtr state);
		[System.Runtime.InteropServices.DllImport("user32.dll")]
		private static extern bool EnumWindows(EnumWindowCallback callback, IntPtr state);
		[System.Runtime.InteropServices.DllImport("user32.dll")]
		private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
		[System.Runtime.InteropServices.DllImport("user32.dll")]
		private static extern bool IsWindowVisible(IntPtr window);
		#endif
		private static readonly List<string> visibilityEvidence = new List<string>();
		private static void RecordVisibility(string phase)
		{
			if (!ownedFixture || !GetBoolArg("-uctSpikeHiddenGate", false)) return;
			#if UNITY_EDITOR_WIN
			uint ownedPid = (uint)System.Diagnostics.Process.GetCurrentProcess().Id;
			int windows = 0, visible = 0;
			bool enumerated = EnumWindows((window, state) => {
				uint pid;
				GetWindowThreadProcessId(window, out pid);
				if (pid == ownedPid) { windows++; if (IsWindowVisible(window)) visible++; }
				return true;
			}, IntPtr.Zero);
			visibilityEvidence.Add("{\"phase\":\"" + Escape(phase) + "\",\"at\":\"" + DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture)
				+ "\",\"enumerated\":" + (enumerated ? "true" : "false") + ",\"windows\":" + windows + ",\"visible\":" + visible + "}");
			#endif
		}

		private static bool HasFixtureColors(Texture2D texture)
		{
			int red = 0, green = 0;
			int stepX = Mathf.Max(1, texture.width / 64);
			int stepY = Mathf.Max(1, texture.height / 64);
			for (int y = 0; y < texture.height; y += stepY)
				for (int x = 0; x < texture.width; x += stepX)
				{
					Color32 c = texture.GetPixel(x, y);
					if (c.r > 50 && c.r > c.g * 1.7f && c.r > c.b * 1.7f) red++;
					if (c.g > 50 && c.g > c.r * 1.7f && c.g > c.b * 1.7f) green++;
				}
			return red >= 4 && green >= 4;
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

		private static MethodInfo FindMethod(Type type, string name, Type[] parameters)
		{
			for (Type current = type; current != null; current = current.BaseType)
			{
				MethodInfo method = current.GetMethod(name, BindingFlags.NonPublic | BindingFlags.Public | BindingFlags.Instance, null, parameters, null);
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
					string signature = method.ReturnType.FullName + " " + method.Name + "(" + string.Join(",", Array.ConvertAll(method.GetParameters(), p => p.ParameterType.FullName)) + ")";
					if (names.Contains(signature) == false)
					{
						names.Add(signature);
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
