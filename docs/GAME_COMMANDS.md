# Runtime Game Commands

Runtime game commands let a Unity project expose project-owned gameplay workflows to MCP agents without UI automation. The command lives in the game code, runs on Unity's main thread, and can wait across frames or network responses through a coroutine.

Compatibility status: the package declares Unity 2019.4 or later. Local proof
must name the exact Editor and platform. CoreCLR transition and Unity 7 coverage
are planned under the [roadmap](ROADMAP.md); do not
silently substitute a newer Editor when an exact project version is missing.

Use this for flows such as login steps, server selection, menu navigation, mission setup, debug-only content unlocks, or deterministic test setup that should follow the same internal handlers a player-triggered UI path uses.

## Unity Package Side

The UPM package provides `UnityCursorToolkit.AgentCommands` in the runtime assembly. No scene component is required. During play mode, the hidden command runner is created only when a command is scheduled.

Register commands from game code:

```csharp
using System.Collections;
using UnityEngine;
using UnityCursorToolkit.AgentCommands;

public static partial class ExampleAgentCommands
{
	private const string CommandName = "auth.select_us_east";

	#if UNITY_7000_0_OR_NEWER
	[Unity.Scripting.LifecycleManagement.OnCodeInitializing]
	#endif
	[RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
	private static void Register()
	{
		AgentCommandRegistry.Register(
			CommandName,
			"Selects the US East server through the game's server selection handler.",
			SelectUsEastServer);
	}

	#if UNITY_7000_0_OR_NEWER
	[Unity.Scripting.LifecycleManagement.OnCodeUnloading]
	private static void Unregister()
	{
		AgentCommandRegistry.Unregister(CommandName);
	}
	#endif

	private static IEnumerator SelectUsEastServer(AgentCommandContext context)
	{
		yield return null;

		// Call the same game subsystem methods the UI path calls.
		context.Succeed("Selected US East.");
	}
}
```

Registered commands require play mode because they run through a hidden `MonoBehaviour` coroutine runner on Unity's main thread.

## Consumer lifetime

A registration owns its handler until that name is unregistered or replaced. The owner should remove only its own registrations before its code unloads. Registration is idempotent for the same name, including Play Mode entry with domain reload disabled. Finish or cancel the owner's active runs before an intentional code reload; unregistering a name prevents future scheduling but does not cancel an existing run.

The runner retains terminal status and result data without retaining the completed handler delegate. Consumer handlers should return package result data rather than place consumer objects in external static caches.

CoreCLR can keep unmodified assemblies and their statics alive while replacing consumer code. References from those statics can prevent the old consumer assembly from unloading. See Unity's [CoreCLR upgrade guide](https://discussions.unity.com/t/path-to-coreclr-2026-upgrade-guide/1714279). Use owner lifecycle hooks rather than clearing the shared registry or another owner's subscriptions.

Editor consumers of `ILPatcher.OnPatchCompleted` must also detach their own callback. This example uses the existing Mono reload event and Unity 7 lifecycle attributes:

```csharp
#if UNITY_EDITOR
using UnityEditor;
using UnityCursorToolkit.HotReload;

public static partial class ProjectPatchObserver
{
#if UNITY_7000_0_OR_NEWER
    [Unity.Scripting.LifecycleManagement.OnCodeInitializing]
#else
    [InitializeOnLoadMethod]
#endif
    private static void Attach()
    {
        ILPatcher.OnPatchCompleted -= OnPatch;
        ILPatcher.OnPatchCompleted += OnPatch;
#if !UNITY_7000_0_OR_NEWER
        AssemblyReloadEvents.beforeAssemblyReload -= Detach;
        AssemblyReloadEvents.beforeAssemblyReload += Detach;
#endif
    }

#if UNITY_7000_0_OR_NEWER
    [Unity.Scripting.LifecycleManagement.OnCodeUnloading]
#endif
    private static void Detach()
    {
        ILPatcher.OnPatchCompleted -= OnPatch;
#if !UNITY_7000_0_OR_NEWER
        AssemblyReloadEvents.beforeAssemblyReload -= Detach;
#endif
    }

    private static void OnPatch(PatchResult result)
    {
        // Read result.Success before treating the patch as applied.
    }
}
#endif
```

