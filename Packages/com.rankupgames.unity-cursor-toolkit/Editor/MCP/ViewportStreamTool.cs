// =============================================================================
// Author: Miguel A. Lopez
// Company: Rank Up Games LLC
// Project: Unity Cursor Toolkit
// Description: MCP viewport stream capture and layered input adapter.
// =============================================================================

#if UNITY_EDITOR

using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using UnityEditor;
using UnityEngine;
using UnityCursorToolkit.AgentCommands;
using UnityCursorToolkit.Core;

namespace UnityCursorToolkit.MCP
{
	[MCPTool("viewport_stream")]
	internal sealed class ViewportStreamTool : IToolHandler
	{
		private static bool running;
		private static readonly Dictionary<string, StreamSession> sessions = new Dictionary<string, StreamSession>();

		public string ToolName => "viewport_stream";
		public string Description => "Start, stop, inspect, or send input to a Unity viewport stream.";

		public string HandleCommand(string argsJson)
		{
			Args args = ParseArgs(argsJson);
			switch (args.action ?? "status")
			{
				case "start":
					return Start(args);
				case "stop":
					return Stop(args);
				case "status":
					return Status(args);
				case "input":
					return Input(args, argsJson);
				default:
					return Error("Unknown viewport_stream action: " + args.action);
			}
		}

		private static string Start(Args args)
		{
			string sessionId = string.IsNullOrEmpty(args.sessionId) ? "viewport_" + DateTime.UtcNow.Ticks : args.sessionId;
			string view = NormalizeView(args);
			StopMatching(sessionId, view);

			StreamSession session = new StreamSession
			{
				sessionId = sessionId,
				view = view,
				host = string.IsNullOrEmpty(args.host) ? "editor" : args.host,
				width = args.width > 0 ? args.width : 640,
				height = args.height > 0 ? args.height : 360,
				fps = args.fps > 0 ? args.fps : 10,
				quality = args.quality > 0 ? Mathf.Clamp(args.quality, 1, 100) : 70,
				captureMode = NormalizeCaptureMode(args),
				sequence = 0,
				nextFrameTime = 0,
				lastFramePath = string.Empty,
				lastError = string.Empty,
				outputFolder = Path.Combine(Application.temporaryCachePath, "uct_viewport_stream", SafePathSegment(view))
			};
			Directory.CreateDirectory(session.outputFolder);
			sessions[session.sessionId] = session;
			EnsureTickRegistered();
			return "{\"success\":true,\"sessionId\":\"" + Escape(session.sessionId) + "\",\"view\":\"" + Escape(session.view) + "\",\"host\":\"" + Escape(session.host) + "\",\"captureMode\":\"" + Escape(session.captureMode) + "\",\"width\":" + session.width + ",\"height\":" + session.height + ",\"fps\":" + session.fps + ",\"quality\":" + session.quality + ",\"runningSessions\":" + sessions.Count + "}";
		}

		private static string Stop(Args args)
		{
			int stopped = StopMatching(args.sessionId, NormalizeView(args, false));
			if (sessions.Count == 0)
			{
				EditorApplication.update -= Tick;
				running = false;
			}

			return "{\"success\":true,\"running\":" + Bool(sessions.Count > 0) + ",\"stopped\":" + stopped + ",\"runningSessions\":" + sessions.Count + "}";
		}

		private static string Status(Args args)
		{
			StreamSession session = FindSession(args.sessionId, NormalizeView(args, false));
			return "{\"success\":true,\"running\":" + Bool(sessions.Count > 0)
				+ ",\"runningSessions\":" + sessions.Count
				+ (session == null ? "" : ",\"session\":" + SerializeSession(session))
				+ ",\"sessions\":" + SerializeSessions()
				+ ",\"inputSystemAvailable\":" + Bool(IsInputSystemAvailable())
				+ "}";
		}

		private static string Input(Args args, string argsJson)
		{
			string inputType = string.IsNullOrEmpty(args.inputType) ? "tap" : args.inputType;
			StreamSession session = FindSession(args.sessionId, NormalizeView(args, false));
			string editorWindowResult;
			if (session != null && session.captureMode == "editorWindow" && TryEditorWindowInput(session, args, out editorWindowResult))
			{
				return IsFailure(editorWindowResult)
					? "{\"success\":false,\"layer\":\"editorWindow\",\"result\":" + editorWindowResult + "}"
					: "{\"success\":true,\"layer\":\"editorWindow\",\"result\":" + editorWindowResult + "}";
			}

			string adapterResult;
			if (TryProjectAdapter(inputType, argsJson, out adapterResult))
			{
				if (IsFailure(adapterResult))
				{
					return "{\"success\":false,\"layer\":\"projectAdapter\",\"result\":" + adapterResult + "}";
				}

				return "{\"success\":true,\"layer\":\"projectAdapter\",\"result\":" + adapterResult + "}";
			}

			string inputSystemResult;
			if (TryInputSystemFallback(args, out inputSystemResult))
			{
				return "{\"success\":true,\"layer\":\"inputSystem\",\"result\":" + inputSystemResult + "}";
			}

			return Error("No viewport input adapter is available. Register game_command viewport." + inputType + " or enable supported Input System fallback.");
		}

