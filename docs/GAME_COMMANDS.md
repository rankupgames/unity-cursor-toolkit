# Game Commands

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

public static class ExampleAgentCommands
{
	private const string CommandName = "auth.select_us_east";

	[RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
	private static void Register()
	{
		AgentCommandRegistry.Register(
			CommandName,
			"Selects the US East server through the game's server selection handler.",
			SelectUsEastServer);
	}

	private static IEnumerator SelectUsEastServer(AgentCommandContext context)
	{
		yield return null;

		// Call the same game subsystem methods the UI path calls.
		context.Succeed("Selected US East.");
	}
}
```

Commands without the `editor.` prefix require Play Mode. Names beginning with `editor.` use a synchronous Editor-only host and require idle Edit Mode. Their descriptors and run snapshots report `executionMode: "editorSynchronous"`; ordinary commands report `"play"`. Existing registration calls and MCP argument aliases are unchanged.

## Synchronous Editor Commands

Register authoring commands from an Editor assembly with `InitializeOnLoadMethod` or `InitializeOnLoad`. Keep the handler an `IEnumerator`, but finish it synchronously with `yield break`. Nested iterators may finish synchronously; yielding a frame, `YieldInstruction`, `AsyncOperation`, or waiting `CustomYieldInstruction` fails the run and disposes entered iterators. Compilation, Asset Database updates and Play transitions reject the call.

The Editor host creates no scene object and has no idle update callback. Discovery reports `requiresPlayMode: false` and `supportsBatchmode: true` for this prefix. A player rejects `editor.*` execution even if a registration was accidentally included in a build. Game-authored diagnostics should still be excluded from shipped builds.

## Cancellation and Lifetime

`AgentCommandRunner.SupportsDeterministicCancellation` and the catalog's `capabilities.deterministicCancellation` advertise the entered-iterator ownership contract. Use `try`/`finally` in handlers to release held input, virtual devices and other run-owned resources. The runner owns nested `IEnumerator` values and disposes them inside-out exactly once after completion, failure, cancellation, host disable/destruction, Play exit, or assembly reload. One throwing disposer does not prevent outer cleanup; it makes the final status `Failed` with `command_cleanup_failed`.

Runtime handlers retain Unity wait semantics, including nested/custom iterators and opaque Unity waits. A realtime 300-second deadline also bounds opaque waits while `timeScale` is zero. There are at most 16 active runs, 128 retained statuses, 128 nested iterators and 1,024 immediate advances per frame. The runtime component is disabled when no commands are active. No command is replayed after reload; its old run status is unavailable after that host is destroyed.

Cancellation executes on Unity's main thread. It cannot preempt a blocked `MoveNext` or a stopped Editor main thread. Independently started coroutines and resources outside entered handlers are not owned by this stack. The native lifecycle smoke validates the callback bodies; an actual domain reload and each game's input-device release remain separate live-flow checks.

## MCP Tool

The companion extension exposes the generic `game_command` MCP tool:

| Action | Purpose |
|---|---|
| `list` | Returns registered command names, descriptions, and play-mode requirements |
| `run` | Runs a synchronous Editor command or schedules a Play command and returns a `runId` |
| `status` | Reads the retained status for a `runId` |
| `cancel` | Releases entered handler scopes and stops a pending or running command |

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
{ "action": "run", "host": "editorBatchmode", "commandName": "editor.lab.export", "args": {}, "timeoutMs": 120000 }
```

A batchmode run requires a registered synchronous `editor.*` command; it does not enter Play Mode for runtime commands.

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
