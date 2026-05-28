# Runtime Game Commands

Runtime game commands let a Unity project expose project-owned gameplay workflows to MCP agents without UI automation. The command lives in the game code, runs on Unity's main thread, and can wait across frames or network responses through a coroutine.

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

Registered commands require play mode because they run through a hidden `MonoBehaviour` coroutine runner on Unity's main thread.

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

## Project Integration Checklist

1. Install the UPM package from GitHub, OpenUPM, or a scoped registry.
2. Add a reference to `UnityCursorToolkit.Runtime` in the game runtime assembly definition that owns command registrations.
3. Register commands with stable names and short descriptions.
4. Keep command handlers thin: find the active subsystem, call existing public game methods, wait for completion, then report `context.Succeed(...)` or `context.Fail(...)`.
5. Prefer deterministic names such as `auth.select_us_east`, `menu.open_missions`, or `mission.start_smoke_test`.
6. Keep commands behind development-only compilation when they should not ship in production builds.

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
