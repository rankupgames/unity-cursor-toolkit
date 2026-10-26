# MCP Client Setup

Build the extension first:

```bash
cd unity-cursor-toolkit
npm ci
npm run compile
```

The standalone MCP server path is:

```text
<repo>/unity-cursor-toolkit/out/mcp/server.js
```

The server uses the current toolkit bridge. Package metadata declares a Unity
2019.4+ baseline, but that declaration is not a per-version certification.
Unity CLI, Pipeline, CoreCLR-specific behavior, and Unity 7 are tracked in
`docs/ROADMAP.md`. Client configuration stays stable, but future
backend selection must be explicit and must report its origin; it must not
silently replace the project's declared Editor.

Inside VS Code/Cursor, run **Unity Toolkit: Copy MCP Client Config** to copy ready-to-edit snippets for Cursor, Claude Code, VS Code, and Zed.

## Tool Names and Origins

The advertised catalog uses canonical names such as `toolkit.project_info`,
`toolkit.read_console`, and `toolkit.run_tests`. Existing bare names remain
aliases with the same arguments and content. Tool definitions include
`_meta.origin`, `_meta.canonicalName`, and `_meta.aliases`; results include
`_meta.origin` and `_meta.canonicalName`. The `unity://tools/catalog` resource
lists the same metadata.

Use a canonical name to select an origin explicitly. A bare-name collision
selects the toolkit tool when present; other collisions return
`ambiguous_tool` with canonical candidates. Unknown names return
`unknown_tool` with the canonical catalog. The approved Pipeline discovery
provider also registers `pipeline.commands`; Assistant remains unavailable.

Read-only checks use the resolved canonical identity. Unclassified origins
are refused before backend calls, including requests with `dryRun: true`.
Toolkit dry-run plans, direct-only test tools, progress tokens, and cancellation
request IDs retain their existing behavior. `batch_execute` accepts toolkit
operation names and their bare aliases, and refuses test tools or foreign-origin
operations at every nesting level before planning or forwarding.

## Pipeline Discovery and Local Plans

Use `pipeline.commands` with `action: "list"`, an absolute `projectPath`, and
the exact `editorPid`. Discovery requires CLI `1.0.0-beta.12`, official
Pipeline `0.8.0-exp.1` in the manifest, lock, and resolved package, and one
ready matching Editor. It checks project path, version, PID, and port before
and after listing. Other versions, ambiguous targets, malformed catalogs,
and backend failures return typed errors without fallback.

The catalog returns schemas and reviewed classifications. These classifications
describe SDK source; they do not prove which runtime handler a name selects.
All entries have `executionEligible: false`. `action: "run"` accepts `command`,
`args`, `dryRun`, and `timeoutMs` but cannot dispatch commands in this
milestone. Read-only commands return `provenance_unverified`; mutating,
destructive, and escape commands return `policy_refused`; unknown commands
return `unknown_command`. Dry runs inspect local metadata and policy without
CLI traffic. Global read-only mode permits this discovery and refusal flow.

Set `UNITY_CURSOR_TOOLKIT_PIPELINE_AUDIT_PATH` explicitly before any call.
The writer records a durable start and outcome with a shared invocation ID,
time, origin, action, reviewed command, classification, verified PID when
available, verified Editor version, and bounded result codes. It excludes
arguments, results, paths, host names, and credentials. The local file must
be regular, not linked, and contain only valid toolkit audit records. Use a
local disk; UNC and device paths are refused, but mapped network drives
cannot be identified from path syntax alone.

A cooperative exclusive `.lock` protects the 5 MiB cap across processes.
An unavailable, invalid, busy, or full journal refuses the call before backend
traffic; terminal-write failure also refuses the result. Records are never
rotated or deleted. A crash can leave a start record and a lock; the toolkit
does not take over that lock. File records are flushed; first creation is
not a guarantee against power loss. Preserve the journal and resolve its ownership
before recovery, or configure a new explicit audit path.

## CoreCLR Migration Tool

`coreclr_migration` is always read-only, including `action: "scan"`.
Use `action: "scan"` for JSON source findings, `action: "report"` for
Markdown content, or `action: "rules"` for the rule set and version.
The standalone server scans `UNITY_CURSOR_TOOLKIT_PROJECT_PATH`, or the
existing project-root fallback when that variable is unset. These actions never
save a report or change project files, and work without a Unity connection.

