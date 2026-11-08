using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.CompilerServices;
using System.Globalization;
using System.Text;
using UnityEngine;

namespace UCTDebugProbe
{
	internal static class ProbeTarget
	{
		[Serializable]
		private sealed class State
		{
			public int pid;
			public string version, coreLibrary, runtimeVersion, architecture, optimization, phase;
			public bool debuggerAttached;
			public int heartbeats, result;
		}
		private static string evidence;
		private static State state;
		private static Stopwatch lifetime;
		private static bool invoked;
		private static Action<int> quit;

		internal static void Initialize(string mode, string optimization, Action<int> normalQuit)
		{
			evidence = Environment.GetEnvironmentVariable("UCT_DEBUG_EVIDENCE");
			if (string.IsNullOrEmpty(evidence)) throw new InvalidOperationException("Missing UCT_DEBUG_EVIDENCE.");
			quit = normalQuit;
			lifetime = Stopwatch.StartNew();
			state = new State {
				pid = Process.GetCurrentProcess().Id, version = Application.unityVersion,
				coreLibrary = typeof(object).Assembly.FullName, runtimeVersion = Environment.Version.ToString(),
				architecture = System.Runtime.InteropServices.RuntimeInformation.ProcessArchitecture.ToString().ToLowerInvariant(),
				optimization = optimization, phase = mode + ":ready"
			};
			Write();
		}

		internal static void Tick()
		{
			if (state == null) return;
			if (File.Exists(evidence + ".stop") || lifetime.Elapsed.TotalSeconds > 90)
			{
				state.phase = "normalExit"; Write(); quit(0); return;
			}
			state.heartbeats++;
			if (!invoked && File.Exists(evidence + ".trigger"))
			{
				invoked = true;
				state.phase = "arithmetic";
				Write();
				state.result = Exercise();
				state.phase = "arithmeticComplete";
			}
			Write();
		}

		private static void Write()
		{
			state.debuggerAttached = Debugger.IsAttached;
			File.WriteAllText(evidence, "{\"pid\":" + state.pid.ToString(CultureInfo.InvariantCulture)
				+ ",\"version\":" + Quote(state.version) + ",\"coreLibrary\":" + Quote(state.coreLibrary)
				+ ",\"runtimeVersion\":" + Quote(state.runtimeVersion) + ",\"architecture\":" + Quote(state.architecture)
				+ ",\"optimization\":" + Quote(state.optimization) + ",\"phase\":" + Quote(state.phase)
				+ ",\"debuggerAttached\":" + (state.debuggerAttached ? "true" : "false")
				+ ",\"heartbeats\":" + state.heartbeats.ToString(CultureInfo.InvariantCulture)
				+ ",\"result\":" + state.result.ToString(CultureInfo.InvariantCulture) + "}");
		}

		internal static string Quote(string value)
		{
			if (value == null) return "null";
			var result = new StringBuilder("\"");
			foreach (var character in value)
			{
				if (character == '\\' || character == '"') result.Append('\\').Append(character);
				else if (character < 32) result.Append("\\u").Append(((int)character).ToString("x4", CultureInfo.InvariantCulture));
				else result.Append(character);
			}
			return result.Append('"').ToString();
		}

		[MethodImpl(MethodImplOptions.NoInlining | MethodImplOptions.NoOptimization)]
		private static int Exercise()
		{
			int seed = 7;
			int value = seed + 3; // PROBE_BREAKPOINT
			int doubled = value * 2; // PROBE_STEP_OVER
			int result = Add(doubled); // PROBE_STEP_IN
			return result; // PROBE_STEP_OUT
		}

		[MethodImpl(MethodImplOptions.NoInlining | MethodImplOptions.NoOptimization)]
		private static int Add(int input)
		{
			int offset = 5;
			return input + offset;
		}
	}

	internal sealed class PlayerProbe : MonoBehaviour
	{
		[RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
		private static void StartProbe()
		{
			ProbeTarget.Initialize("player", UnityEngine.Debug.isDebugBuild ? "Development" : "Release", Application.Quit);
			var owner = new GameObject("UCT owned debugger fixture");
			DontDestroyOnLoad(owner);
			owner.AddComponent<PlayerProbe>();
		}
		private void Update() { ProbeTarget.Tick(); }
	}
}
