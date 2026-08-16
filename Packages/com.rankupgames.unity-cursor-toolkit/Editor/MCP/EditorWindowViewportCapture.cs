// =============================================================================
// Author: Miguel A. Lopez
// Company: Rank Up Games LLC
// Project: Unity Cursor Toolkit
// Description: Real Unity EditorWindow backbuffer capture/input bridge for
//              viewport_stream. Uses the installed editor in-process; it does
//              not load, redistribute, or re-host Unity editor binaries.
// =============================================================================

#if UNITY_EDITOR

using System;
using System.Collections.Generic;
using System.Reflection;
using UnityEditor;
using UnityEngine;
using UnityCursorToolkit.AgentCommands;

namespace UnityCursorToolkit.MCP
{
	internal static class EditorWindowViewportCapture
	{
		private const int MaxMainEditorCaptureWidth = 4096;
		private const int MaxMainEditorCaptureHeight = 4096;
		private static readonly Dictionary<string, CaptureResources> resourcesByKey = new Dictionary<string, CaptureResources>();

		static EditorWindowViewportCapture()
		{
			AssemblyReloadEvents.beforeAssemblyReload += DisposeCachedResources;
			EditorApplication.quitting += DisposeCachedResources;
		}

		internal sealed class Frame
		{
			public byte[] bytes;
			public int width;
			public int height;
			public bool flippedVertical;
		}

		internal static bool TryCapture(string view, int quality, out Frame frame, out string error)
		{
			return TryCapture(view, quality, 0, 0, out frame, out error);
		}

		internal static bool TryCapture(string view, int quality, int maxWidth, int maxHeight, out Frame frame, out string error)
		{
			frame = null;
			error = string.Empty;
			EditorWindow window = ResolveWindow(view);
			if (window == null)
			{
				error = "EditorWindow unavailable for view: " + view;
				return false;
			}

			RenderTexture previousActive = RenderTexture.active;
			try
			{
				object parent = GetHostView(window);
				if (parent == null)
				{
					error = "EditorWindow.m_Parent HostView unavailable.";
					return false;
				}

				MethodInfo grab = FindMethod(parent.GetType(), "GrabPixels", typeof(RenderTexture), typeof(Rect));
				if (grab == null)
				{
					error = "GUIView.GrabPixels missing. Methods: " + DescribeMethods(parent.GetType());
					return false;
				}

				RepaintImmediately(window);
				float ppp = EditorGUIUtility.pixelsPerPoint;
					int sourceWidth = Mathf.Max(8, Mathf.RoundToInt(window.position.width * ppp));
					int sourceHeight = Mathf.Max(8, Mathf.RoundToInt(window.position.height * ppp));
					Vector2Int outputSize = FitWithin(sourceWidth, sourceHeight, maxWidth, maxHeight);
					bool flipVertical = ShouldFlipReadbackVertically(view);
					CaptureResources resources = GetResources(view ?? string.Empty, sourceWidth, sourceHeight, outputSize.x, outputSize.y, flipVertical);

					grab.Invoke(parent, new object[] { resources.captureRt, new Rect(0f, 0f, sourceWidth, sourceHeight) });

					RenderTexture readRt = resources.captureRt;
					if (resources.scaledRt != null)
					{
						Vector2 scale = flipVertical ? new Vector2(1f, -1f) : Vector2.one;
						Vector2 offset = flipVertical ? new Vector2(0f, 1f) : Vector2.zero;
						Graphics.Blit(resources.captureRt, resources.scaledRt, scale, offset);
						readRt = resources.scaledRt;
					}

				RenderTexture.active = readRt;
				resources.texture.ReadPixels(new Rect(0f, 0f, resources.outputWidth, resources.outputHeight), 0, 0);
				resources.texture.Apply();

					frame = new Frame
					{
						bytes = resources.texture.EncodeToJPG(Mathf.Clamp(quality, 1, 100)),
						width = resources.outputWidth,
						height = resources.outputHeight,
						flippedVertical = flipVertical
					};
					return true;
			}
			catch (Exception ex)
			{
				error = ex.GetType().Name + ": " + ex.Message;
				return false;
			}
			finally
			{
				RenderTexture.active = previousActive;
			}
		}