Pass `includeStatics: true` with scan/report only when loaded user static
field metadata is needed. This requires the matching connected Unity project
and current toolkit package. Unavailable or mismatched inventory returns a
typed `INVENTORY_UNAVAILABLE` error. `staticsInventory` reports fields,
cleanup attribute flags, traversal limits, counts, duration, truncation, and
reflection errors. It reads metadata without reading or changing field values.
See [the agent guide](AI_AGENTS.md#coreclr-migration-inspection) for scope and limits.

To save a report from the extension, run **Unity Toolkit: CoreCLR Migration
Scan**. It creates `CoreCLR-Migration-Report.md` at the linked project root.
MCP's report action returns the same report format in memory.

## Environment Variables

| Variable | Purpose |
|---|---|
| `UNITY_CURSOR_TOOLKIT_PROJECT_PATH` | Unity project root used for `.meta` resolution and migration source scans |
| `UNITY_CURSOR_TOOLKIT_MCP_READ_ONLY` | Set to `1` to block mutating tools |
| `UNITY_CURSOR_TOOLKIT_PIPELINE_AUDIT_PATH` | Explicit absolute local `.jsonl` audit file; its parent must already exist |
| `UNITY_CURSOR_TOOLKIT_MCP_PORTS` | Comma-separated Unity TCP ports, default `55500,55501,55502,55503,55504` |
| `UNITY_CURSOR_TOOLKIT_UNITY_PATH` | Optional Unity executable path for `game_command` with `host: "editorBatchmode"` |

## Cursor

Create `.cursor/mcp.json` in your Unity project:

```json
{
  "mcpServers": {
    "unity-cursor-toolkit": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/unity-cursor-toolkit/out/mcp/server.js"],
      "env": {
        "UNITY_CURSOR_TOOLKIT_PROJECT_PATH": "${workspaceFolder}",
        "UNITY_CURSOR_TOOLKIT_MCP_READ_ONLY": "0"
      }
    }
  }
}
```

## Claude Code

Project-scoped `.mcp.json`:

```json
{
  "mcpServers": {
    "unity-cursor-toolkit": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/unity-cursor-toolkit/out/mcp/server.js"],
      "env": {
        "UNITY_CURSOR_TOOLKIT_PROJECT_PATH": "${CLAUDE_PROJECT_DIR:-.}",
        "UNITY_CURSOR_TOOLKIT_MCP_READ_ONLY": "1"
      }
    }
  }
}
```

Read-only mode is recommended for shared project configs. Agents can still call mutating tools with `dryRun: true` to preview normalized commands.

## VS Code Copilot Agent Mode

Workspace `.vscode/mcp.json`:

```json
{
  "servers": {
    "unity-cursor-toolkit": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/unity-cursor-toolkit/out/mcp/server.js"],
      "env": {
        "UNITY_CURSOR_TOOLKIT_PROJECT_PATH": "${workspaceFolder}",
        "UNITY_CURSOR_TOOLKIT_MCP_READ_ONLY": "0"
      },
      "sandboxEnabled": false
    }
  }
}
```

## Zed

Add a custom context server to Zed `settings.json`:

```json
{
  "context_servers": {
    "unity-cursor-toolkit": {
      "command": "node",
      "args": ["/absolute/path/to/unity-cursor-toolkit/out/mcp/server.js"],
      "env": {
        "UNITY_CURSOR_TOOLKIT_PROJECT_PATH": "/absolute/path/to/unity/project",
        "UNITY_CURSOR_TOOLKIT_MCP_READ_ONLY": "0"
      }
    }
  }
}
```

## Verification

1. Open the Unity project in Unity and install `com.rankupgames.unity-cursor-toolkit`.
2. Confirm the Unity Editor is running.
3. Start the MCP client and list tools.
4. Call `project_info`.
5. Call `editor_validation` with `action: "status"`, then preview `action: "sync_and_compile"` with `dryRun: true` before requesting project-file synchronization and compilation.
6. Call `unity_context` with `action: "scan"` to create `.umetacontext/index.json`, then call `action: "summary"` to confirm indexed asset/object counts.
7. Call `read_console`.
8. Call `profiler_snapshot` with `action: "current"` to confirm Unity can return the current console/profiler session and compact console transcript path.
9. Call `profiler_snapshot` with `action: "readConsoleTranscript"` and the captured session id to confirm the MCP client can fetch the grouped whole-console timeline.
10. Call `game_command` with `action: "list"` to confirm runtime command discovery works when the Unity project has registered commands.
11. For safety, try `manage_gameobject` with `dryRun: true` before any real scene mutation.

The extension and standalone MCP server require the current Unity package handshake. If attach fails while Unity is running, update `com.rankupgames.unity-cursor-toolkit`; older package versions can expose a TCP port without answering the required toolkit ping.

## Unity Context Index

The `unity_context` tool builds and reads `.umetacontext/index.json` under the Unity project root. `scan` refreshes the index, while `summary`, `query`, and `read` are read-only lookups for assets, serialized objects, components, GUIDs, and references.

```json
{ "action": "scan" }
```

```json
{ "action": "query", "query": "Player", "limit": 10 }
```

```json
{ "action": "read", "nodeId": "Assets/Scenes/Sample.unity:114:123456" }
```

## Runtime Game Commands

The `game_command` tool bridges MCP clients to commands registered by the Unity project itself. Use it for deterministic gameplay workflows such as login steps, server selection, menu navigation, or mission setup.

```json
{ "action": "list" }
```

```json
{ "action": "run", "commandName": "auth.select_us_east", "args": {} }
```

```json
{ "action": "status", "runId": "<run id returned by run>" }
```

See `docs/GAME_COMMANDS.md` for the C# registration pattern and project setup checklist.

For headless discovery or non-rendering command workflows, pass `host: "editorBatchmode"`:

```json
{ "action": "list", "host": "editorBatchmode" }
```

The server resolves Unity from `UNITY_CURSOR_TOOLKIT_UNITY_PATH`, the `unityPath` argument, or the project version under `ProjectSettings/ProjectVersion.txt`.

When rebuilding the extension from source, install with `npm ci`. Dependency updates should use npm 11.14.1 or newer with `--min-release-age=7`; security fixes for packages younger than 7 days need explicit hotfix approval before changing the lockfile.

### Scene object IDs

Unity 7 and newer return opaque `entityId` strings from scene hierarchy and GameObject create/find calls, and `componentEntityId` from component creation. Pass `entityId` to GameObject/component actions and `parentEntityId` to setParent. Keep these strings unchanged; do not convert them to JavaScript numbers.

Editors before Unity 7 retain integer `instanceId`, `parentInstanceId`, and `componentInstanceId`. Version guards select the supported Unity API at compile time. A supplied string ID takes precedence; unsupported or malformed IDs fail before mutation. Names remain available when no ID is supplied. An unresolved parent is an error; omit all parent identifiers to detach.

## Unity tests

Use `list_tests` or `run_tests` with `mode: "EditMode"` or `"PlayMode"`. Optional fields are `projectPath`, `backend: "auto" | "cli" | "bridge"`, `timeoutMs` (1 to 600000; default 600000), and `filter` with literal `assembly`, `namespace`, `class`, `test`, or `category` strings. Filters combine with AND; a namespace includes its descendants. `run_tests` also accepts `dryRun`.

`list_tests` and dry runs discover leaf tests without executing them. They require the connected Editor bridge and Unity Test Framework. Read-only mode (`UNITY_CURSOR_TOOLKIT_MCP_READ_ONLY=1` or `true`, including the extension process environment) permits discovery and blocks all test execution. The extension exposes **Unity Toolkit: List Tests** and **Unity Toolkit: Run Tests**; results go to **Unity Tests** with the selected backend and exact Editor version.

`auto` uses the matching Editor's advertised test runner. Without an available bridge, execution can select the CLI before starting. Explicit backends never switch, and failures never trigger a retry on another backend. Test tools must be called directly; batch_execute refuses them. The pinned CLI has no discovery or dry-run support and cannot preserve assembly/category filters. CLI execution requires a closed local project, the exact declared installed Editor, and resolved Test Framework/NUnit metadata. It performs no package installation or version substitution. Remote bridge execution requires a matching project and advertised capability; the CLI always runs on the MCP host.

Bridge execution currently requires the reviewed Test Framework versions 1.6.0, 1.8.0 or 1.9.0 and their verified internal GUID registration contract. Other versions can still advertise discovery, but execution is refused when owned stop confirmation is unavailable. Stop confirmation means the owned scheduler no longer executes; Unity can skip NUnit teardown during cancellation. Unity 2019.4 runtime parity remains unverified.

Results include `success`, `backend`, `editorVersion`, `mode`, `runId`, `status`, exact `selection`, per-test `id/fullName/status/durationMs/message/stackTrace`, and `summary` counts and duration. Failures include `error.code/message/recovery`; native CLI failures can also report `nativeCode` and `exitCode`. Test statuses are `passed`, `failed`, `skipped`, `inconclusive`, and `not_run`. Run statuses distinguish discovery, execution, completion, failure, cancellation, timeout, and errors. Private paths and credential-like text are redacted. A CLI run containing an inconclusive test can return `tests_failed` with native `TESTS_FAILED`/exit 8 even when no leaf failed; its inconclusive status and counts remain intact. The bridge can complete that same selection with an inconclusive leaf.

MCP clients can send a standard `_meta.progressToken` on `tools/call` for bridge progress (a strictly increasing heartbeat sequence; test counts are in the message) and `notifications/cancelled` with the original JSON-RPC request ID to cancel their request. Extension progress notifications also expose Cancel. Cancellation targets only the owned CLI process or framework run. A bridge cancellation request is not completion: the provider waits for a terminal response and reports `cancellation_unconfirmed` if it cannot verify shutdown. A deadline can include an additional bounded cancellation grace period. Inspect an interrupted run before retrying.

Example dry run: `{"mode":"EditMode","backend":"bridge","filter":{"namespace":"Game.Tests"},"dryRun":true}`.

Progress follows the [MCP progress contract](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2025-06-18/schema.ts): notification values increase for each request token.