		private static void Tick()
		{
			if (running == false || sessions.Count == 0)
			{
				return;
			}

			double now = EditorApplication.timeSinceStartup;
			List<StreamSession> activeSessions = new List<StreamSession>(sessions.Values);
			foreach (StreamSession session in activeSessions)
			{
				if (now < session.nextFrameTime)
				{
					continue;
				}

				session.nextFrameTime = now + (1.0 / Math.Max(1, session.fps));
				CaptureFrame(session);
			}
		}

		private static void CaptureFrame(StreamSession session)
		{
			if (session.captureMode == "editorWindow" || session.captureMode == "auto")
			{
				if (CaptureEditorWindowFrame(session) || session.captureMode == "editorWindow")
				{
					return;
				}
			}

			Camera camera = ResolveCamera(session);
			if (camera == null)
			{
				session.lastError = session.view == "game"
					? "No Camera.main is available for Game View capture."
					: "No active SceneView camera is available for Scene View capture.";
				return;
			}

			RenderTexture previousTarget = camera.targetTexture;
			RenderTexture previousActive = RenderTexture.active;
			RenderTexture rt = new RenderTexture(session.width, session.height, 24);
			Texture2D texture = new Texture2D(session.width, session.height, TextureFormat.RGB24, false);
			try
			{
				camera.targetTexture = rt;
				RenderTexture.active = rt;
				camera.Render();
				texture.ReadPixels(new Rect(0, 0, session.width, session.height), 0, 0);
				texture.Apply();

				session.sequence++;
				string framePath = Path.Combine(session.outputFolder, session.sessionId + "_" + session.sequence.ToString("D6") + ".jpg");
				byte[] bytes = texture.EncodeToJPG(session.quality);
				File.WriteAllBytes(framePath, bytes);
				session.lastFramePath = framePath;
				session.lastError = string.Empty;
					BroadcastFrame(session, bytes, session.width, session.height, framePath, false);
			}
			catch (Exception ex)
			{
				session.lastError = ex.Message;
			}
			finally
			{
				camera.targetTexture = previousTarget;
				RenderTexture.active = previousActive;
				UnityEngine.Object.DestroyImmediate(rt);
				UnityEngine.Object.DestroyImmediate(texture);
			}
		}

		private static bool CaptureEditorWindowFrame(StreamSession session)
		{
			EditorWindowViewportCapture.Frame frame;
			string error;
			if (EditorWindowViewportCapture.TryCapture(session.view, session.quality, session.width, session.height, out frame, out error) == false)
			{
				session.lastError = error;
				return false;
			}

			session.sequence++;
			session.width = frame.width;
			session.height = frame.height;
			session.lastFramePath = string.Empty;
			session.lastError = string.Empty;
			BroadcastFrame(session, frame.bytes, frame.width, frame.height, string.Empty, frame.flippedVertical);
			return true;
		}

		private static void BroadcastFrame(StreamSession session, byte[] bytes, int width, int height, string framePath, bool flippedVertical)
		{
			HotReloadHandler.BroadcastToClients("{\"command\":\"viewportFrame\",\"sessionId\":\"" + Escape(session.sessionId)
				+ "\",\"view\":\"" + Escape(session.view)
				+ "\",\"host\":\"" + Escape(session.host)
				+ "\",\"captureMode\":\"" + Escape(session.captureMode)
				+ "\",\"path\":\"" + Escape(framePath)
				+ "\",\"data\":\"" + Convert.ToBase64String(bytes)
				+ "\",\"sequence\":" + session.sequence
				+ ",\"width\":" + width
				+ ",\"height\":" + height
				+ ",\"flippedVertical\":" + Bool(flippedVertical)
				+ ",\"timestamp\":\"" + Escape(DateTime.UtcNow.ToString("o")) + "\"}");
		}

		private static Camera ResolveCamera(StreamSession session)
		{
			if (session.view == "game")
			{
				return Camera.main;
			}

			if (session.view == "scene")
			{
				return SceneView.lastActiveSceneView == null ? null : SceneView.lastActiveSceneView.camera;
			}

			if (Camera.main != null)
			{
				return Camera.main;
			}

			return SceneView.lastActiveSceneView == null ? null : SceneView.lastActiveSceneView.camera;
		}

