// =============================================================================
// Author: Miguel A. Lopez
// Company: Rank Up Games LLC
// Project: Unity Cursor Toolkit
// Description: MCP viewport stream capture and layered input adapter.
// =============================================================================

#if UNITY_EDITOR

using System;
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
		private static string sessionId;
		private static int width = 640;
		private static int height = 360;
		private static int fps = 10;
		private static int quality = 70;
		private static int sequence;
		private static double nextFrameTime;
		private static string outputFolder;
		private static string lastFramePath;
		private static string lastError;

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
					return Stop();
				case "status":
					return Status();
				case "input":
					return Input(args, argsJson);
				default:
					return Error("Unknown viewport_stream action: " + args.action);
			}
		}

		private static string Start(Args args)
		{
			if (running)
			{
				Stop();
			}

			sessionId = string.IsNullOrEmpty(args.sessionId) ? "viewport_" + DateTime.UtcNow.Ticks : args.sessionId;
			width = args.width > 0 ? args.width : 640;
			height = args.height > 0 ? args.height : 360;
			fps = args.fps > 0 ? args.fps : 10;
			quality = args.quality > 0 ? Mathf.Clamp(args.quality, 1, 100) : 70;
			sequence = 0;
			lastFramePath = string.Empty;
			lastError = string.Empty;
			outputFolder = Path.Combine(Application.temporaryCachePath, "uct_viewport_stream");
			Directory.CreateDirectory(outputFolder);
			nextFrameTime = 0;
			running = true;
			EditorApplication.update += Tick;
			return "{\"success\":true,\"sessionId\":\"" + Escape(sessionId) + "\",\"width\":" + width + ",\"height\":" + height + ",\"fps\":" + fps + ",\"quality\":" + quality + "}";
		}

		private static string Stop()
		{
			if (running)
			{
				EditorApplication.update -= Tick;
			}

			running = false;
			return "{\"success\":true,\"running\":false,\"lastFramePath\":\"" + Escape(lastFramePath) + "\"}";
		}

		private static string Status()
		{
			return "{\"success\":true,\"running\":" + Bool(running)
				+ ",\"sessionId\":\"" + Escape(sessionId) + "\""
				+ ",\"width\":" + width
				+ ",\"height\":" + height
				+ ",\"fps\":" + fps
				+ ",\"quality\":" + quality
				+ ",\"sequence\":" + sequence
				+ ",\"lastFramePath\":\"" + Escape(lastFramePath) + "\""
				+ ",\"lastError\":\"" + Escape(lastError) + "\""
				+ ",\"inputSystemAvailable\":" + Bool(IsInputSystemAvailable())
				+ "}";
		}

		private static string Input(Args args, string argsJson)
		{
			string inputType = string.IsNullOrEmpty(args.inputType) ? "tap" : args.inputType;
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
			if (running == false)
			{
				return;
			}

			double now = EditorApplication.timeSinceStartup;
			if (now < nextFrameTime)
			{
				return;
			}

			nextFrameTime = now + (1.0 / Math.Max(1, fps));
			CaptureFrame();
		}

		private static void CaptureFrame()
		{
			Camera camera = Camera.main;
			if (camera == null && SceneView.lastActiveSceneView != null)
			{
				camera = SceneView.lastActiveSceneView.camera;
			}

			if (camera == null)
			{
				lastError = "No Camera.main or active SceneView camera is available.";
				return;
			}

			RenderTexture previousTarget = camera.targetTexture;
			RenderTexture previousActive = RenderTexture.active;
			RenderTexture rt = new RenderTexture(width, height, 24);
			Texture2D texture = new Texture2D(width, height, TextureFormat.RGB24, false);
			try
			{
				camera.targetTexture = rt;
				RenderTexture.active = rt;
				camera.Render();
				texture.ReadPixels(new Rect(0, 0, width, height), 0, 0);
				texture.Apply();

				sequence++;
				string framePath = Path.Combine(outputFolder, sessionId + "_" + sequence.ToString("D6") + ".jpg");
				File.WriteAllBytes(framePath, texture.EncodeToJPG(quality));
				lastFramePath = framePath;
				lastError = string.Empty;
				HotReloadHandler.BroadcastToClients("{\"command\":\"viewportFrame\",\"sessionId\":\"" + Escape(sessionId) + "\",\"path\":\"" + Escape(framePath) + "\",\"sequence\":" + sequence + ",\"width\":" + width + ",\"height\":" + height + ",\"timestamp\":\"" + Escape(DateTime.UtcNow.ToString("o")) + "\"}");
			}
			catch (Exception ex)
			{
				lastError = ex.Message;
			}
			finally
			{
				camera.targetTexture = previousTarget;
				RenderTexture.active = previousActive;
				UnityEngine.Object.DestroyImmediate(rt);
				UnityEngine.Object.DestroyImmediate(texture);
			}
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
			public int width;
			public int height;
			public int fps;
			public int quality;
			public string inputType;
			public float x;
			public float y;
			public float x2;
			public float y2;
			public string key;
			public string text;
			public int durationMs;
		}
	}
}

#endif
