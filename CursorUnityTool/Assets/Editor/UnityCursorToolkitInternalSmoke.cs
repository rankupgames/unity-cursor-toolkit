using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using UnityCursorToolkit.AgentCommands;
using UnityEditor;
using UnityEngine;

namespace UnityCursorToolkit.InternalSmoke
{
	[InitializeOnLoad]
	internal static class UnityCursorToolkitInternalSmoke
	{
		private const string RunningKey = "UCT_INTERNAL_SMOKE_RUNNING";
		private const string PhaseKey = "UCT_INTERNAL_SMOKE_PHASE";
		private const string ResultPathKey = "UCT_INTERNAL_SMOKE_RESULT_PATH";
		private const string ViewportFramePathKey = "UCT_INTERNAL_SMOKE_VIEWPORT_FRAME_PATH";
		private const string LiveViewportStatusPathKey = "UCT_INTERNAL_LIVE_VIEWPORT_STATUS_PATH";
		private const string LiveViewportSessionIdKey = "UCT_INTERNAL_LIVE_VIEWPORT_SESSION_ID";
		private const string LiveViewportWidthKey = "UCT_INTERNAL_LIVE_VIEWPORT_WIDTH";
		private const string LiveViewportHeightKey = "UCT_INTERNAL_LIVE_VIEWPORT_HEIGHT";
		private const string LiveViewportFpsKey = "UCT_INTERNAL_LIVE_VIEWPORT_FPS";
		private const string LiveViewportQualityKey = "UCT_INTERNAL_LIVE_VIEWPORT_QUALITY";
		private const string StartedTicksKey = "UCT_INTERNAL_SMOKE_STARTED_TICKS";
		private const string SuccessRunIdKey = "UCT_INTERNAL_SMOKE_SUCCESS_RUN_ID";
		private const string FailureRunIdKey = "UCT_INTERNAL_SMOKE_FAILURE_RUN_ID";
		private const string AttemptsKey = "UCT_INTERNAL_SMOKE_ATTEMPTS";
		private const int TimeoutSeconds = 90;

		static UnityCursorToolkitInternalSmoke()
		{
			if (SessionState.GetBool(RunningKey, false))
			{
				HookUpdate();
			}
		}

		public static void Run()
		{
			ValidateRuntimeAndStateReset();
			ValidateBridgeReload();
			ValidateUntermIntegration();
			SessionState.SetBool(RunningKey, true);
			SessionState.SetString(PhaseKey, "enterPlay");
			SessionState.SetString(ResultPathKey, GetArg("-uctSmokeResultPath", "/tmp/uct-internal-smoke-result.json"));
			SessionState.SetString(ViewportFramePathKey, GetArg("-uctSmokeViewportFramePath", "/tmp/uct-internal-smoke-viewport.jpg"));
			SessionState.SetString(StartedTicksKey, DateTime.UtcNow.Ticks.ToString());
			SessionState.SetString(SuccessRunIdKey, string.Empty);
			SessionState.SetString(FailureRunIdKey, string.Empty);
			SessionState.SetInt(AttemptsKey, 0);
			HookUpdate();
		}

		private static void ValidateBridgeReload()
		{
			Type handler = typeof(UnityCursorToolkit.HotReloadHandler);
			const BindingFlags flags = BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic;
			MethodInfo before = handler.GetMethod("OnBeforeAssemblyReload", flags);
			MethodInfo after = handler.GetMethod("OnAfterAssemblyReload", flags);
			if (after == null) throw new InvalidOperationException("The bridge has no preserved-state reload restart hook.");
			MethodInfo start = handler.GetMethod("StartWithoutMutex", flags);
			FieldInfo currentPort = handler.GetField("currentPort", flags);
			FieldInfo lastPort = handler.GetField("lastSuccessfulPort", flags);
			FieldInfo initialized = handler.GetField("isInitialized", flags);
			FieldInfo restartIntent = handler.GetField("wasRunningBeforeReload", flags);
			int originalPort = (int)currentPort.GetValue(null);
			int originalLastPort = (int)lastPort.GetValue(null);
			bool originalInitialized = (bool)initialized.GetValue(null);
			bool originalRestartIntent = (bool)restartIntent.GetValue(null);
			bool originalRunning = UnityCursorToolkit.HotReloadHandler.IsServerRunning();
			string lastPortKey = (string)handler.GetField("lastPortPrefKey", flags).GetRawConstantValue();
			string runningKey = (string)handler.GetField("wasRunningPrefKey", flags).GetRawConstantValue();
			bool hadLastPort = EditorPrefs.HasKey(lastPortKey);
			bool hadRunning = EditorPrefs.HasKey(runningKey);
			int previousLastPort = EditorPrefs.GetInt(lastPortKey);
			bool previousRunning = EditorPrefs.GetBool(runningKey);
			try
			{
				// The owned proof must not depend on fixed ports excluded by the host OS.
				UnityCursorToolkit.HotReloadHandler.Stop();
				var probe = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Any, 0);
				int fixturePort;
				try
				{
					probe.Start();
					fixturePort = ((System.Net.IPEndPoint)probe.LocalEndpoint).Port;
				}
				finally { probe.Stop(); }
				currentPort.SetValue(null, fixturePort);
				lastPort.SetValue(null, fixturePort);
				start.Invoke(null, null);
				WaitForBridgeServer();
				before.Invoke(null, null);
				after.Invoke(null, null);
				WaitForBridgeServer();
				if (!(bool)initialized.GetValue(null))
					throw new InvalidOperationException("The bridge did not restart after a preserved-state reload.");

				UnityCursorToolkit.HotReloadHandler.Stop();
				before.Invoke(null, null);
				after.Invoke(null, null);
				if (UnityCursorToolkit.HotReloadHandler.IsServerRunning() || (bool)initialized.GetValue(null))
					throw new InvalidOperationException("Reload restarted a manually stopped bridge.");
			}
			finally
			{
				UnityCursorToolkit.HotReloadHandler.Stop();
				currentPort.SetValue(null, originalPort);
				lastPort.SetValue(null, originalLastPort);
				restartIntent.SetValue(null, originalRestartIntent);
				if (originalRunning)
				{
					start.Invoke(null, null);
					WaitForBridgeServer();
				}
				else initialized.SetValue(null, originalInitialized);
				if (hadLastPort) EditorPrefs.SetInt(lastPortKey, previousLastPort);
				else EditorPrefs.DeleteKey(lastPortKey);
				if (hadRunning) EditorPrefs.SetBool(runningKey, previousRunning);
				else EditorPrefs.DeleteKey(runningKey);
			}
		}