		private static void EnsureTickRegistered()
		{
			if (running)
			{
				return;
			}

			running = true;
			EditorApplication.update += Tick;
		}

		private static int StopMatching(string sessionId, string view)
		{
			List<string> keys = new List<string>();
			foreach (KeyValuePair<string, StreamSession> pair in sessions)
			{
				bool matchesSession = string.IsNullOrEmpty(sessionId) == false && pair.Value.sessionId == sessionId;
				bool matchesView = string.IsNullOrEmpty(view) == false && pair.Value.view == view;
				bool stopAll = string.IsNullOrEmpty(sessionId) && string.IsNullOrEmpty(view);
				if (matchesSession || matchesView || stopAll)
				{
					keys.Add(pair.Key);
				}
			}

			foreach (string key in keys)
			{
				sessions.Remove(key);
			}

			return keys.Count;
		}

		private static StreamSession FindSession(string sessionId, string view)
		{
			if (string.IsNullOrEmpty(sessionId) == false)
			{
				StreamSession session;
				return sessions.TryGetValue(sessionId, out session) ? session : null;
			}

			if (string.IsNullOrEmpty(view))
			{
				return null;
			}

			foreach (StreamSession session in sessions.Values)
			{
				if (session.view == view)
				{
					return session;
				}
			}

			return null;
		}

		private static string NormalizeView(Args args, bool defaultAuto = true)
		{
			string view = args == null ? string.Empty : args.view;
			if (string.IsNullOrEmpty(view))
			{
				if (args != null && args.host == "player")
				{
					view = "game";
				}
				else if (defaultAuto)
				{
					view = "scene";
				}
			}

			if (view == "game" || view == "scene" || view == "inspector" || view == "packageManager")
			{
				return view;
			}

			if (view != null && view.StartsWith("window:", StringComparison.Ordinal) && view.Length > "window:".Length)
			{
				return view;
			}

			return defaultAuto ? "scene" : string.Empty;
		}

		private static string NormalizeCaptureMode(Args args)
		{
			string captureMode = args == null ? string.Empty : args.captureMode;
			if (string.Equals(captureMode, "camera", StringComparison.OrdinalIgnoreCase))
			{
				return "camera";
			}

			if (string.Equals(captureMode, "auto", StringComparison.OrdinalIgnoreCase))
			{
				return "auto";
			}

			if (args != null && args.host == "player")
			{
				return "camera";
			}

			return "editorWindow";
		}

		private static string SerializeSessions()
		{
			List<string> values = new List<string>();
			foreach (StreamSession session in sessions.Values)
			{
				values.Add(SerializeSession(session));
			}

			return "[" + string.Join(",", values.ToArray()) + "]";
		}

		private static string SerializeSession(StreamSession session)
		{
			return "{\"sessionId\":\"" + Escape(session.sessionId) + "\""
				+ ",\"view\":\"" + Escape(session.view) + "\""
				+ ",\"host\":\"" + Escape(session.host) + "\""
				+ ",\"captureMode\":\"" + Escape(session.captureMode) + "\""
				+ ",\"width\":" + session.width
				+ ",\"height\":" + session.height
				+ ",\"fps\":" + session.fps
				+ ",\"quality\":" + session.quality
				+ ",\"sequence\":" + session.sequence
				+ ",\"lastFramePath\":\"" + Escape(session.lastFramePath) + "\""
				+ ",\"lastError\":\"" + Escape(session.lastError) + "\""
				+ "}";
		}

		private static bool TryProjectAdapter(string inputType, string argsJson, out string result)
		{
			result = null;
			string commandName = "viewport." + inputType;
			AgentCommandDescriptor descriptor;
			AgentCommandHandler handler;
			if (AgentCommandRegistry.TryGet(commandName, out descriptor, out handler) == false)
			{
				return false;
			}

			result = AgentCommandRunner.Run(commandName, argsJson).ToJson();
			return true;
		}

		private static bool TryEditorWindowInput(StreamSession session, Args args, out string result)
		{
			return EditorWindowViewportCapture.TrySendInput(session.view, args.inputType, args.x, args.y, args.x2, args.y2, args.dx, args.dy, args.wheelDelta, args.key, args.text, out result);
		}

