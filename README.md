# Unity Cursor Toolkit

[![VS Code Marketplace](https://img.shields.io/vscode-marketplace/v/rankupgames.unity-cursor-toolkit.svg)](https://marketplace.visualstudio.com/items?itemName=rankupgames.unity-cursor-toolkit)
[![Installs](https://img.shields.io/vscode-marketplace/d/rankupgames.unity-cursor-toolkit.svg)](https://marketplace.visualstudio.com/items?itemName=rankupgames.unity-cursor-toolkit)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![CI](https://img.shields.io/github/actions/workflow/status/rankupgames/unity-cursor-toolkit/ci.yml?branch=main)](https://github.com/rankupgames/unity-cursor-toolkit/actions)
[![OpenVSX](https://img.shields.io/badge/OpenVSX-published-green)](https://open-vsx.org/extension/rankupgames/unity-cursor-toolkit)

A VS Code / Cursor extension that bridges your editor and the Unity Editor -- hot reload, live console, MCP server for AI agents, and stable TCP connectivity.

## Disclaimer

This extension is not affiliated with, endorsed by, or an official product of Unity Technologies. Unity and the Unity logo are trademarks or registered trademarks of Unity Technologies or its affiliates in the U.S. and elsewhere.

## Features

### Hot Reload

Save-to-refresh with debounced file watching and compilation feedback in the status bar. IL patching coming soon.

### Live Console

Real-time streaming, severity filtering, text search, clickable stack traces, copy button, send-to-AI-chat, and a ring buffer (10k entries, configurable).

### Connection

TCP state machine with heartbeat, exponential backoff reconnect, and multi-port auto-select (55500-55504).

### Status Bar

Two-part layout: one-click connect toggle plus quick-access dropdown with play mode controls, console snapshot, and project info.

### MCP Server

AI agents (Cursor, Claude Code, Copilot) can read console, control play mode, manage scenes/assets, and take screenshots (coming soon).

### Meta File Management

Auto-hide from explorer and Cmd+P, on-demand resolve for AI, auto-rename/delete (coming soon).

## Quick Start

1. Install the extension from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=rankupgames.unity-cursor-toolkit) or OpenVSX.
2. Open a Unity project folder in VS Code or Cursor.
3. Click **Unity Attach** in the status bar to connect.

## Requirements

- VS Code or Cursor 1.60+
- Unity 2019+

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `unityCursorToolkit.console.enabled` | `true` | Enable the Unity Console panel in the sidebar |
| `unityCursorToolkit.console.autoStream` | `true` | Auto-stream console output when connected |
| `unityCursorToolkit.console.maxEntries` | `10000` | Max entries in the console ring buffer |
| `unityCursorToolkit.hotReload.preferILPatch` | `false` | Prefer IL patching for hot reload (coming soon) |
| `unityCursorToolkit.modules.*.enabled` | `true` | Enable/disable individual modules |
| `unityCursorToolkit.workspaceScanPaths` | `[]` | Additional paths to scan for Unity projects |

## Commands

| Command | Description |
|---------|-------------|
| `unity-cursor-toolkit.startConnection` | Start/Attach to a Unity project |
| `unity-cursor-toolkit.reloadConnection` | Reload the current connection |
| `unity-cursor-toolkit.stopConnection` | Stop the connection |
| `unity-cursor-toolkit.console.clear` | Clear the console panel |
| `unity-cursor-toolkit.console.sendToChat` | Send console output to AI chat |
| `unity-cursor-toolkit.console.copy` | Copy console output to clipboard |
| `unity-cursor-toolkit.console.snapshot` | Take a console snapshot |
| `unity-cursor-toolkit.console.export` | Export console to file |
| `unity-cursor-toolkit.resolveMeta` | Resolve .meta file for path (for AI) |
| `unity-cursor-toolkit.openProject` | Open Unity project in editor |
| `unity-cursor-toolkit.generateFolderStructure` | Generate folder structure for AI context |

## Project Structure

```
unity-cursor-toolkit/
  unity-cursor-toolkit/
    src/
      extension.ts          # Entry point
      core/                 # Connection, project handler, types
      console/              # Console bridge and panel
      hot-reload/           # File watcher and debounce
      mcp/                  # MCP server for AI agents
      plastic/              # Plastic SCM (WIP)
    unity-assets/
      HotReloadHandler.cs   # Unity-side hot reload
      ConsoleToCursor.cs   # Unity-side console streaming
```

## Roadmap

| Version | Focus |
|---------|-------|
| v0.2 | Console v2, Meta management, developer experience |
| v0.3 | IL Hot Reload |
| v0.4 | Full MCP Server |
| v0.5 | Debugging integration |
| v0.6 | Advanced tooling |

## Distribution

- **VS Code Marketplace** — Primary distribution
- **OpenVSX** — Windsurf, VSCodium, Theia
- **Cursor** — Native support
- **Zed** — Via MCP server

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT License — Copyright (c) 2025 Rank Up Games LLC. See [LICENSE](LICENSE) for details.
