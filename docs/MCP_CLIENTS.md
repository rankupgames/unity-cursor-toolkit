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

## Editor recovery

Set `UNITY_CURSOR_TOOLKIT_PROJECT_PATH` to the selected Unity project. The standalone
MCP process monitors an active compile request or a failed Editor response independently
of Unity's main thread. After verifying the selected project's existing lock owner
and executable, it activates that verified Unity bundle with `open -a`. It does not
request a new instance or pass launch arguments. A fresh read-only `osascript`
process must then confirm that exact PID is foreground. It never replays a command.

`editor_validation` with `action: "recover"` opens a bounded recovery episode. The
monitor permits at most two focus attempts and stops on compiler errors, project/process
mismatch or its deadline. Read-only servers do not foreground applications.
`compileSucceeded` requires the matching request, compiler diagnostics and a fresh
post-reload main-thread observation. Sync-only completion and a responsive Editor do
not prove compilation.

For an explicit operational focus on Node24:

```bash
npm run unity:focus -- --project /path/to/UnityProject
```

The command reports `activated` only after verifying the foreground process. Other
results remain explicit; activation alone is not compile or bridge proof.

## Play sessions

Use `session_monitor` to opt in to start/error/end snapshots and read object/component
evidence. The selected-project journal supports event-driven standby notifications
and the `unity://sessions/events` resource. See [Play session evidence](PLAY_SESSIONS.md)
for capture timing, attribution limits, budgets and subscription commands.