		internal static bool TryCaptureMainEditorWindow(out Frame frame, out string error)
		{
			frame = null;
			error = string.Empty;
			object rootView;
			try
			{
				rootView = GetMainEditorRootView(out error);
			}
			catch (Exception ex)
			{
				error = "Main editor root view unavailable; root-view capture unavailable. " + ex.GetType().Name + ": " + ex.Message;
				return false;
			}

			if (rootView == null)
			{
				return false;
			}

			RenderTexture previousActive = RenderTexture.active;
			CaptureResources resources = null;
			try
			{
				MethodInfo grab = FindMethod(rootView.GetType(), "GrabPixels", typeof(RenderTexture), typeof(Rect));
				if (grab == null)
				{
					error = "GUIView.GrabPixels unavailable on the main editor root view (" + rootView.GetType().FullName + ").";
					return false;
				}

				Rect rootPosition;
				if (TryGetViewPosition(rootView, out rootPosition) == false)
				{
					error = "Main editor root view position unavailable; root-view capture unavailable.";
					return false;
				}

				float ppp = Mathf.Max(0.01f, EditorGUIUtility.pixelsPerPoint);
				int requestedWidth = Mathf.Max(8, Mathf.RoundToInt(rootPosition.width * ppp));
				int requestedHeight = Mathf.Max(8, Mathf.RoundToInt(rootPosition.height * ppp));
				Vector2Int captureSize = FitWithin(requestedWidth, requestedHeight, MaxMainEditorCaptureWidth, MaxMainEditorCaptureHeight);
				bool flipVertical = ShouldFlipReadbackVertically("main-editor");
				resources = new CaptureResources(captureSize.x, captureSize.y, captureSize.x, captureSize.y, flipVertical);

				RepaintViewImmediately(rootView);
				// GrabPixels reads a view-space rectangle in points and scales it into
				// the target render texture, matching Unity's CaptureEditorWindow path.
				grab.Invoke(rootView, new object[]
				{
					resources.captureRt,
					new Rect(0f, 0f, rootPosition.width, rootPosition.height)
				});

				RenderTexture readRt = resources.captureRt;
				if (resources.scaledRt != null)
				{
					Vector2 scale = flipVertical ? new Vector2(1f, -1f) : Vector2.one;
					Vector2 offset = flipVertical ? new Vector2(0f, 1f) : Vector2.zero;
					Graphics.Blit(resources.captureRt, resources.scaledRt, scale, offset);
					readRt = resources.scaledRt;
				}

				RenderTexture.active = readRt;
				resources.texture.ReadPixels(new Rect(0f, 0f, resources.outputWidth, resources.outputHeight), 0, 0);
				resources.texture.Apply();
				byte[] bytes = resources.texture.EncodeToPNG();
				if (bytes == null || bytes.Length == 0)
				{
					error = "Main editor root view capture returned an empty PNG.";
					return false;
				}

				frame = new Frame
				{
					bytes = bytes,
					width = resources.outputWidth,
					height = resources.outputHeight,
					flippedVertical = flipVertical
				};
				return true;
			}
			catch (Exception ex)
			{
				error = ex.GetType().Name + ": " + ex.Message;
				return false;
			}
			finally
			{
				RenderTexture.active = previousActive;
				if (resources != null)
				{
					resources.Dispose();
				}
			}
		}

		internal static bool TrySendInput(string view, string inputType, float x, float y, float x2, float y2, float dx, float dy, float wheelDelta, string key, string text, out string result)
		{
			result = null;
			EditorWindow window = ResolveWindow(view);
			if (window == null)
			{
				return false;
			}

			string normalized = string.IsNullOrEmpty(inputType) ? "tap" : inputType;
			try
			{
				if (view == "scene")
				{
					if (normalized == "sceneDrag")
					{
						SendMouse(window, EventType.MouseDown, x, y, 0f, 0f, 0, EventModifiers.Alt);
						SendMouse(window, EventType.MouseDrag, x2, y2, x2 - x, y2 - y, 0, EventModifiers.Alt);
						SendMouse(window, EventType.MouseUp, x2, y2, 0f, 0f, 0, EventModifiers.Alt);
						result = "{\"editorWindowInput\":\"sceneDrag\"}";
						return true;
					}

					if (normalized == "sceneZoom")
					{
						SendWheel(window, x, y, wheelDelta);
						result = "{\"editorWindowInput\":\"sceneZoom\",\"wheelDelta\":" + wheelDelta.ToString(System.Globalization.CultureInfo.InvariantCulture) + "}";
						return true;
					}
				}

				if (normalized == "pointerDown" || normalized == "tap")
				{
					SendMouse(window, EventType.MouseDown, x, y, 0f, 0f, 0, EventModifiers.None);
					result = "{\"editorWindowInput\":\"pointerDown\"}";
					return true;
				}

				if (normalized == "pointerMove" || normalized == "mouseDelta")
				{
					SendMouse(window, EventType.MouseDrag, x2 > 0f ? x2 : x, y2 > 0f ? y2 : y, dx, dy, 0, EventModifiers.None);
					result = "{\"editorWindowInput\":\"pointerMove\"}";
					return true;
				}

				if (normalized == "pointerUp")
				{
					SendMouse(window, EventType.MouseUp, x2 > 0f ? x2 : x, y2 > 0f ? y2 : y, 0f, 0f, 0, EventModifiers.None);
					result = "{\"editorWindowInput\":\"pointerUp\"}";
					return true;
				}

				if (normalized == "wheel")
				{
					SendWheel(window, x, y, wheelDelta);
					result = "{\"editorWindowInput\":\"wheel\"}";
					return true;
				}

				if (normalized == "key" && string.IsNullOrEmpty(key) == false)
				{
					SendKey(window, key);
					result = "{\"editorWindowInput\":\"key\",\"key\":\"" + AgentCommandJson.Escape(key) + "\"}";
					return true;
				}

				if (normalized == "text" && string.IsNullOrEmpty(text) == false)
				{
					foreach (char character in text)
					{
						Event evt = new Event();
						evt.type = EventType.KeyDown;
						evt.character = character;
						window.SendEvent(evt);
					}
					result = "{\"editorWindowInput\":\"text\",\"length\":" + text.Length + "}";
					return true;
				}
			}
			catch (Exception ex)
			{
				result = "{\"success\":false,\"error\":\"" + AgentCommandJson.Escape(ex.GetType().Name + ": " + ex.Message) + "\"}";
				return true;
			}

			return false;
		}

