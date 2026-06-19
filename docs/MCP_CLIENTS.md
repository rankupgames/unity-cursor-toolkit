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
5. Call `unity_context` with `action: "scan"` to create `.umetacontext/index.json`, then call `action: "summary"` to confirm indexed asset/object counts.
6. Call `read_console`.
7. Call `profiler_snapshot` with `action: "current"` to confirm Unity can return the current console/profiler session and compact console transcript path.
8. Call `profiler_snapshot` with `action: "readConsoleTranscript"` and the captured session id to confirm the MCP client can fetch the grouped whole-console timeline.
9. Call `game_command` with `action: "list"` to confirm runtime command discovery works when the Unity project has registered commands.
10. For safety, try `manage_gameobject` with `dryRun: true` before any real scene mutation.

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
