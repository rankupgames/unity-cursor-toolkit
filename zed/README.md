# Unity Cursor Toolkit -- Zed Support

Zed does not run VS Code extensions natively. Instead, Zed connects to Unity Cursor Toolkit through the standalone MCP stdio server.

## Prerequisites

- Unity project with `com.rankupgames.unity-cursor-toolkit` installed
- Built companion extension output at `unity-cursor-toolkit/out/mcp/server.js`
- Node.js available on your PATH

## Setup

Build the server:

```bash
cd unity-cursor-toolkit
npm ci
npm run compile
```

Add the following to your Zed `settings.json` under `"context_servers"`:

```json
{
  "context_servers": {
    "unity-cursor-toolkit": {
      "command": "node",
      "args": ["<path-to-extension>/out/mcp/server.js"],
      "env": {
        "UNITY_CURSOR_TOOLKIT_PROJECT_PATH": "<path-to-unity-project>",
        "UNITY_CURSOR_TOOLKIT_MCP_READ_ONLY": "0"
      }
    }
  }
}
```

Replace `<path-to-extension>` with the absolute path to the built extension directory and `<path-to-unity-project>` with the Unity project root.

## Available Tools

Once connected, the MCP server exposes tools for:

- `read_console` -- fetch Unity console logs with filtering
- `clear_console` -- clear the Unity console
- `resolve_meta` -- read `.meta` file GUID and import settings
- `play_mode` -- enter, exit, pause, step play mode
- `manage_scene` -- scene hierarchy, load, save
- `manage_gameobject` -- create, find, transform game objects
- `manage_component` -- add, remove, get/set component properties
- `project_info` -- Unity version, active scene, build target
- `screenshot` -- capture game or scene view
- `execute_menu_item` -- run any Unity menu command
- `build_trigger` -- trigger a Unity build
- `batch_execute` -- run multiple tools in sequence

The server also exposes MCP resources for project info, scene hierarchy, recent console output, console errors, and the tool catalog. Prompts are available for diagnosing errors, inspecting scenes, preparing builds, and planning safe scene edits.

## How It Works

The MCP server communicates with Unity over the same TCP socket (ports 55500-55504) used by the VS Code/Cursor extension. The Unity-side package is identical regardless of which editor or MCP client you use.

Set `UNITY_CURSOR_TOOLKIT_MCP_READ_ONLY=1` to block mutating tools. Mutating Unity tools also support `dryRun: true` to preview the normalized command without sending it to Unity.

## Limitations

- No live console panel UI (Zed does not support webview panels)
- No status bar integration
- No hot reload file watcher (use Zed's built-in save triggers or manual commands)
- Console reads only include entries observed while the MCP server process is connected