		private static EditorWindow ResolveWindow(string view)
		{
			if (view == "scene")
			{
				return SceneView.lastActiveSceneView != null ? SceneView.lastActiveSceneView : EditorWindow.GetWindow(typeof(SceneView));
			}

			if (view == "game")
			{
				Type gameViewType = typeof(Editor).Assembly.GetType("UnityEditor.GameView");
				return gameViewType == null ? null : EditorWindow.GetWindow(gameViewType);
			}

			if (view == "inspector")
			{
				Type inspectorType = typeof(Editor).Assembly.GetType("UnityEditor.InspectorWindow");
				return inspectorType == null ? null : EditorWindow.GetWindow(inspectorType);
			}

			if (view == "packageManager")
			{
				return ResolvePackageManagerWindow();
			}

			if (view != null && view.StartsWith("window:", StringComparison.Ordinal))
			{
				return ResolveCustomWindow(view.Substring("window:".Length));
			}

			return null;
		}

		private static Vector2Int FitWithin(int sourceWidth, int sourceHeight, int maxWidth, int maxHeight)
		{
			if (maxWidth <= 0 || maxHeight <= 0 || (sourceWidth <= maxWidth && sourceHeight <= maxHeight))
			{
				return new Vector2Int(sourceWidth, sourceHeight);
			}

			float scale = Mathf.Min(maxWidth / (float) sourceWidth, maxHeight / (float) sourceHeight);
			return new Vector2Int(
				Mathf.Max(8, Mathf.RoundToInt(sourceWidth * scale)),
				Mathf.Max(8, Mathf.RoundToInt(sourceHeight * scale)));
		}

		private static CaptureResources GetResources(string view, int sourceWidth, int sourceHeight, int outputWidth, int outputHeight, bool flipVertical)
		{
			string key = view + "|" + sourceWidth + "x" + sourceHeight + ">" + outputWidth + "x" + outputHeight + "|flip=" + flipVertical;
			CaptureResources resources;
			if (resourcesByKey.TryGetValue(key, out resources))
			{
				return resources;
			}

			DisposeCachedResourcesForView(view);
			resources = new CaptureResources(sourceWidth, sourceHeight, outputWidth, outputHeight, flipVertical);
			resourcesByKey[key] = resources;
			return resources;
		}

		private static void DisposeCachedResourcesForView(string view)
		{
			string prefix = view + "|";
			List<string> staleKeys = new List<string>();
			foreach (KeyValuePair<string, CaptureResources> entry in resourcesByKey)
			{
				if (entry.Key.StartsWith(prefix, StringComparison.Ordinal))
				{
					staleKeys.Add(entry.Key);
				}
			}

			foreach (string staleKey in staleKeys)
			{
				CaptureResources resources = resourcesByKey[staleKey];
				resourcesByKey.Remove(staleKey);
				resources.Dispose();
			}
		}

		private static bool ShouldFlipReadbackVertically(string view)
		{
			// GameView and Windows editor readbacks use a bottom-origin buffer here.
			return Application.platform == RuntimePlatform.WindowsEditor || view == "game";
		}

