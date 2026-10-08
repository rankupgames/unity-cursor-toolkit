# AI Agent Guide

Unity Cursor Toolkit is designed to give agents direct Unity Editor context without requiring users to paste console logs, scene state, or `.meta` files manually.

## Unity Version and Backend Status

The core package declares Unity 2019.4 or later. Current operations use the
toolkit bridge or an explicitly requested batchmode Editor. Standalone Unity
CLI Editor operations, Pipeline, CoreCLR-specific behavior, and Unity 7 support are planned or
evidence-gated backends; agents must not claim they are shipped until the
capability response and recorded matrix prove them.

Never silently switch to another Editor version or backend. Report the selected
Editor, backend, and capability set in plans and results. See
`docs/ROADMAP.md`.

## Unity CLI Diagnostic Backend

The extension composes the first-party standalone CLI through the pure Node
`UnityCliAdapter`. **Unity Toolkit: Unity CLI Doctor** probes the configured,
environment-selected, or PATH binary and compares its version with the recorded
`1.0.0-beta.12` pin. The CLI status is independent of the toolkit bridge.
A version mismatch is a warning with expected and found values; no install,
upgrade, Editor substitution, or automatic backend fallback occurs.

Production callers in this batch are version and doctor. The status bar shows CLI version availability.
The local read-only guard permits version, doctor, and project-scoped status plans. Other invocations
require an explicit mutating caller; the guard refuses before spawning. Existing
MCP schemas, policy handling, and game_command batchmode execution are unchanged.

Every call passes arguments directly with JSON and non-interactive flags, keeps
stdout and stderr separate, and requires one complete result envelope. Mixed,
truncated, contradictory, or oversized output returns `invalid_output`, with
an excerpt limited to 500 characters. Do not recover a success object from the
middle of logs. The captured build output does not satisfy this parser.

Typed failures retain the native CLI code and exit value. In particular,
`COMMAND_FAILED` is generic; it does not prove authentication, locking,
compilation, or module failure. The exact captured missing-Editor message has a
local `missing_editor` diagnosis without changing its native code. See the
[failure matrix](UNITY_LANDSCAPE.md#adapter-failure-matrix) for pending cases.

Caller timeout and cancellation have separate codes. Windows cleanup uses the
spawned CLI PID and its child tree; POSIX cleanup uses its own process group.
Failure to confirm cleanup returns `cleanup_failed` and a typed
`terminationReason`. Never target a user Editor or process name. Interrupted
operations can leave partial artifacts; inspect them before retrying.

## Runtime Capability Handshake

`project_info` adds `runtime: { isCoreCLR: boolean, hasDomainReload: boolean }`.
The fields describe the running Editor, not its Player scripting backend.
`hasDomainReload` reports runtime support, not the Enter Play Mode option.

The extension reads these fields through `connectionManager.getRuntimeCapabilities()`.
Mono with domain reload support enables the existing IL refresh and Mono debug paths.
CoreCLR leaves script compilation and code reload to Unity and blocks the Mono debug adapter.
This does not enable instant hot reload or add a CoreCLR debugger.

A missing entire runtime block preserves shipped legacy Mono behavior.
A present invalid block or unknown runtime returns `capability_unavailable` and disables runtime features.
Capability refusals never trigger a full-refresh fallback.
See the generated [capability matrix](CAPABILITY_MATRIX.md) for recorded version evidence.

## CoreCLR Migration Inspection

Run **Unity Toolkit: CoreCLR Migration Scan** (`unity-cursor-toolkit.migration.scan`)
in the extension to scan the linked Unity project. It writes
`CoreCLR-Migration-Report.md` at the project root and opens it. The report groups
findings by severity with file, line, source snippet, explanation, replacement,
and a Unity documentation link. It includes counts, scan date, rule version, and
an explicit result when no findings are found. Errors appear in the extension.
This command writes the report only; it does not fix user scripts.

The `coreclr_migration` MCP tool uses the same scanner and rules:

- `action: "scan"` returns structured JSON findings.
- `action: "report"` returns Markdown text without saving a file.
- `action: "rules"` returns the loaded rule set and version.

All three actions are read-only and are allowed with
`UNITY_CURSOR_TOOLKIT_MCP_READ_ONLY=1`. Standalone scans use
`UNITY_CURSOR_TOOLKIT_PROJECT_PATH`; extension scans use the linked project.
The source scanner reads C# under `Assets` and `Packages`, excludes generated
files and build output, and reports review candidates rather than proving that
each match is incompatible.

For `scan` or `report`, pass `includeStatics: true` to add
`staticsInventory` from the connected matching Unity project. This option
fails with `INVENTORY_UNAVAILABLE` if the bridge is unavailable or belongs to
another project. It inspects loaded assemblies whose compilation sources are
all under `Assets`; Unity, UPM package, mixed-source, and precompiled assemblies
are excluded. Each field records assembly, type, field name, field type, and
`hasCleanupAttribute`. The flag recognizes Unity's
`Unity.Scripting.LifecycleManagement.AutoStaticsCleanupAttribute` and
`AutoStaticsCleanupOnCodeReloadAttribute` on fields or their declaring types,
with `NoAutoStaticsCleanupAttribute` field exclusions. It does not prove that
custom cleanup methods are correct. No field values, property getters, user
static constructors, or attribute constructors are executed.

Inventory work stops at 128 assemblies, 2048 types, 4096 fields, or a cooperative
500 ms budget (individual Unity metadata calls cannot be preempted). The payload includes the limits, counts, duration, `truncated`,
and reflection `errors`. Individual reflection calls cannot be interrupted;
a partial inventory must not be treated as a complete audit. The collector uses
APIs present in Unity 2019.4. Actual 2019.4 runtime proof remains pending.

## What Agents Can Do

- Read recent Unity console output with `read_console`.
- Capture current console/profiler context with `profiler_snapshot`.
- Use the Unity toolbar copy action when a human wants clipboard context plus a
  current main-camera application screenshot path. Each click overwrites the
  same temporary PNG.
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
- CoreCLR and Unity 7 work is tracked in `docs/ROADMAP.md` and GitHub issues; do not
  present open issues as available tools.

### Scene object IDs

Unity 7 and newer return opaque `entityId` strings from scene hierarchy and GameObject create/find calls, and `componentEntityId` from component creation. Pass `entityId` to GameObject/component actions and `parentEntityId` to setParent. Keep these strings unchanged; do not convert them to JavaScript numbers.

Editors before Unity 7 retain integer `instanceId`, `parentInstanceId`, and `componentInstanceId`. Version guards select the supported Unity API at compile time. A supplied string ID takes precedence; unsupported or malformed IDs fail before mutation. Names remain available when no ID is supplied. An unresolved parent is an error; omit all parent identifiers to detach.
