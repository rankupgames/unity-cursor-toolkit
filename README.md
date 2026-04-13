# Unity Cursor Toolkit

[![VS Code Marketplace](https://img.shields.io/vscode-marketplace/v/rankupgames.unity-cursor-toolkit.svg?label=Marketplace)](https://marketplace.visualstudio.com/items?itemName=rankupgames.unity-cursor-toolkit)
[![Marketplace Installs](https://img.shields.io/vscode-marketplace/d/rankupgames.unity-cursor-toolkit.svg?label=Installs)](https://marketplace.visualstudio.com/items?itemName=rankupgames.unity-cursor-toolkit)
[![Open VSX](https://img.shields.io/open-vsx/v/rankupgames/unity-cursor-toolkit?label=Open%20VSX)](https://open-vsx.org/extension/rankupgames/unity-cursor-toolkit)
[![Open VSX Downloads](https://img.shields.io/open-vsx/dt/rankupgames/unity-cursor-toolkit?label=Open%20VSX%20Downloads)](https://open-vsx.org/extension/rankupgames/unity-cursor-toolkit)
[![CI](https://img.shields.io/github/actions/workflow/status/rankupgames/unity-cursor-toolkit/ci.yml?branch=main&label=CI)](https://github.com/rankupgames/unity-cursor-toolkit/actions)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://opensource.org/licenses/MIT)

A VS Code / Cursor extension that bridges your editor and the Unity Editor -- hot reload, live console, MCP server for AI agents, Mono debugging, and stable TCP connectivity.

## Disclaimer

This extension is not affiliated with, endorsed by, or an official product of Unity Technologies. Unity and the Unity logo are trademarks or registered trademarks of Unity Technologies or its affiliates in the U.S. and elsewhere.

## Features

### Hot Reload

Save-to-refresh with debounced file watching and compilation feedback in the status bar. IL patching support for play-mode method body swapping without domain reload.

### Live Console

Real-time streaming, severity filtering, text search, clickable stack traces, copy/export, send-to-AI-chat, and a ring buffer (10k entries, configurable).

### Connection

TCP state machine with heartbeat, exponential backoff reconnect, and multi-port auto-select (55500-55504).

### Status Bar

Two-part layout: one-click connect toggle plus quick-access dropdown with play mode controls, console snapshot, and project info.

### Play Mode Control

Enter, exit, pause, and single-frame step directly from VS Code / Cursor -- no need to switch to the Unity Editor.

### MCP Server

AI agents (Cursor, Claude Code, Copilot) can read console, control play mode, manage scenes/assets, query project info, and capture screenshots.

### Mono Debugger

Attach to the Unity Editor or a Development Player via the built-in Mono soft debugger (port 56000 default).

### Meta File Management

Auto-hide `.meta` files from explorer and Cmd+P, on-demand resolve for AI workflows.

### Unity Package (C# side)

A companion UPM package (`com.rankupgames.unity-cursor-toolkit`) provides the Unity-side scripts: console forwarding, hot reload handler, MCP bridge, debug bridge, and IL patcher. Installable via OpenUPM, Git URL, or scoped registry.

## Quick Start

1. Install the extension from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=rankupgames.unity-cursor-toolkit) or [OpenVSX](https://open-vsx.org/extension/rankupgames/unity-cursor-toolkit).
2. Install the Unity package (see [Unity Package Installation](#unity-package-installation)).
3. Open a Unity project folder in VS Code or Cursor.
4. Click **Unity Attach** in the status bar to connect.

## Requirements

- VS Code or Cursor 1.60+
- Unity 2019.4+

## Unity Package Installation

### Via OpenUPM (recommended)

```bash
openupm add com.rankupgames.unity-cursor-toolkit
```

### Via Git URL

In Unity: **Window > Package Manager > + > Add package from git URL**

```
https://github.com/rankupgames/unity-cursor-toolkit.git?path=Packages/com.rankupgames.unity-cursor-toolkit
```

### Via Scoped Registry

Add to your project's `Packages/manifest.json`:

```json
"scopedRegistries": [
  {
    "name": "OpenUPM",
    "url": "https://package.openupm.com",
    "scopes": ["com.rankupgames"]
  }
],
"dependencies": {
  "com.rankupgames.unity-cursor-toolkit": "1.0.0"
}
```

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `unityCursorToolkit.console.enabled` | `true` | Enable the Unity Console panel in the sidebar |
| `unityCursorToolkit.console.autoStream` | `true` | Auto-stream console output when connected |
| `unityCursorToolkit.console.maxEntries` | `10000` | Max entries in the console ring buffer |
| `unityCursorToolkit.hotReload.preferILPatch` | `true` | Prefer IL patching over full asset refresh in play mode |
| `unityCursorToolkit.hotReload.ilPatchTimeout` | `5000` | Timeout (ms) for IL patch before falling back to full refresh |
| `unityCursorToolkit.workspaceScanPaths` | `[]` | Additional paths to scan for `.code-workspace` files |

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
| `unity-cursor-toolkit.console.export` | Export console logs to file |
| `unity-cursor-toolkit.resolveMeta` | Resolve `.meta` file for a path (for AI) |
| `unity-cursor-toolkit.openProject` | Open Unity project in the editor |
| `unity-cursor-toolkit.generateFolderStructure` | Generate folder structure for AI context |
| `unity-cursor-toolkit.quickAccess` | Quick Actions menu |
| `unity-cursor-toolkit.debug.attach` | Attach Mono debugger to Unity |
| `unity-cursor-toolkit.playMode.enter` | Enter Play Mode |
| `unity-cursor-toolkit.playMode.exit` | Exit Play Mode |
| `unity-cursor-toolkit.playMode.pause` | Pause Play Mode |
| `unity-cursor-toolkit.playMode.step` | Step one frame |
| `unity-cursor-toolkit.screenshot` | Capture a screenshot from Unity |

## Project Structure

```
unity-cursor-toolkit/
├── unity-cursor-toolkit/           # VS Code / Cursor extension (TypeScript)
│   └── src/
│       ├── extension.ts            # Entry point and composition root
│       ├── core/                   # Connection, transport, types, module loader
│       ├── console/                # Console bridge, panel, and MCP tools
│       ├── hot-reload/             # File watcher with debounce
│       ├── mcp/                    # MCP server, tool router, Unity tools
│       ├── debug/                  # Mono debug adapter
│       └── project/                # Project handler, meta manager, folder templates
├── Packages/
│   └── com.rankupgames.unity-cursor-toolkit/   # Unity UPM package (C#)
│       └── Editor/
│           ├── ConsoleToCursor.cs       # Console log forwarding
│           ├── HotReloadHandler.cs      # Asset refresh on code changes
│           ├── Core/                    # MCP tool attribute, interfaces
│           ├── Debug/                   # Mono debug bridge
│           ├── HotReload/              # IL patcher
│           └── MCP/                     # MCP bridge, scene/asset/editor tools
├── CursorUnityTool/                # Unity test project
├── zed/                            # Zed editor integration (MCP)
├── .github/workflows/              # CI and release pipelines
├── CONTRIBUTING.md
├── SECURITY.md
└── CODE_OF_CONDUCT.md
```

## Distribution

- **VS Code Marketplace** -- Primary distribution
- **OpenVSX** -- Windsurf, VSCodium, Theia
- **Cursor** -- Native support
- **Zed** -- Via MCP server (see `zed/`)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## Security

See [SECURITY.md](SECURITY.md) for vulnerability reporting.

## License

MIT License -- Copyright (c) 2025 Rank Up Games LLC. See [LICENSE](LICENSE) for details.