		private static void WaitForBridgeServer()
		{
			var timer = System.Diagnostics.Stopwatch.StartNew();
			while (!UnityCursorToolkit.HotReloadHandler.IsServerRunning() && timer.ElapsedMilliseconds < 5000)
				System.Threading.Thread.Sleep(10);
			if (!UnityCursorToolkit.HotReloadHandler.IsServerRunning())
				throw new InvalidOperationException("The bridge listener did not start during the owned reload smoke.");
			using (var client = new System.Net.Sockets.TcpClient())
			{
				client.ReceiveTimeout = 2000;
				client.SendTimeout = 2000;
				client.Connect(System.Net.IPAddress.Loopback, UnityCursorToolkit.HotReloadHandler.GetCurrentPort());
				byte[] ping = Encoding.UTF8.GetBytes("{\"command\":\"ping\"}\n");
				System.Net.Sockets.NetworkStream stream = client.GetStream();
				stream.Write(ping, 0, ping.Length);
				using (var reader = new StreamReader(stream))
				{
					if (reader.ReadLine() != "{\"command\":\"pong\"}")
						throw new InvalidOperationException("The bridge did not answer ping after the owned reload.");
				}
			}
		}

		// Exercise session cleanup twice without a domain reload, so stale static state is visible.
		private static void ValidateRuntimeAndStateReset()
		{
			string projectInfo = CallMcpTool("UnityCursorToolkit.MCP.ProjectInfoTool, UnityCursorToolkit.Editor", "{}");
			bool mono = typeof(object).Assembly.GetType("Mono.Runtime") != null;
			bool coreClr = !mono && typeof(object).Assembly.GetName().Name == "System.Private.CoreLib";
			AssertContains(projectInfo, "\"isCoreCLR\":" + (coreClr ? "true" : "false"));
			AssertContains(projectInfo, "\"hasDomainReload\":" + (mono ? "true" : "false"));

			Type enumerator = Type.GetType("UnityCursorToolkit.Core.AssemblyEnumerator, UnityCursorToolkit.Editor", true);
			bool toolkitFound = false;
			foreach (Assembly assembly in (IEnumerable)enumerator.GetMethod("GetLoaded", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static).Invoke(null, null))
			{
				toolkitFound |= assembly == enumerator.Assembly;
			}
			if (!toolkitFound) throw new InvalidOperationException("Assembly enumeration omitted the toolkit.");

			Type bridge = Type.GetType("UnityCursorToolkit.MCP.MCPBridge, UnityCursorToolkit.Editor", true);
			Type console = Type.GetType("UnityCursorToolkit.ConsoleToCursor, UnityCursorToolkit.Editor", true);
			Type profiler = Type.GetType("UnityCursorToolkit.ProfilerSessionRecorder, UnityCursorToolkit.Editor", true);
			const BindingFlags flags = BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic;
			bridge.GetMethod("Initialize", flags).Invoke(null, null);
			foreach (PlayModeStateChange state in new[] { PlayModeStateChange.EnteredPlayMode, PlayModeStateChange.EnteredEditMode })
			{
				IDictionary oldHandlers = (IDictionary)bridge.GetField("_handlers", flags).GetValue(null);
				bridge.GetMethod("OnPlayModeStateChanged", flags).Invoke(null, new object[] { state });
				IDictionary newHandlers = (IDictionary)bridge.GetField("_handlers", flags).GetValue(null);
				if (ReferenceEquals(oldHandlers, newHandlers) || newHandlers.Count == 0)
					throw new InvalidOperationException("MCP handlers were not rebuilt for the new session.");
				foreach (object key in oldHandlers.Keys)
				{
					if (!newHandlers.Contains(key) || ReferenceEquals(oldHandlers[key], newHandlers[key]))
						throw new InvalidOperationException("MCP retained a stale tool handler: " + key);
				}

				console.GetMethod("OnLogReceived", flags).Invoke(null, new object[] { "State reset smoke", "", LogType.Log });
				IList entries = (IList)console.GetField("entryBuffer", flags).GetValue(null);
				if (entries.Count == 0) throw new InvalidOperationException("Console smoke did not seed an entry.");
				console.GetMethod("OnPlayModeStateChanged", flags).Invoke(null, new object[] { state });
				if (entries.Count != 0) throw new InvalidOperationException("Console retained the previous session.");

				object timings = profiler.GetField("frameTimings", flags).GetValue(null);
				Type timingType = timings.GetType().GetGenericArguments()[0];
				timings.GetType().GetMethod("Enqueue").Invoke(timings, new[] { Activator.CreateInstance(timingType) });
				string oldSession = (string)profiler.GetField("sessionId", flags).GetValue(null);
				profiler.GetMethod("ResetSession", flags).Invoke(null, null);
				if (oldSession == (string)profiler.GetField("sessionId", flags).GetValue(null)
					|| (int)timings.GetType().GetProperty("Count").GetValue(timings) != 0)
					throw new InvalidOperationException("Profiler retained the previous session.");
			}
		}
		/// <summary>
		/// Proves menu registration, native API binding, editor text round-trip, and GPU rendering.
		/// </summary>
		private static void ValidateUntermIntegration()
		{
			Type menuItemsType = Type.GetType("Unterm.Editor.ToolkitMenuItems, UnityCursorToolkit.Vendor.Unterm.Editor", false);
			if (menuItemsType == null)
			{
				throw new InvalidOperationException("Vendored Unity-Unterm menu assembly was not loaded.");
			}

			string[] expectedMenuPaths =
			{
				"Tools/Unity Cursor Toolkit/Unterm/New Terminal",
				"Tools/Unity Cursor Toolkit/Unterm/Claude Code",
				"Tools/Unity Cursor Toolkit/Unterm/Code Editor",
				"Tools/Unity Cursor Toolkit/Unterm/Settings"
			};
			PropertyInfo menuItemProperty = typeof(MenuItem).GetProperty("menuItem", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
			FieldInfo menuItemField = typeof(MenuItem).GetField("menuItem", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
			if (menuItemProperty == null && menuItemField == null)
			{
				throw new InvalidOperationException("Unity MenuItem metadata is unavailable for integration validation.");
			}

			HashSet<string> registeredMenuPaths = new HashSet<string>();
			MethodInfo[] menuMethods = menuItemsType.GetMethods(BindingFlags.Static | BindingFlags.NonPublic);
			foreach (MethodInfo menuMethod in menuMethods)
			{
				object[] menuAttributes = menuMethod.GetCustomAttributes(typeof(MenuItem), false);
				foreach (object menuAttribute in menuAttributes)
				{
					string menuPath = menuItemProperty != null
						? menuItemProperty.GetValue(menuAttribute) as string
						: menuItemField.GetValue(menuAttribute) as string;
					if (!string.IsNullOrEmpty(menuPath))
					{
						registeredMenuPaths.Add(menuPath);
					}
				}
			}

			foreach (string expectedMenuPath in expectedMenuPaths)
			{
				if (!registeredMenuPaths.Contains(expectedMenuPath))
				{
					throw new InvalidOperationException("Missing Unity-Unterm toolkit menu alias: " + expectedMenuPath);
				}
			}

			Type windowType = menuItemsType.Assembly.GetType("Unterm.Editor.UntermWindow", true);
			Type nativeType = menuItemsType.Assembly.GetType("Unterm.Editor.UntermNative", true);
			windowType.GetMethod("EnsureNativeImageLoaded", BindingFlags.Static | BindingFlags.NonPublic).Invoke(null, null);
			string pluginPath = (string)windowType.GetProperty("PluginPath", BindingFlags.Static | BindingFlags.NonPublic).GetValue(null);
			using (IDisposable native = (IDisposable)Activator.CreateInstance(nativeType, true))
			{
				nativeType.GetMethod("Load").Invoke(native, new object[] { pluginPath });
				ulong editorId = (ulong)nativeType.GetMethod("EditorCreate").Invoke(native, new object[] { 256u, 128u, 1f });
				try
				{
					if (!(bool)nativeType.GetMethod("EditorExists").Invoke(native, new object[] { editorId }))
					{
						throw new InvalidOperationException("Unity-Unterm native editor was not created.");
					}
					const string text = "// Unity-Unterm runtime smoke\n";
					nativeType.GetMethod("EditorSetText").Invoke(native, new object[] { editorId, text });
					if ((string)nativeType.GetMethod("EditorText").Invoke(native, new object[] { editorId }) != text)
					{
						throw new InvalidOperationException("Unity-Unterm native editor text did not round-trip.");
					}
					nativeType.GetMethod("EditorRender").Invoke(native, new object[] { editorId });
					if ((IntPtr)nativeType.GetMethod("EditorRawTexture").Invoke(native, new object[] { editorId }) == IntPtr.Zero)
					{
						throw new InvalidOperationException("Unity-Unterm native editor did not render a GPU texture.");
					}
					Debug.Log("Unity-Unterm runtime smoke passed: native API, editor text, and GPU texture.");
				}
				finally
				{
					nativeType.GetMethod("EditorDestroy").Invoke(native, new object[] { editorId });
				}
			}
		}

		public static void StartViewportStream()
		{
			SessionState.SetBool(RunningKey, true);
			SessionState.SetString(PhaseKey, "liveEnterPlay");
			SessionState.SetString(ResultPathKey, GetArg("-uctLiveViewportResultPath", "/tmp/uct-live-viewport-result.json"));
			SessionState.SetString(LiveViewportStatusPathKey, GetArg("-uctLiveViewportStatusPath", "/tmp/uct-live-viewport-status.json"));
			SessionState.SetString(LiveViewportSessionIdKey, GetArg("-uctLiveViewportSessionId", "internal_live_view"));
			SessionState.SetInt(LiveViewportWidthKey, GetIntArg("-uctLiveViewportWidth", 640));
			SessionState.SetInt(LiveViewportHeightKey, GetIntArg("-uctLiveViewportHeight", 360));
			SessionState.SetInt(LiveViewportFpsKey, GetIntArg("-uctLiveViewportFps", 12));
			SessionState.SetInt(LiveViewportQualityKey, GetIntArg("-uctLiveViewportQuality", 70));
			SessionState.SetString(StartedTicksKey, DateTime.UtcNow.Ticks.ToString());
			SessionState.SetString(SuccessRunIdKey, string.Empty);
			SessionState.SetString(FailureRunIdKey, string.Empty);
			SessionState.SetInt(AttemptsKey, 0);
			HookUpdate();
		}

		private static void HookUpdate()
		{
			EditorApplication.update -= Tick;
			EditorApplication.update += Tick;
		}

		private static void Tick()
		{
			if (SessionState.GetBool(RunningKey, false) == false)
			{
				EditorApplication.update -= Tick;
				return;
			}

			try
			{
				bool livePhase = IsLivePhase();
				if (livePhase == false && IsTimedOut())
				{
					Finish(false, "Internal smoke timed out in phase " + SessionState.GetString(PhaseKey, string.Empty));
					return;
				}

				switch (SessionState.GetString(PhaseKey, "enterPlay"))
				{
					case "enterPlay":
						EnterPlayMode();
						break;
					case "liveEnterPlay":
						EnterLivePlayMode();
						break;
					case "waitPlay":
						if (EditorApplication.isPlaying)
						{
							SessionState.SetString(PhaseKey, "startCommands");
						}
						break;
					case "liveWaitPlay":
						if (EditorApplication.isPlaying)
						{
							SessionState.SetString(PhaseKey, "liveStartViewport");
						}
						break;
					case "startCommands":
						StartCommandTests();
						break;
					case "pollCommands":
						PollCommandTests();
						break;
					case "startViewport":
						StartViewportTests();
						break;
					case "pollViewport":
						PollViewportTests();
						break;
					case "liveStartViewport":
						StartLiveViewport();
						break;
					case "liveRunning":
						WriteLiveViewportStatus();
						break;
				}
			}
			catch (Exception ex)
			{
				if (IsLivePhase())
				{
					FinishLiveViewport(false, ex.GetType().Name + ": " + ex.Message);
				}
				else
				{
					Finish(false, ex.GetType().Name + ": " + ex.Message);
				}
			}
		}

		private static void EnterPlayMode()
		{
			if (EditorApplication.isPlaying)
			{
				SessionState.SetString(PhaseKey, "startCommands");
				return;
			}

			if (EditorApplication.isPlayingOrWillChangePlaymode == false)
			{
				SessionState.SetString(PhaseKey, "waitPlay");
				EditorApplication.EnterPlaymode();
			}
		}

		private static void EnterLivePlayMode()
		{
			if (EditorApplication.isPlaying)
			{
				SessionState.SetString(PhaseKey, "liveStartViewport");
				return;
			}

			if (EditorApplication.isPlayingOrWillChangePlaymode == false)
			{
				SessionState.SetString(PhaseKey, "liveWaitPlay");
				EditorApplication.EnterPlaymode();
			}
		}

		private static void StartCommandTests()
		{
			EnsureViewportScene();
			RegisterSmokeCommands();

			string catalog = CallMcpTool("UnityCursorToolkit.MCP.GameCommandTool, UnityCursorToolkit.Editor", "{\"action\":\"list\"}");
			AssertContains(catalog, "\"smoke.succeed\"");
			AssertContains(catalog, "\"viewport.tap\"");
			AssertContains(catalog, "\"supportedHosts\":[\"editor\",\"editorBatchmode\",\"player\",\"auto\"]");

			string unknown = CallMcpTool("UnityCursorToolkit.MCP.GameCommandTool, UnityCursorToolkit.Editor", "{\"action\":\"run\",\"commandName\":\"smoke.unknown\"}");
			AssertContains(unknown, "\"success\":false");
			AssertContains(unknown, "Unknown game command");

			string successRun = CallMcpTool("UnityCursorToolkit.MCP.GameCommandTool, UnityCursorToolkit.Editor", "{\"action\":\"run\",\"commandName\":\"smoke.succeed\",\"args\":{\"value\":42}}");
			string failureRun = CallMcpTool("UnityCursorToolkit.MCP.GameCommandTool, UnityCursorToolkit.Editor", "{\"action\":\"run\",\"commandName\":\"smoke.fail\"}");
			string waitRun = CallMcpTool("UnityCursorToolkit.MCP.GameCommandTool, UnityCursorToolkit.Editor", "{\"action\":\"run\",\"commandName\":\"smoke.wait\"}");

			string waitRunId = ExtractRunId(waitRun);
			string cancel = CallMcpTool("UnityCursorToolkit.MCP.GameCommandTool, UnityCursorToolkit.Editor", "{\"action\":\"cancel\",\"runId\":\"" + Escape(waitRunId) + "\"}");
			AssertContains(cancel, "\"status\":\"Canceled\"");

			SessionState.SetString(SuccessRunIdKey, ExtractRunId(successRun));
			SessionState.SetString(FailureRunIdKey, ExtractRunId(failureRun));
			SessionState.SetInt(AttemptsKey, 0);
			SessionState.SetString(PhaseKey, "pollCommands");
		}

		private static void PollCommandTests()
		{
			int attempts = SessionState.GetInt(AttemptsKey, 0) + 1;
			SessionState.SetInt(AttemptsKey, attempts);

			string successStatus = ReadCommandStatus(SessionState.GetString(SuccessRunIdKey, string.Empty));
			string failureStatus = ReadCommandStatus(SessionState.GetString(FailureRunIdKey, string.Empty));
			bool successDone = successStatus.Contains("\"status\":\"Succeeded\"");
			bool failureDone = failureStatus.Contains("\"status\":\"Failed\"") && failureStatus.Contains("expected smoke failure");

			if (successDone && failureDone)
			{
				SessionState.SetInt(AttemptsKey, 0);
				SessionState.SetString(PhaseKey, "startViewport");
				return;
			}

			if (attempts > 120)
			{
				Finish(false, "Command polling did not complete. success=" + successStatus + " failure=" + failureStatus);
			}
		}

		private static void StartViewportTests()
		{
			string start = CallMcpTool("UnityCursorToolkit.MCP.ViewportStreamTool, UnityCursorToolkit.Editor", "{\"action\":\"start\",\"sessionId\":\"internal_smoke_view\",\"view\":\"game\",\"captureMode\":\"camera\",\"width\":160,\"height\":90,\"fps\":5,\"quality\":40}");
			AssertContains(start, "\"success\":true");
			AssertContains(start, "\"sessionId\":\"internal_smoke_view\"");
			SessionState.SetInt(AttemptsKey, 0);
			SessionState.SetString(PhaseKey, "pollViewport");
		}

		private static void PollViewportTests()
		{
			int attempts = SessionState.GetInt(AttemptsKey, 0) + 1;
			SessionState.SetInt(AttemptsKey, attempts);
			string status = CallMcpTool("UnityCursorToolkit.MCP.ViewportStreamTool, UnityCursorToolkit.Editor", "{\"action\":\"status\"}");

			if (ExtractInt(status, "sequence") <= 0)
			{
				if (attempts > 120)
				{
					Finish(false, "Viewport did not produce a frame. status=" + status);
				}
				return;
			}

			string framePath = ExtractString(status, "lastFramePath");
			if (string.IsNullOrEmpty(framePath) || File.Exists(framePath) == false)
			{
				Finish(false, "Viewport reported a missing frame path. status=" + status);
				return;
			}

			PersistViewportFrame(framePath);

			AssertInput("tap", "{\"action\":\"input\",\"inputType\":\"tap\",\"x\":12,\"y\":20}");
			AssertInput("key", "{\"action\":\"input\",\"inputType\":\"key\",\"key\":\"Space\"}");
			AssertInput("swipe", "{\"action\":\"input\",\"inputType\":\"swipe\",\"x\":1,\"y\":2,\"x2\":30,\"y2\":40}");
			AssertInput("text", "{\"action\":\"input\",\"inputType\":\"text\",\"text\":\"abc\"}");

			string stop = CallMcpTool("UnityCursorToolkit.MCP.ViewportStreamTool, UnityCursorToolkit.Editor", "{\"action\":\"stop\"}");
			AssertContains(stop, "\"success\":true");
			Finish(true, "Internal smoke passed.");
		}

		private static void StartLiveViewport()
		{
			EnsureViewportScene();
			RegisterSmokeCommands();
			string start = CallMcpTool("UnityCursorToolkit.MCP.ViewportStreamTool, UnityCursorToolkit.Editor", BuildLiveViewportStartJson());
			AssertContains(start, "\"success\":true");
			WriteJsonFile(SessionState.GetString(ResultPathKey, "/tmp/uct-live-viewport-result.json"), "{\"success\":true,\"message\":\"Live viewport stream started.\",\"start\":" + start + "}");
			SessionState.SetString(PhaseKey, "liveRunning");
		}

		private static string BuildLiveViewportStartJson()
		{
			return "{\"action\":\"start\""
				+ ",\"sessionId\":\"" + Escape(SessionState.GetString(LiveViewportSessionIdKey, "internal_live_view")) + "\""
				+ ",\"width\":" + SessionState.GetInt(LiveViewportWidthKey, 640)
				+ ",\"height\":" + SessionState.GetInt(LiveViewportHeightKey, 360)
				+ ",\"fps\":" + SessionState.GetInt(LiveViewportFpsKey, 12)
				+ ",\"quality\":" + SessionState.GetInt(LiveViewportQualityKey, 70)
				+ "}";
		}

		private static void WriteLiveViewportStatus()
		{
			string status = CallMcpTool("UnityCursorToolkit.MCP.ViewportStreamTool, UnityCursorToolkit.Editor", "{\"action\":\"status\"}");
			WriteJsonFile(SessionState.GetString(LiveViewportStatusPathKey, "/tmp/uct-live-viewport-status.json"), status);
		}

		private static void AssertInput(string inputType, string argsJson)
		{
			string result = CallMcpTool("UnityCursorToolkit.MCP.ViewportStreamTool, UnityCursorToolkit.Editor", argsJson);
			AssertContains(result, "\"success\":true");
			AssertContains(result, "\"layer\":\"projectAdapter\"");
			AssertContains(result, "viewport." + inputType);
		}

		private static string ReadCommandStatus(string runId)
		{
			return CallMcpTool("UnityCursorToolkit.MCP.GameCommandTool, UnityCursorToolkit.Editor", "{\"action\":\"status\",\"runId\":\"" + Escape(runId) + "\"}");
		}

		private static void RegisterSmokeCommands()
		{
			AgentCommandRegistry.Register("smoke.succeed", "Internal smoke command that succeeds after a frame.", SmokeSucceed);
			AgentCommandRegistry.Register("smoke.fail", "Internal smoke command that fails after a frame.", SmokeFail);
			AgentCommandRegistry.Register("smoke.wait", "Internal smoke command used to verify cancellation.", SmokeWait);
			AgentCommandRegistry.Register("viewport.tap", "Internal viewport tap adapter.", ViewportInput);
			AgentCommandRegistry.Register("viewport.key", "Internal viewport key adapter.", ViewportInput);
			AgentCommandRegistry.Register("viewport.swipe", "Internal viewport swipe adapter.", ViewportInput);
			AgentCommandRegistry.Register("viewport.text", "Internal viewport text adapter.", ViewportInput);
		}

		private static void CleanupSmokeCommands()
		{
			AgentCommandRegistry.Unregister("smoke.succeed");
			AgentCommandRegistry.Unregister("smoke.fail");
			AgentCommandRegistry.Unregister("smoke.wait");
			AgentCommandRegistry.Unregister("viewport.tap");
			AgentCommandRegistry.Unregister("viewport.key");
			AgentCommandRegistry.Unregister("viewport.swipe");
			AgentCommandRegistry.Unregister("viewport.text");
		}

		private static IEnumerator SmokeSucceed(AgentCommandContext context)
		{
			yield return null;
			context.Succeed("smoke.succeed completed", "{\"received\":" + context.ArgsJson + "}");
		}

		private static IEnumerator SmokeFail(AgentCommandContext context)
		{
			yield return null;
			context.Fail("expected smoke failure");
		}

		private static IEnumerator SmokeWait(AgentCommandContext context)
		{
			for (int i = 0; i < 180; i++)
			{
				yield return null;
			}
			context.Succeed("smoke.wait completed");
		}

		private static IEnumerator ViewportInput(AgentCommandContext context)
		{
			context.Succeed("viewport adapter " + context.CommandName, "{\"command\":\"" + Escape(context.CommandName) + "\",\"args\":" + context.ArgsJson + "}");
			yield break;
		}

		private static void EnsureViewportScene()
		{
			Camera camera = Camera.main;
			if (camera == null)
			{
				GameObject cameraObject = new GameObject("UCT Internal Smoke Camera");
				cameraObject.tag = "MainCamera";
				camera = cameraObject.AddComponent<Camera>();
			}

			camera.clearFlags = CameraClearFlags.SolidColor;
			camera.backgroundColor = new Color(0.05f, 0.08f, 0.13f);
			camera.fieldOfView = 55f;
			camera.transform.position = new Vector3(0, 1.25f, -5f);
			camera.transform.LookAt(new Vector3(0f, 0.45f, 0f));

			EnsureLight();
			EnsurePrimitive("UCT Smoke Viewport Cube", PrimitiveType.Cube, new Vector3(-0.65f, 0.75f, 0f), new Vector3(1.1f, 1.1f, 1.1f), new Color(0.1f, 0.55f, 1f));
			EnsurePrimitive("UCT Smoke Viewport Sphere", PrimitiveType.Sphere, new Vector3(0.95f, 0.55f, 0.35f), new Vector3(0.75f, 0.75f, 0.75f), new Color(1f, 0.35f, 0.18f));
			EnsurePrimitive("UCT Smoke Viewport Floor", PrimitiveType.Cube, new Vector3(0f, -0.08f, 0.2f), new Vector3(4f, 0.15f, 2.5f), new Color(0.22f, 0.24f, 0.27f));
		}

		private static void EnsureLight()
		{
			GameObject lightObject = GameObject.Find("UCT Smoke Key Light");
			Light light = lightObject != null ? lightObject.GetComponent<Light>() : null;
			if (light == null)
			{
				lightObject = new GameObject("UCT Smoke Key Light");
				light = lightObject.AddComponent<Light>();
			}

			light.type = LightType.Directional;
			light.intensity = 1.6f;
			lightObject.transform.rotation = Quaternion.Euler(45f, -35f, 0f);
		}

		private static void EnsurePrimitive(string name, PrimitiveType type, Vector3 position, Vector3 scale, Color color)
		{
			GameObject obj = GameObject.Find(name);
			if (obj == null)
			{
				obj = GameObject.CreatePrimitive(type);
				obj.name = name;
			}

			obj.transform.position = position;
			obj.transform.localScale = scale;
			Renderer renderer = obj.GetComponent<Renderer>();
			if (renderer != null)
			{
				Material material = CreateMaterial(color);
				if (material != null)
				{
					renderer.sharedMaterial = material;
				}
			}
		}

		private static Material CreateMaterial(Color color)
		{
			Shader shader = Shader.Find("Universal Render Pipeline/Lit");
			if (shader == null)
			{
				shader = Shader.Find("Standard");
			}

			if (shader == null)
			{
				return null;
			}

			Material material = new Material(shader);
			if (material.HasProperty("_BaseColor"))
			{
				material.SetColor("_BaseColor", color);
			}

			if (material.HasProperty("_Color"))
			{
				material.SetColor("_Color", color);
			}

			return material;
		}

		private static void PersistViewportFrame(string framePath)
		{
			string artifactPath = SessionState.GetString(ViewportFramePathKey, string.Empty);
			if (string.IsNullOrEmpty(artifactPath))
			{
				return;
			}

			string directory = Path.GetDirectoryName(artifactPath);
			if (string.IsNullOrEmpty(directory) == false)
			{
				Directory.CreateDirectory(directory);
			}

			File.Copy(framePath, artifactPath, true);
			long bytes = new FileInfo(artifactPath).Length;
			if (bytes <= 0)
			{
				throw new InvalidOperationException("Persisted viewport frame is empty: " + artifactPath);
			}

			AssertViewportFrameHasVisiblePixels(artifactPath);
		}

		private static void AssertViewportFrameHasVisiblePixels(string artifactPath)
		{
			Texture2D texture = new Texture2D(2, 2, TextureFormat.RGB24, false);
			try
			{
				if (texture.LoadImage(File.ReadAllBytes(artifactPath)) == false)
				{
					throw new InvalidOperationException("Persisted viewport frame is not a readable image: " + artifactPath);
				}

				Color32[] pixels = texture.GetPixels32();
				if (pixels.Length == 0)
				{
					throw new InvalidOperationException("Persisted viewport frame has no pixels: " + artifactPath);
				}

				int minLuminance = 255;
				int maxLuminance = 0;
				long channelTotal = 0;
				foreach (Color32 pixel in pixels)
				{
					int luminance = (pixel.r * 2126 + pixel.g * 7152 + pixel.b * 722) / 10000;
					minLuminance = Math.Min(minLuminance, luminance);
					maxLuminance = Math.Max(maxLuminance, luminance);
					channelTotal += pixel.r + pixel.g + pixel.b;
				}

				if (channelTotal == 0 || maxLuminance - minLuminance < 8)
				{
					throw new InvalidOperationException("Persisted viewport frame does not contain visible contrast: " + artifactPath);
				}
			}
			finally
			{
				UnityEngine.Object.DestroyImmediate(texture);
			}
		}

		private static string CallMcpTool(string typeName, string argsJson)
		{
			Type type = Type.GetType(typeName, true);
			object tool = Activator.CreateInstance(type, true);
			MethodInfo handle = type.GetMethod("HandleCommand", BindingFlags.Public | BindingFlags.Instance);
			if (handle == null)
			{
				throw new InvalidOperationException("Missing HandleCommand on " + typeName);
			}

			return (string)handle.Invoke(tool, new object[] { argsJson });
		}

		private static string ExtractRunId(string json)
		{
			string runId = ExtractString(json, "runId");
			if (string.IsNullOrEmpty(runId))
			{
				throw new InvalidOperationException("Missing runId in " + json);
			}
			return runId;
		}

		private static string ExtractString(string json, string propertyName)
		{
			Match match = Regex.Match(json, "\"" + Regex.Escape(propertyName) + "\":\"([^\"]*)\"");
			return match.Success ? match.Groups[1].Value : string.Empty;
		}

		private static int ExtractInt(string json, string propertyName)
		{
			Match match = Regex.Match(json, "\"" + Regex.Escape(propertyName) + "\":(-?\\d+)");
			if (match.Success == false)
			{
				return 0;
			}

			int value;
			return int.TryParse(match.Groups[1].Value, out value) ? value : 0;
		}

		private static void AssertContains(string actual, string expected)
		{
			if (actual == null || actual.Contains(expected) == false)
			{
				throw new InvalidOperationException("Expected JSON to contain " + expected + " but got " + actual);
			}
		}

		private static bool IsTimedOut()
		{
			long ticks;
			if (long.TryParse(SessionState.GetString(StartedTicksKey, string.Empty), out ticks) == false)
			{
				return false;
			}

			return (DateTime.UtcNow - new DateTime(ticks, DateTimeKind.Utc)).TotalSeconds > TimeoutSeconds;
		}

		private static void Finish(bool success, string message)
		{
			try
			{
				CallMcpTool("UnityCursorToolkit.MCP.ViewportStreamTool, UnityCursorToolkit.Editor", "{\"action\":\"stop\"}");
			}
			catch
			{
				// Best-effort cleanup; the result below is the authoritative smoke outcome.
			}

			CleanupSmokeCommands();
			EditorApplication.update -= Tick;
			string resultPath = SessionState.GetString(ResultPathKey, "/tmp/uct-internal-smoke-result.json");
			string viewportFramePath = SessionState.GetString(ViewportFramePathKey, string.Empty);
			long viewportFrameBytes = string.IsNullOrEmpty(viewportFramePath) || File.Exists(viewportFramePath) == false ? 0 : new FileInfo(viewportFramePath).Length;
			ClearSession();
			string json = "{\"success\":" + (success ? "true" : "false") + ",\"message\":\"" + Escape(message) + "\""
				+ ",\"viewportFramePath\":\"" + Escape(viewportFramePath) + "\""
				+ ",\"viewportFrameBytes\":" + viewportFrameBytes + "}";
			Directory.CreateDirectory(Path.GetDirectoryName(resultPath));
			File.WriteAllText(resultPath, json);
			EditorApplication.Exit(success ? 0 : 1);
		}

		private static void FinishLiveViewport(bool success, string message)
		{
			try
			{
				CallMcpTool("UnityCursorToolkit.MCP.ViewportStreamTool, UnityCursorToolkit.Editor", "{\"action\":\"stop\"}");
			}
			catch
			{
				// Best-effort cleanup; process exit will release the remaining stream state.
			}

			CleanupSmokeCommands();
			EditorApplication.update -= Tick;
			string resultPath = SessionState.GetString(ResultPathKey, "/tmp/uct-live-viewport-result.json");
			string statusPath = SessionState.GetString(LiveViewportStatusPathKey, "/tmp/uct-live-viewport-status.json");
			ClearSession();
			WriteJsonFile(resultPath, "{\"success\":" + (success ? "true" : "false")
				+ ",\"message\":\"" + Escape(message) + "\""
				+ ",\"statusPath\":\"" + Escape(statusPath) + "\"}");
			EditorApplication.Exit(success ? 0 : 1);
		}

		private static void WriteJsonFile(string path, string json)
		{
			string directory = Path.GetDirectoryName(path);
			if (string.IsNullOrEmpty(directory) == false)
			{
				Directory.CreateDirectory(directory);
			}

			File.WriteAllText(path, json);
		}

		private static void ClearSession()
		{
			SessionState.EraseBool(RunningKey);
			SessionState.EraseString(PhaseKey);
			SessionState.EraseString(ResultPathKey);
			SessionState.EraseString(ViewportFramePathKey);
			SessionState.EraseString(LiveViewportStatusPathKey);
			SessionState.EraseString(LiveViewportSessionIdKey);
			SessionState.EraseInt(LiveViewportWidthKey);
			SessionState.EraseInt(LiveViewportHeightKey);
			SessionState.EraseInt(LiveViewportFpsKey);
			SessionState.EraseInt(LiveViewportQualityKey);
			SessionState.EraseString(StartedTicksKey);
			SessionState.EraseString(SuccessRunIdKey);
			SessionState.EraseString(FailureRunIdKey);
			SessionState.EraseInt(AttemptsKey);
		}

		private static string GetArg(string key, string fallback)
		{
			string[] args = Environment.GetCommandLineArgs();
			for (int i = 0; i < args.Length - 1; i++)
			{
				if (args[i] == key)
				{
					return args[i + 1];
				}
			}
			return fallback;
		}

		private static int GetIntArg(string key, int fallback)
		{
			string value = GetArg(key, string.Empty);
			int parsed;
			return int.TryParse(value, out parsed) ? parsed : fallback;
		}

		private static bool IsLivePhase()
		{
			return SessionState.GetString(PhaseKey, string.Empty).StartsWith("live", StringComparison.Ordinal);
		}

		private static string Escape(string value)
		{
			if (string.IsNullOrEmpty(value))
			{
				return string.Empty;
			}

			StringBuilder builder = new StringBuilder(value.Length + 8);
			foreach (char c in value)
			{
				switch (c)
				{
					case '\\':
						builder.Append("\\\\");
						break;
					case '"':
						builder.Append("\\\"");
						break;
					case '\n':
						builder.Append("\\n");
						break;
					case '\r':
						builder.Append("\\r");
						break;
					case '\t':
						builder.Append("\\t");
						break;
					default:
						builder.Append(c);
						break;
				}
			}
			return builder.ToString();
		}
	}
}