		private static bool TryInputSystemFallback(Args args, out string result)
		{
			result = null;
			if (IsInputSystemAvailable() == false)
			{
				return false;
			}

			// Reflection keeps the package usable in projects that do not install Unity's Input System.
			string inputType = string.IsNullOrEmpty(args.inputType) ? "tap" : args.inputType;
			switch (inputType)
			{
				case "text":
					return TryQueueTextInput(args, out result);
				case "key":
					return TryQueueKeyInput(args, out result);
				case "tap":
					return TryQueueTouchInput(args, false, out result);
				case "swipe":
					return TryQueueTouchInput(args, true, out result);
				default:
					return false;
			}
		}

		private static bool TryQueueTextInput(Args args, out string result)
		{
			result = null;
			if (string.IsNullOrEmpty(args.text))
			{
				return false;
			}

			try
			{
				Type inputSystem = Type.GetType("UnityEngine.InputSystem.InputSystem, Unity.InputSystem");
				Type keyboardType = Type.GetType("UnityEngine.InputSystem.Keyboard, Unity.InputSystem");
				if (inputSystem == null || keyboardType == null)
				{
					return false;
				}

				object keyboard = keyboardType.GetProperty("current", BindingFlags.Public | BindingFlags.Static).GetValue(null, null);
				if (keyboard == null)
				{
					return false;
				}

				MethodInfo method = null;
				foreach (MethodInfo candidate in inputSystem.GetMethods(BindingFlags.Public | BindingFlags.Static))
				{
					if (candidate.Name == "QueueTextEvent")
					{
						method = candidate;
						break;
					}
				}

				if (method == null)
				{
					return false;
				}

				foreach (char character in args.text)
				{
					method.Invoke(null, new object[] { keyboard, character });
				}

				result = "{\"queuedTextLength\":" + args.text.Length + "}";
				return true;
			}
			catch
			{
				return false;
			}
		}

		private static bool TryQueueKeyInput(Args args, out string result)
		{
			result = null;
			if (string.IsNullOrEmpty(args.key))
			{
				return false;
			}

			try
			{
				Type inputSystem = Type.GetType("UnityEngine.InputSystem.InputSystem, Unity.InputSystem");
				Type keyboardType = Type.GetType("UnityEngine.InputSystem.Keyboard, Unity.InputSystem");
				Type keyType = Type.GetType("UnityEngine.InputSystem.Key, Unity.InputSystem");
				Type keyboardStateType = Type.GetType("UnityEngine.InputSystem.LowLevel.KeyboardState, Unity.InputSystem");
				if (inputSystem == null || keyboardType == null || keyType == null || keyboardStateType == null)
				{
					return false;
				}

				object keyboard = keyboardType.GetProperty("current", BindingFlags.Public | BindingFlags.Static).GetValue(null, null);
				if (keyboard == null)
				{
					return false;
				}

				object key = Enum.Parse(keyType, NormalizeKeyName(args.key), true);
				Array keys = Array.CreateInstance(keyType, 1);
				keys.SetValue(key, 0);
				object pressedState = Activator.CreateInstance(keyboardStateType, new object[] { keys });
				object releasedState = Activator.CreateInstance(keyboardStateType);
				if (QueueStateEvent(inputSystem, keyboardStateType, keyboard, pressedState) == false)
				{
					return false;
				}

				QueueStateEvent(inputSystem, keyboardStateType, keyboard, releasedState);
				result = "{\"queuedKey\":\"" + Escape(args.key) + "\"}";
				return true;
			}
			catch
			{
				return false;
			}
		}

		private static bool TryQueueTouchInput(Args args, bool swipe, out string result)
		{
			result = null;
			try
			{
				Type inputSystem = Type.GetType("UnityEngine.InputSystem.InputSystem, Unity.InputSystem");
				Type touchscreenType = Type.GetType("UnityEngine.InputSystem.Touchscreen, Unity.InputSystem");
				Type touchStateType = Type.GetType("UnityEngine.InputSystem.LowLevel.TouchState, Unity.InputSystem");
				Type phaseType = Type.GetType("UnityEngine.InputSystem.TouchPhase, Unity.InputSystem");
				if (inputSystem == null || touchscreenType == null || touchStateType == null || phaseType == null)
				{
					return false;
				}

				object touchscreen = touchscreenType.GetProperty("current", BindingFlags.Public | BindingFlags.Static).GetValue(null, null);
				if (touchscreen == null)
				{
					return false;
				}

				Vector2 start = new Vector2(args.x, args.y);
				Vector2 end = swipe ? new Vector2(args.x2, args.y2) : start;
				if (QueueTouchState(inputSystem, touchStateType, phaseType, touchscreen, 1, "Began", start, start) == false)
				{
					return false;
				}

				if (swipe)
				{
					QueueTouchState(inputSystem, touchStateType, phaseType, touchscreen, 1, "Moved", end, start);
				}

				QueueTouchState(inputSystem, touchStateType, phaseType, touchscreen, 1, "Ended", end, start);
				result = "{\"queuedTouch\":\"" + (swipe ? "swipe" : "tap") + "\",\"x\":" + args.x + ",\"y\":" + args.y + "}";
				return true;
			}
			catch
			{
				return false;
			}
		}