		private static void DisposeCachedResources()
		{
			foreach (CaptureResources resources in resourcesByKey.Values)
			{
				resources.Dispose();
			}
			resourcesByKey.Clear();
		}

		private static EditorWindow ResolvePackageManagerWindow()
		{
			try
			{
				UnityEditor.PackageManager.UI.Window.Open(string.Empty);
			}
			catch
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
					return window;
				}
			}

			return null;
		}

		private static EditorWindow ResolveCustomWindow(string typeName)
		{
			if (string.IsNullOrEmpty(typeName))
			{
				return null;
			}

			Type windowType = Type.GetType(typeName);
			if (windowType == null)
			{
				foreach (Assembly assembly in AppDomain.CurrentDomain.GetAssemblies())
				{
					windowType = assembly.GetType(typeName);
					if (windowType != null)
					{
						break;
					}
				}
			}

			if (windowType == null || typeof(EditorWindow).IsAssignableFrom(windowType) == false)
			{
				return null;
			}

			return EditorWindow.GetWindow(windowType);
		}

		private static object GetHostView(EditorWindow window)
		{
			FieldInfo parentField = typeof(EditorWindow).GetField("m_Parent", BindingFlags.NonPublic | BindingFlags.Instance);
			return parentField == null ? null : parentField.GetValue(window);
		}

		private static object GetMainEditorRootView(out string error)
		{
			error = string.Empty;
			Type containerWindowType = typeof(Editor).Assembly.GetType("UnityEditor.ContainerWindow");
			if (containerWindowType == null)
			{
				error = "UnityEditor.ContainerWindow unavailable; root-view capture unavailable.";
				return null;
			}

			object mainWindow = GetStaticMemberValue(containerWindowType, "mainWindow");
			if (mainWindow == null)
			{
				mainWindow = GetStaticMemberValue(containerWindowType, "s_MainWindow");
			}

			object rootView = mainWindow == null ? null : GetMemberValue(mainWindow, "m_RootView");
			if (rootView == null && mainWindow != null)
			{
				rootView = GetMemberValue(mainWindow, "rootView");
			}

			if (rootView == null)
			{
				EditorWindow focusedWindow = EditorWindow.focusedWindow;
				object focusedView = focusedWindow == null ? null : GetHostView(focusedWindow);
				rootView = FindRootView(focusedView);
			}

			if (rootView == null)
			{
				error = "UnityEditor.ContainerWindow main window root view unavailable; root-view capture unavailable.";
			}

			return rootView;
		}

		private static object FindRootView(object view)
		{
			object current = view;
			for (int depth = 0; current != null && depth < 64; depth++)
			{
				object parent = GetMemberValue(current, "parent");
				if (parent == null)
				{
					parent = GetMemberValue(current, "m_Parent");
				}

				if (parent == null || object.ReferenceEquals(parent, current))
				{
					return current;
				}

				current = parent;
			}

			return current;
		}

		private static object GetStaticMemberValue(Type type, string memberName)
		{
			for (Type current = type; current != null; current = current.BaseType)
			{
				PropertyInfo property = current.GetProperty(memberName, BindingFlags.NonPublic | BindingFlags.Public | BindingFlags.Static);
				if (property != null && property.GetIndexParameters().Length == 0)
				{
					return property.GetValue(null, null);
				}

				FieldInfo field = current.GetField(memberName, BindingFlags.NonPublic | BindingFlags.Public | BindingFlags.Static);
				if (field != null)
				{
					return field.GetValue(null);
				}
			}

			return null;
		}

		private static object GetMemberValue(object target, string memberName)
		{
			if (target == null)
			{
				return null;
			}

			for (Type current = target.GetType(); current != null; current = current.BaseType)
			{
				PropertyInfo property = current.GetProperty(memberName, BindingFlags.NonPublic | BindingFlags.Public | BindingFlags.Instance);
				if (property != null && property.GetIndexParameters().Length == 0)
				{
					return property.GetValue(target, null);
				}

				FieldInfo field = current.GetField(memberName, BindingFlags.NonPublic | BindingFlags.Public | BindingFlags.Instance);
				if (field != null)
				{
					return field.GetValue(target);
				}
			}

			return null;
		}

		private static bool TryGetViewPosition(object view, out Rect position)
		{
			position = new Rect();
			try
			{
				object value = GetMemberValue(view, "position");
				if (value is Rect)
				{
					position = (Rect) value;
					return position.width > 0f && position.height > 0f;
				}
			}
			catch
			{
				// The editor can invalidate a root view while it is rebuilding its layout.
			}

			return false;
		}

		private static void RepaintViewImmediately(object view)
		{
			MethodInfo repaintNow = FindMethod(view.GetType(), "RepaintImmediately");
			if (repaintNow != null)
			{
				repaintNow.Invoke(view, null);
				return;
			}

			MethodInfo repaint = FindMethod(view.GetType(), "Repaint");
			if (repaint != null)
			{
				repaint.Invoke(view, null);
			}
		}

		private static void RepaintImmediately(EditorWindow window)
		{
			MethodInfo repaintNow = typeof(EditorWindow).GetMethod("RepaintImmediately", BindingFlags.NonPublic | BindingFlags.Instance);
			if (repaintNow != null)
			{
				repaintNow.Invoke(window, null);
				return;
			}

			window.Repaint();
		}

		private static void SendMouse(EditorWindow window, EventType type, float x, float y, float dx, float dy, int button, EventModifiers modifiers)
		{
			float ppp = Mathf.Max(0.01f, EditorGUIUtility.pixelsPerPoint);
			Event evt = new Event();
			evt.type = type;
			evt.mousePosition = new Vector2(x / ppp, y / ppp);
			evt.delta = new Vector2(dx / ppp, dy / ppp);
			evt.button = button;
			evt.clickCount = 1;
			evt.modifiers = modifiers;
			window.SendEvent(evt);
		}

		private static void SendWheel(EditorWindow window, float x, float y, float wheelDelta)
		{
			float ppp = Mathf.Max(0.01f, EditorGUIUtility.pixelsPerPoint);
			Event evt = new Event();
			evt.type = EventType.ScrollWheel;
			evt.mousePosition = new Vector2(x / ppp, y / ppp);
			evt.delta = new Vector2(0f, wheelDelta);
			window.SendEvent(evt);
		}

		private static void SendKey(EditorWindow window, string key)
		{
			KeyCode keyCode = KeyCode.None;
			try
			{
				keyCode = (KeyCode) Enum.Parse(typeof(KeyCode), NormalizeKeyName(key), true);
			}
			catch
			{
				if (key.Length == 1)
				{
					char upper = char.ToUpperInvariant(key[0]);
					if (upper >= 'A' && upper <= 'Z')
					{
						keyCode = (KeyCode) Enum.Parse(typeof(KeyCode), upper.ToString(), true);
					}
				}
			}

			Event down = new Event();
			down.type = EventType.KeyDown;
			down.keyCode = keyCode;
			down.character = key.Length == 1 ? key[0] : '\0';
			window.SendEvent(down);

			Event up = new Event();
			up.type = EventType.KeyUp;
			up.keyCode = keyCode;
			window.SendEvent(up);
		}

		private static string NormalizeKeyName(string key)
		{
			if (key == " ")
			{
				return "Space";
			}

			string trimmed = key.Replace(" ", string.Empty);
			if (trimmed.StartsWith("Arrow", StringComparison.OrdinalIgnoreCase) && trimmed.Length > 5)
			{
				return trimmed.Substring(5) + "Arrow";
			}

			return trimmed;
		}

		private static MethodInfo FindMethod(Type type, string name, params Type[] parameterTypes)
		{
			for (Type current = type; current != null; current = current.BaseType)
			{
				MethodInfo method = current.GetMethod(
					name,
					BindingFlags.NonPublic | BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly,
					null,
					parameterTypes,
					null);
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

		private sealed class CaptureResources : IDisposable
		{
			public readonly RenderTexture captureRt;
			public readonly RenderTexture scaledRt;
			public readonly Texture2D texture;
			public readonly int outputWidth;
			public readonly int outputHeight;

			public CaptureResources(int sourceWidth, int sourceHeight, int outputWidth, int outputHeight, bool flipVertical)
			{
				this.outputWidth = outputWidth;
				this.outputHeight = outputHeight;
				captureRt = new RenderTexture(sourceWidth, sourceHeight, 24, RenderTextureFormat.ARGB32);
				captureRt.Create();
				if (sourceWidth != outputWidth || sourceHeight != outputHeight || flipVertical)
				{
					scaledRt = new RenderTexture(outputWidth, outputHeight, 0, RenderTextureFormat.ARGB32);
					scaledRt.Create();
				}
				texture = new Texture2D(outputWidth, outputHeight, TextureFormat.RGB24, false);
			}

			public void Dispose()
			{
				if (captureRt != null)
				{
					UnityEngine.Object.DestroyImmediate(captureRt);
				}
				if (scaledRt != null)
				{
					UnityEngine.Object.DestroyImmediate(scaledRt);
				}
				if (texture != null)
				{
					UnityEngine.Object.DestroyImmediate(texture);
				}
			}
		}
	}
}

#endif
