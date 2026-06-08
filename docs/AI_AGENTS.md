# AI Agent Guide

Unity Cursor Toolkit is designed to give agents direct Unity Editor context without requiring users to paste console logs, scene state, or `.meta` files manually.

## What Agents Can Do

- Read recent Unity console output with `read_console`.
- Capture current console/profiler context with `profiler_snapshot`.
- Read compact whole-console session transcripts with `profiler_snapshot` using `action: "readConsoleTranscript"` after capturing or listing a session id.
- Build and query a compact Unity project context graph with `unity_context`.
- Inspect project state with `project_info`.
- Inspect active scene hierarchy with `manage_scene` and `action: "getHierarchy"`.
- Resolve Unity `.meta` files with `resolve_meta`.
- Discover and schedule game-authored runtime workflows with `game_command`.
- Start a local Unity viewport MJPEG stream with `viewport_stream` when a graphics-capable Editor or player host is available.
- Control play mode, capture screenshots, execute menu items, manage assets, edit GameObjects/components, and trigger builds when allowed.

## Safe Default Workflow

1. Call `project_info`.
2. Call `read_console` with `level: "error"` and then without a level filter.
3. Call `profiler_snapshot` with `action: "current"` when investigating performance, hitches, GC allocations, frame timing, or console event timelines.
4. When the compact grouped console timeline is needed, call `profiler_snapshot` with `action: "readConsoleTranscript"` and the captured session id.
5. Call `unity_context` with `action: "scan"` when `.umetacontext/index.json` is missing or stale, then use `query`, `read`, or `summary` instead of broad file reads.
6. Call `manage_scene` with `action: "getHierarchy"` before any scene edit.
7. Call `game_command` with `action: "list"` before scheduling a project-owned command.
8. Use `dryRun: true` for the first mutating call.
9. Execute the real mutating call only after the user has approved the intended change.

## Safety Controls

- Set `UNITY_CURSOR_TOOLKIT_MCP_READ_ONLY=1` to block mutating MCP tool calls.
- Pass `dryRun: true` to mutating Unity tools to return the normalized command without sending it to Unity.
- `resolve_meta` rejects absolute paths and traversal outside the Unity project root.
- Tools include MCP annotations such as `readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint` so clients can expose safer approval UX.
- `profiler_snapshot` read actions are allowed in read-only mode, including `readConsoleTranscript`. Saving or clearing retained profiler sessions is treated as mutating.
- `game_command` read actions are `list` and `status`; scheduling and cancellation are mutating because they execute or stop game code.
- `unity_context` `scan` is mutating because it writes `.umetacontext/index.json`; `query`, `read`, and `summary` are read-only.
- `viewport_stream` `status` is read-only; `start`, `stop`, and `input` are mutating host interactions.

## Unity Context Graph

Use `unity_context` to avoid repeatedly fetching broad Unity folders. The `scan` action indexes `Assets/`, `Packages/`, and `ProjectSettings/`, including `.meta` GUIDs, UnityYAML scene/prefab/object anchors, component ownership, script GUIDs, and dependency edges. It writes the tracked artifact `.umetacontext/index.json` at the Unity project root.

The scanner is intentionally conservative. Text UnityYAML assets receive object/component coverage; binary or unparseable assets receive path and `.meta` GUID coverage only.

## Runtime Game Commands

Use `game_command` when the Unity project has registered workflows through `UnityCursorToolkit.AgentCommands`. Commands run in play mode on Unity's main thread and should call the game's existing public subsystem methods.

The optional `host` field accepts `editor`, `editorBatchmode`, `player`, or `auto`. `editorBatchmode` launches Unity with `-batchmode -executeMethod UnityCursorToolkit.AgentCommands.BatchCommandEntry.Run` for non-rendering command workflows. Do not combine rendered viewport capture with `-nographics`; Unity does not initialize graphics in that mode.

Recommended flow:

1. Call `game_command` with `action: "list"`.
2. Start the command with `action: "run"` and a stable `commandName`.
3. Poll with `action: "status"` and the returned `runId`.
4. Use `action: "cancel"` only when the run is still pending or running.

Example:

```json
{ "action": "run", "commandName": "auth.select_us_east", "args": {} }
```

See `docs/GAME_COMMANDS.md` for registration patterns and project integration notes.

## Viewport Streaming

Use `viewport_stream` only when a rendered viewport is needed. `start` asks Unity to capture JPEG frames and exposes a local Node MJPEG endpoint; `status` returns the local stream URL and last frame metadata; `input` forwards tap, swipe, key, or text events to Unity. Input first relies on project-owned `viewport.*` game commands, then tries Unity Input System reflection when available.

## Dependency Changes

- Prefer `npm ci` for local installs.
- Use npm 11.14.1 or newer with `--min-release-age=7` for dependency updates.
- Keep audit remediations lockfile-scoped when possible, and do not update packages newer than 7 days without an explicit documented security hotfix approval.

## Agent Prompts

The standalone MCP server exposes prompts for common Unity workflows:

- `diagnose_unity_errors`
- `inspect_active_scene`
- `prepare_build`
- `safe_scene_edit_plan`

These prompts are intentionally conservative: inspect first, summarize state, then use dry runs before mutation.

## Useful Feature Ideas

- Prefab workflow tools: unpack/apply variants, inspect overrides, and instantiate prefabs safely.
- Unity Test Runner tools: list tests, run EditMode/PlayMode tests, and return structured failures.
- Build report tools: parse build output, surface warnings/errors, and compare artifact sizes.
- Package Manager tools: list packages, inspect versions, and propose dependency changes with dry-run output.
