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

## Environment Variables

| Variable | Purpose |
|---|---|
| `UNITY_CURSOR_TOOLKIT_PROJECT_PATH` | Unity project root used for `.meta` resolution |
| `UNITY_CURSOR_TOOLKIT_MCP_READ_ONLY` | Set to `1` to block mutating tools |
| `UNITY_CURSOR_TOOLKIT_MCP_PORTS` | Comma-separated Unity TCP ports, default `55500,55501,55502,55503,55504` |
| `UNITY_CURSOR_TOOLKIT_EDITOR_LOG_PATH` | Optional absolute Editor log path owned by the selected project; otherwise use verified Editor metadata or its existing toolkit-owned launch record. No global log fallback. |
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

`editor_validation` status reads in the standalone server and extension run in
Node and return without waiting for Unity's main thread. They report compiler evidence, domain reload, toolkit
transport, and main-thread readiness separately. The selected project must match
`UNITY_CURSOR_TOOLKIT_PROJECT_PATH` (or the configured working directory). A pong
proves only toolkit transport; a project-info reply must verify the project before
commands are sent. A dropped compile request is never replayed automatically.

Default discovery checks ports 55500 through 55504. Reload can select another
available port in that range. An explicit `UNITY_CURSOR_TOOLKIT_MCP_PORTS` list
limits discovery to that list. One refused port does not prove listener absence.
Status reports `connectedPort` only after the bridge confirms the selected project.
`editorProcessId` is the PID reported by that verified bridge, or `null` when the
package does not report it. These fields clear on disconnect or project mismatch.
A listening socket alone does not prove a toolkit pong or main-thread response.

The monitor reads the existing project validation result and a bounded incremental
Editor log tail. Old or mismatched results cannot prove the active request passed.
Compilation and reload callbacks prove success; absent evidence or a timeout returns
`inconclusive`. Logs alone never prove overall success; a fresh main-thread reply
is also required. Initial status-only observation skips historical log lines.
`operationId` correlates compile requests with their result across domain reload.
Automatic compilations after user edits use the same callbacks and result file;
a later compile replaces earlier diagnostics after an explicit request finishes.
Both Node processes watch only the selected project's result path, including
directory creation and atomic replacement. A new pending operation starts bounded
background observation without a tool call. Idle observation has no polling timer.
The extension uses its existing connection and replaces its monitor when the linked
project changes. Deactivation closes the watcher and active observation timer.
Reloads without compilation report `compilerStatus: "not_requested"`; they cannot
prove that scripts compiled. `automaticObservation` reports watcher availability.
`suspectedFocusWait` is an observation, not a confirmed cause. During an automatic
operation, an explicit validation request, or recovery after a lost bridge response,
the Node monitor continues observing in the background. After main-thread silence
it can focus the selected running macOS Editor. It resolves the project lock owner,
checks its executable/version and the bridge PID when available, and checks ownership
again. It sets that exact PID frontmost through System Events. AppKit must then
confirm that PID is active.
Recovery makes at most two attempts and stops on terminal results, timeout or
shutdown. It never launches or restarts Unity, saves assets, or replays the lost
command. A later fresh main-thread response proves bridge readiness; compilation
still requires its separate completion evidence. Recovery reports its reason;
activation alone remains `waiting_for_main_thread`, and an unconfirmed timeout fails.

Read-only server mode disables native focus recovery and blocks the explicit
`editor_validation` action `recover`. The extension also disables native focus
when `UNITY_CURSOR_TOOLKIT_MCP_READ_ONLY=1`. Recovery observes without requesting
a compile. macOS Automation denial is
reported explicitly, without repeated permission attempts. Other operating
systems return `unsupported`.

For an existing Editor before the new standalone server is built and installed,
the source helper is available from the extension directory with Node 22.18+:

```sh
node scripts/focus-unity-editor.js --project <unity-project-root> [--expected-pid <pid>]
```

The helper emits one JSON result; exit 0 requires verified activation, 1 reports
an unsuccessful result, and 2 rejects invalid arguments. This utility does not
replace the consumer's pinned Unity package or install the new MCP server.
