using System;
using System.Collections;
using System.Diagnostics;
using System.IO;
using System.Runtime.CompilerServices;
using UnityCursorToolkit.AgentCommands;
using UnityCursorToolkit.HotReload;
using UnityEngine;

namespace UCT.Consumer
{
	public static partial class Owner
	{
		private const string Version = "v1";
		public const string Command = "proof.consumer.version";
		private static bool bound;

		[Unity.Scripting.LifecycleManagement.OnCodeInitializing]
		private static void Bind()
		{
			string root = Environment.GetEnvironmentVariable("UCT_CONSUMER_PROOF");
			if (string.IsNullOrEmpty(root) || !File.Exists(Path.Combine(root, "owner.pid")) || File.ReadAllText(Path.Combine(root, "owner.pid")) != Process.GetCurrentProcess().Id.ToString()) return;
			bound = true;
			AgentCommandRegistry.Register(Command, "Version " + Version, RunVersion);
			ILPatcher.OnPatchCompleted -= Patched;
			ILPatcher.OnPatchCompleted += Patched;
			Record("initializing", false);
		}

		[Unity.Scripting.LifecycleManagement.OnCodeUnloading]
		private static void Unbind()
		{
			if (!bound) return;
			bound = false;
			bool removed = AgentCommandRegistry.Unregister(Command);
			ILPatcher.OnPatchCompleted -= Patched;
			Record("unloading", removed);
		}

		private static IEnumerator RunVersion(AgentCommandContext context)
		{
			yield return null;
			context.Succeed(Version, "{\"version\":\"" + Version + "\"}");
		}
		private static void Patched(PatchResult result) { Record("patch", false); }
		private static void Record(string phase, bool removed)
		{
			string root = Environment.GetEnvironmentVariable("UCT_CONSUMER_PROOF");
			if (string.IsNullOrEmpty(root)) return;
			File.AppendAllText(Path.Combine(root, "events.ndjson"), JsonUtility.ToJson(new Event
			{ phase = phase, version = Version, removed = removed, pid = Process.GetCurrentProcess().Id }) + "\n");
		}
		[Serializable] private sealed class Event { public string phase, version; public bool removed; public int pid; }

		[MethodImpl(MethodImplOptions.NoInlining)]
		public static object[] BeginTransient(string mode)
		{
			var target = new TransientTarget(mode);
			var weak = new WeakReference(target);
			string name = "proof.transient." + mode;
			AgentCommandRegistry.Register(name, "Transient " + mode, target.Run);
			var run = AgentCommandRunner.Run(name, "{}");
			AgentCommandRegistry.Unregister(name);
			if (mode == "cancel") AgentCommandRunner.Cancel(run.RunId);
			return new object[] { weak, run.RunId };
		}
		private sealed class TransientTarget
		{
			private readonly string mode;
			internal TransientTarget(string value) { mode = value; }
			internal IEnumerator Run(AgentCommandContext context)
			{
				yield return null;
				if (mode == "failure") throw new InvalidOperationException("transient failure");
				if (mode == "cancel") { while (true) yield return null; }
				context.Succeed("transient success", "{\"marker\":\"success\"}");
			}
		}
	}
}