On CoreCLR, IL patching is refused and the completion event still reports that refusal. The callback must inspect the result. Native source reload is a separate lifecycle path.

The [consumer proof](../experiments/consumer-lifecycle-proof/README.md) tests terminal target collection, owner-only unregistering and callback replacement. Its evidence records whether package statics were retained; ordinary static reconstruction does not prove selective reload retention.

## MCP Tool

The companion extension exposes the generic `game_command` MCP tool:

| Action | Purpose |
|---|---|
| `list` | Returns registered command names, descriptions, and play-mode requirements |
| `run` | Schedules a registered command and returns a `runId` |
| `status` | Reads the retained status for a `runId` |
| `cancel` | Stops a pending or running command coroutine |

Example agent flow:

```json
{ "action": "list" }
```

```json
{ "action": "run", "commandName": "auth.select_us_east", "args": {} }
```

```json
{ "action": "status", "runId": "auth_select_us_east_1_638840000000000000" }
```

The `commandName` field also accepts the alias `name`. The `runId` field also accepts the alias `id`.

## Editor Batchmode Host

Use `host: "editorBatchmode"` for command list/run calls that should execute in a fresh Unity batchmode process instead of the attached editor bridge. This is intended for non-rendering command discovery, CI smoke tests, and deterministic workflows that do not depend on an already-open Unity window.

```json
{ "action": "list", "host": "editorBatchmode" }
```

```json
{ "action": "run", "host": "editorBatchmode", "commandName": "auth.select_us_east", "args": {}, "timeoutMs": 120000 }
```

The MCP server launches Unity with `-batchmode -quit -executeMethod UnityCursorToolkit.AgentCommands.BatchCommandEntry.Run`. Pass `unityPath` or set `UNITY_CURSOR_TOOLKIT_UNITY_PATH` when Unity cannot be found from `ProjectSettings/ProjectVersion.txt`.

Batchmode commands return the planned Unity command, temp argument/result paths, Unity exit code, parsed result JSON when present, and the tail of the Unity log. Use normal editor-host commands for rendering, play-mode UI, or any flow that depends on an existing interactive editor session.

## Project Integration Checklist

1. Install the UPM package from GitHub, OpenUPM, or a scoped registry.
2. Add a reference to `UnityCursorToolkit.Runtime` in the game runtime assembly definition that owns command registrations.
3. Register commands with stable names and short descriptions.
4. Keep command handlers thin: find the active subsystem, call existing public game methods, wait for completion, then report `context.Succeed(...)` or `context.Fail(...)`.
5. Prefer deterministic names such as `auth.select_us_east`, `menu.open_missions`, or `mission.start_smoke_test`.
6. Keep commands behind development-only compilation when they should not ship in production builds.
7. For batchmode-safe commands, avoid renderer, scene view, editor window, and interactive input dependencies.

## WarInArms First Command

WarInArms uses `auth.select_us_east` as the first command sequence. It selects the US East server through the existing server selection handler, matching the environment used for active testing.

For branch testing before a tagged release, the package dependency can target a branch ref:

```json
"com.rankupgames.unity-cursor-toolkit": "https://github.com/rankupgames/unity-cursor-toolkit.git?path=Packages/com.rankupgames.unity-cursor-toolkit#codex/game-command-backend"
```

For released project manifests, prefer a tag ref or the default Git URL:

```json
"com.rankupgames.unity-cursor-toolkit": "https://github.com/rankupgames/unity-cursor-toolkit.git?path=Packages/com.rankupgames.unity-cursor-toolkit"
```
