# Unity Cursor Toolkit -- Zed Support

Zed does not run VS Code extensions natively. Instead, Zed connects to the Unity Cursor Toolkit via its MCP server.

## Prerequisites

- Unity project with `HotReloadHandler.cs` and `ConsoleToCursor.cs` installed in `Assets/Editor/`
- The toolkit's MCP server binary (built from `src/mcp/server.ts`)

## Setup

Add the following to your Zed `settings.json` under `"context_servers"`:

```json
{
  "context_servers": {
    "unity-cursor-toolkit": {
      "command": {
        "path": "node",
        "args": ["<path-to-extension>/out/mcp/server.js"]
      }
    }
  }
}
```

Replace `<path-to-extension>` with the absolute path to the built extension directory.

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

## How It Works

The MCP server communicates with Unity over the same TCP socket (ports 55500-55504) used by the VS Code/Cursor extension. The Unity-side scripts are identical regardless of which editor you use.

## Limitations

- No live console panel UI (Zed does not support webview panels)
- No status bar integration
- No hot reload file watcher (use Zed's built-in save triggers or manual commands)
- Features depend on the MCP server being fully implemented (Phase 3 of the roadmap)
