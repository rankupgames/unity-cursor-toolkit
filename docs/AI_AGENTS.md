# AI Agent Guide

Unity Cursor Toolkit is designed to give agents direct Unity Editor context without requiring users to paste console logs, scene state, or `.meta` files manually.

## What Agents Can Do

- Read recent Unity console output with `read_console`.
- Capture current console/profiler context with `profiler_snapshot`.
- Read compact whole-console session transcripts with `profiler_snapshot` using `action: "readConsoleTranscript"` after capturing or listing a session id.
- Scan, summarize, query, and read the local Unity asset/object/reference graph with `unity_context`.
- Inspect project state with `project_info`.
- Inspect active scene hierarchy with `manage_scene` and `action: "getHierarchy"`.
- Resolve Unity `.meta` files with `resolve_meta`.
- Discover and schedule game-authored runtime workflows with `game_command`.
- Regenerate project files and verify script compilation with `editor_validation`.
- Inspect save state, save all open scenes and assets, and close Unity safely with `editor_lifecycle`.
- Control play mode, capture screenshots, execute menu items, manage assets, edit GameObjects/components, and trigger builds when allowed.

## Safe Default Workflow

1. Call `project_info`.
2. Call `unity_context` with `action: "summary"` when `.umetacontext/index.json` already exists, or ask to run `action: "scan"` when the index is missing or stale.
3. Call `read_console` with `level: "error"` and then without a level filter.
4. Call `profiler_snapshot` with `action: "current"` when investigating performance, hitches, GC allocations, frame timing, or console event timelines.
5. When the compact grouped console timeline is needed, call `profiler_snapshot` with `action: "readConsoleTranscript"` and the captured session id.
6. Call `manage_scene` with `action: "getHierarchy"` before any scene edit.
7. Call `game_command` with `action: "list"` before scheduling a project-owned command.
8. After generated C# or project-file changes, preview `editor_validation` with `action: "sync_and_compile"` and `dryRun: true`, then run it and poll `action: "status"` until `pending` is false.
9. Use `dryRun: true` for the first mutating call.
10. Execute the real mutating call only after the user has approved the intended change.
11. Before closing or restarting a user editor, exit Play Mode, call `editor_lifecycle` with `action: "status"`, preview `action: "saveAndQuit"` with `dryRun: true`, then run it and wait for Unity's normal process exit.

## Safety Controls

- Set `UNITY_CURSOR_TOOLKIT_MCP_READ_ONLY=1` to block mutating MCP tool calls.
- Pass `dryRun: true` to mutating Unity tools to return the normalized command without sending it to Unity.
- `resolve_meta` rejects absolute paths and traversal outside the Unity project root.
- `unity_context` writes only `.umetacontext/index.json` during `action: "scan"`; `summary`, `query`, and `read` are read-only.
- Tools include MCP annotations such as `readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint` so clients can expose safer approval UX.
- `profiler_snapshot` read actions are allowed in read-only mode, including `readConsoleTranscript`. Saving or clearing retained profiler sessions is treated as mutating.
- `game_command` read actions are `list` and `status`; scheduling and cancellation are mutating because they execute or stop game code.
- `editor_validation` read actions are `list` and `status`; project-file synchronization and compile requests are mutating and support `dryRun`.
- `editor_lifecycle` action `status` is read-only. `save` and `saveAndQuit` are mutating; `saveAndQuit` closes the editor only after dirty scenes and loaded persistent assets no longer report unsaved changes. Prefab Mode must be closed manually first.
- Never force-terminate a user editor process. If the bridge cannot save, leave Unity open unless the user explicitly accepts the unsaved-work risk.

## Runtime Game Commands

Use `game_command` when the Unity project has registered workflows through `UnityCursorToolkit.AgentCommands`. Commands run in play mode on Unity's main thread and should call the game's existing public subsystem methods.

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

Use `host: "editorBatchmode"` for command list/run calls that should execute through a fresh Unity batchmode process instead of the currently attached editor bridge. Pass `unityPath` or set `UNITY_CURSOR_TOOLKIT_UNITY_PATH` when Unity cannot be found from the project version.

## Unity Context Index

Use `unity_context` when an agent needs project structure before deciding which files or Unity objects to inspect. The scanner reads `Assets`, `Packages`, and `ProjectSettings`, extracts `.meta` GUIDs plus Unity YAML anchors, and writes `.umetacontext/index.json`.

Recommended context flow:

1. Call `unity_context` with `action: "summary"`.
2. If the index is missing or stale and writes are allowed, call `action: "scan"`; use `dryRun: true` first when approval is required.
3. Call `action: "query"` with `query`, `path`, `guid`, `type`, `scenePath`, `prefabPath`, or `dependency`.
4. Call `action: "read"` with a returned `nodeId`, `path`, `guid`, or `name` to include adjacent references.

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
