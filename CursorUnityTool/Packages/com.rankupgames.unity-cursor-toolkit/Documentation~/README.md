# Unity Cursor Toolkit

Editor tools for Cursor/VS Code integration with Unity.

## Features

- **Hot Reload**: TCP server that triggers asset refresh when code changes are detected
- **Console Forwarding**: Streams Unity console output to Cursor/VS Code
- **MCP Bridge**: Model Context Protocol tool dispatch for AI-assisted Unity editing
- **Debug Bridge**: Broadcasts Mono soft debugger port for attach debugging
- **IL Patcher**: Runtime method body swapping during play mode (avoids domain reload)

## Installation

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

Add to your `Packages/manifest.json`:

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

## Requirements

- Unity 2019.4 or later
- Cursor or VS Code with the Unity Cursor Toolkit extension

## License

MIT - See LICENSE.md for details.
