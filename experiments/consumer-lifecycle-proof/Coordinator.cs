using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityCursorToolkit.AgentCommands;
using UnityCursorToolkit.Core;
using UnityCursorToolkit.HotReload;
using UnityEngine;

namespace UCT.ConsumerProof
{
	[InitializeOnLoad]
	public static partial class Coordinator
	{
		private const string Key = "UCT.ConsumerProof.State", Unrelated = "proof.coordinator.unrelated";
		private static readonly string Generation = Guid.NewGuid().ToString("N");
		private static string root;
		private static State state;
		private static WeakReference[] targets;
		private static int collections;
		private static bool attached;
		static Coordinator() { }

		[Unity.Scripting.LifecycleManagement.OnCodeInitializing]
		private static void Initialize()
		{
			if (attached) return;
			root = Environment.GetEnvironmentVariable("UCT_CONSUMER_PROOF");
			if (string.IsNullOrEmpty(root) || !File.Exists(Path.Combine(root, "owner.pid")) || File.ReadAllText(Path.Combine(root, "owner.pid")) != Process.GetCurrentProcess().Id.ToString()) return;
			string saved = SessionState.GetString(Key, "");
			if (!string.IsNullOrEmpty(saved)) state = JsonUtility.FromJson<State>(saved);
			AgentCommandRegistry.Register(Unrelated, "Unrelated coordinator", UnrelatedHandler);
			EditorApplication.update += Update;
			EditorApplication.quitting += Quitting;
			attached = true;
		}
		[Unity.Scripting.LifecycleManagement.OnCodeUnloading]
		private static void Unload()
		{
			if (!attached) return;
			EditorApplication.update -= Update;
			EditorApplication.quitting -= Quitting;
			AgentCommandRegistry.Unregister(Unrelated);
			attached = false;
		}
		public static void Run()
		{
			Initialize();
			Check(Application.unityVersion == "7000.0.0a7" && typeof(object).Assembly.GetName().Name == "System.Private.CoreLib", "Exact CoreCLR Editor required.");
			state = new State { variant = Environment.GetEnvironmentVariable("UCT_CONSUMER_VARIANT"), phase = "enter",
				editorVersion = Application.unityVersion, pid = Process.GetCurrentProcess().Id,
				deadline = DateTime.UtcNow.AddSeconds(150).Ticks,
				originalOptions = (int)EditorSettings.enterPlayModeOptions, originalEnabled = EditorSettings.enterPlayModeOptionsEnabled };
			EditorSettings.enterPlayModeOptionsEnabled = true;
			EditorSettings.enterPlayModeOptions = EnterPlayModeOptions.DisableDomainReload;
			var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
			Check(EditorSceneManager.SaveScene(scene, "Assets/ConsumerProof.unity"), "Fixture scene save failed.");
			state.beforePlay = Identity();
			Save();
			File.WriteAllText(Path.Combine(root, "ready.json"), JsonUtility.ToJson(state));
			EditorApplication.isPlaying = true;
		}
		private static void Update()
		{
			if (state == null) return;
			try
			{
				if (File.Exists(Path.Combine(root, "quit.request"))) Finish("Owned shutdown requested.");
				if (state.phase == "exit")
				{
					if (EditorApplication.isPlaying) { EditorApplication.isPlaying = false; return; }
					EditorSettings.enterPlayModeOptions = (EnterPlayModeOptions)state.originalOptions;
					EditorSettings.enterPlayModeOptionsEnabled = state.originalEnabled;
					File.WriteAllText(Path.Combine(root, "observation.json"), JsonUtility.ToJson(state, true));
					EditorApplication.Exit(0); return;
				}
				Check(DateTime.UtcNow.Ticks < state.deadline, "Fixture execution exceeded 150 seconds.");
				if (EditorApplication.isCompiling || EditorApplication.isUpdating) return;
				if (state.phase == "enter")
				{
					if (!Application.isPlaying) return;
					Check(HasCommand(Unrelated), "Unrelated registration was lost across disabled-domain-reload play entry.");
					state.afterPlay = Identity();
					targets = new WeakReference[3];
					string[] modes = { "success", "failure", "cancel" };
					for (int i = 0; i < modes.Length; i++)
					{
						object[] result = BeginTransient(modes[i]);
						targets[i] = (WeakReference)result[0];
						state.cases.Add(new Case { mode = modes[i], runId = (string)result[1] });
					}
					state.phase = "collect"; state.collectAfter = DateTime.UtcNow.AddSeconds(1).Ticks; Save(); return;
				}
				if (state.phase == "collect")
				{
					foreach (var item in state.cases)
					{
						var snapshot = AgentCommandRunner.GetStatus(item.runId);
						if (snapshot.Status == AgentCommandStatus.Running || snapshot.Status == AgentCommandStatus.Pending) return;
						Check(snapshot.Status == (item.mode == "success" ? AgentCommandStatus.Succeeded : item.mode == "failure" ? AgentCommandStatus.Failed : AgentCommandStatus.Canceled), "Unexpected transient status.");
						if (item.snapshot == null) item.snapshot = snapshot.ToJson();
						Check(snapshot.ToJson() == item.snapshot, "Retained status changed.");
					}
					if (DateTime.UtcNow.Ticks < state.collectAfter) return;
					GC.Collect(); GC.WaitForPendingFinalizers(); GC.Collect(); collections++;
					for (int i = 0; i < targets.Length; i++) state.cases[i].collected = !targets[i].IsAlive;
					if (collections < 30 && (state.variant == "baseline" || state.cases.Any(item => !item.collected))) return;
					state.terminalHandlersCollected = state.cases.All(item => item.collected);
					targets = null;
					if (state.variant == "baseline") { Finish(null); return; }
					Check(state.terminalHandlersCollected, "Terminal handler targets remain rooted after unregister and collection.");
					StartOwner("v1"); return;
				}
				if (state.phase.StartsWith("owner_"))
				{
					string version = state.phase.Substring(6);
					var snapshot = AgentCommandRunner.GetStatus(state.ownerRun);
					if (snapshot.Status == AgentCommandStatus.Running || snapshot.Status == AgentCommandStatus.Pending) return;
					Check(snapshot.Status == AgentCommandStatus.Succeeded && snapshot.Result.Message == version && snapshot.Result.DataJson == "{\"version\":\"" + version + "\"}", "Owner command did not execute the current consumer.");
					File.AppendAllText(Path.Combine(root, "events.ndjson"), "{\"phase\":\"patch_request\",\"version\":\"" + version + "\"}\n");
					var patch = ILPatcher.TryPatch(new string[0]);
					Check(!patch.Success && patch.ErrorCode == PatchErrorCode.CapabilityUnavailable, "CoreCLR IL guard did not refuse.");
					if (version == "v3") { state.passed = true; Finish(null); return; }
					int next = version == "v1" ? 2 : 3;
					state.reloads.Add(new Reload { expected = "v" + next, before = Identity() });
					state.phase = "await_v" + next; Save();
					File.WriteAllText(Path.Combine(root, "reload.request"), next.ToString()); return;
				}
				if (state.phase.StartsWith("await_"))
				{
					string refresh = Path.Combine(root, "refresh.request");
					if (File.Exists(refresh)) { File.Delete(refresh); AssetDatabase.Refresh(); return; }
					string version = state.phase.Substring(6);
					AgentCommandDescriptor descriptor; AgentCommandHandler handler;
					if (!AgentCommandRegistry.TryGet("proof.consumer.version", out descriptor, out handler) || descriptor.Description != "Version " + version) return;
					var reload = state.reloads[state.reloads.Count - 1];
					reload.after = Identity();
					reload.retained = reload.before.generation == reload.after.generation && reload.before.registry == reload.after.registry
						&& reload.before.runtimeMvid == reload.after.runtimeMvid && reload.before.editorMvid == reload.after.editorMvid;
					StartOwner(version);
				}
			}
			catch (Exception error) { Finish(error.Message); }
		}
		[MethodImpl(MethodImplOptions.NoInlining)]
		private static object[] BeginTransient(string mode)
		{
			return (object[])ConsumerType().GetMethod("BeginTransient").Invoke(null, new object[] { mode });
		}
		private static Type ConsumerType()
		{
			return UnityEngine.Assemblies.CurrentAssemblies.GetLoadedAssemblies().Single(assembly => assembly.GetName().Name == "UCT.Proof.Consumer").GetType("UCT.Consumer.Owner", true);
		}
		private static bool HasCommand(string name) { return AgentCommandRegistry.GetCommands().Any(command => command.Name == name); }
		private static IEnumerator UnrelatedHandler(AgentCommandContext context) { context.Succeed("unrelated"); yield break; }
		private static void StartOwner(string version) { state.ownerRun = AgentCommandRunner.Run("proof.consumer.version", "{}").RunId; state.phase = "owner_" + version; Save(); }
		private static IdentityData Identity()
		{
			return new IdentityData { generation = Generation, registry = RuntimeHelpers.GetHashCode(typeof(AgentCommandRegistry).GetField("registrations", BindingFlags.Static | BindingFlags.NonPublic).GetValue(null)),
				runtimeMvid = typeof(AgentCommandRegistry).Module.ModuleVersionId.ToString(), editorMvid = typeof(ILPatcher).Module.ModuleVersionId.ToString(),
				coordinatorMvid = typeof(Coordinator).Module.ModuleVersionId.ToString(), consumerMvid = ConsumerType().Module.ModuleVersionId.ToString() };
		}
		private static void Finish(string failure) { if (failure != null) { state.failure = failure; state.passed = false; } state.phase = "exit"; Save(); }
		private static void Save() { if (state != null) SessionState.SetString(Key, JsonUtility.ToJson(state)); }
		private static void Quitting() { File.WriteAllText(Path.Combine(root, "quitting"), "normal quit"); }
		private static void Check(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
		[Serializable] private sealed class State
		{
			public string variant, phase, editorVersion, failure, ownerRun;
			public int pid, originalOptions;
			public long deadline, collectAfter;
			public bool originalEnabled, terminalHandlersCollected, passed;
			public IdentityData beforePlay, afterPlay;
			public List<Case> cases = new List<Case>();
			public List<Reload> reloads = new List<Reload>();
		}
		[Serializable] private sealed class Case { public string mode, runId, snapshot; public bool collected; }
		[Serializable] private sealed class Reload { public string expected; public IdentityData before, after; public bool retained; }
		[Serializable] private sealed class IdentityData { public string generation, runtimeMvid, editorMvid, coordinatorMvid, consumerMvid; public int registry; }
	}
}