		private static bool QueueTouchState(Type inputSystem, Type touchStateType, Type phaseType, object touchscreen, int touchId, string phaseName, Vector2 position, Vector2 startPosition)
		{
			object state = Activator.CreateInstance(touchStateType);
			SetMember(state, touchStateType, "touchId", touchId);
			SetMember(state, touchStateType, "phase", Enum.Parse(phaseType, phaseName));
			SetMember(state, touchStateType, "position", position);
			SetMember(state, touchStateType, "startPosition", startPosition);
			SetMember(state, touchStateType, "tapCount", 1);
			return QueueStateEvent(inputSystem, touchStateType, touchscreen, state);
		}

		private static bool QueueStateEvent(Type inputSystem, Type stateType, object device, object state)
		{
			foreach (MethodInfo candidate in inputSystem.GetMethods(BindingFlags.Public | BindingFlags.Static))
			{
				if (candidate.Name != "QueueStateEvent" || candidate.IsGenericMethodDefinition == false)
				{
					continue;
				}

				ParameterInfo[] parameters = candidate.GetParameters();
				if (parameters.Length < 2)
				{
					continue;
				}

				MethodInfo method = candidate.MakeGenericMethod(stateType);
				if (parameters.Length >= 3)
				{
					method.Invoke(null, new object[] { device, state, -1.0 });
				}
				else
				{
					method.Invoke(null, new object[] { device, state });
				}

				return true;
			}

			return false;
		}

		private static void SetMember(object target, Type type, string name, object value)
		{
			FieldInfo field = type.GetField(name, BindingFlags.Public | BindingFlags.Instance);
			if (field != null)
			{
				field.SetValue(target, value);
				return;
			}

			PropertyInfo property = type.GetProperty(name, BindingFlags.Public | BindingFlags.Instance);
			if (property != null && property.CanWrite)
			{
				property.SetValue(target, value, null);
			}
		}

		private static string NormalizeKeyName(string key)
		{
			if (string.Equals(key, " ", StringComparison.Ordinal))
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

		private static bool IsFailure(string json)
		{
			return string.IsNullOrEmpty(json) == false && json.Contains("\"success\":false");
		}

		private static bool IsInputSystemAvailable()
		{
			return Type.GetType("UnityEngine.InputSystem.InputSystem, Unity.InputSystem") != null;
		}

		private static Args ParseArgs(string json)
		{
			if (string.IsNullOrEmpty(json))
			{
				return new Args();
			}

			try
			{
				return JsonUtility.FromJson<Args>(json) ?? new Args();
			}
			catch
			{
				return new Args();
			}
		}

		private static string Error(string message)
		{
			return "{\"success\":false,\"error\":\"" + Escape(message) + "\",\"inputSystemAvailable\":" + Bool(IsInputSystemAvailable()) + "}";
		}

		private static string Escape(string value)
		{
			return AgentCommandJson.Escape(value);
		}

		private static string SafePathSegment(string value)
		{
			if (string.IsNullOrEmpty(value))
			{
				return "viewport";
			}

			char[] invalid = Path.GetInvalidFileNameChars();
			char[] chars = value.ToCharArray();
			for (int index = 0; index < chars.Length; index++)
			{
				if (Array.IndexOf(invalid, chars[index]) >= 0 || chars[index] == ':' || chars[index] == '\\' || chars[index] == '/')
				{
					chars[index] = '_';
				}
			}

			return new string(chars);
		}

		private static string Bool(bool value)
		{
			return value ? "true" : "false";
		}

		[Serializable]
		private sealed class Args
		{
			public string action;
			public string sessionId;
			public string host;
			public string view;
			public string captureMode;
			public int width;
			public int height;
			public int fps;
			public int quality;
			public string inputType;
			public float x;
			public float y;
			public float x2;
			public float y2;
			public float dx;
			public float dy;
			public float wheelDelta;
			public string button;
			public string key;
			public string text;
			public int durationMs;
		}

		private sealed class StreamSession
		{
			public string sessionId;
			public string view;
			public string host;
			public string captureMode;
			public int width;
			public int height;
			public int fps;
			public int quality;
			public int sequence;
			public double nextFrameTime;
			public string outputFolder;
			public string lastFramePath;
			public string lastError;
		}
	}
}

#endif
