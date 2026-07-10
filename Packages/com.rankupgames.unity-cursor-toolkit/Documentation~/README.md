# Unity Cursor Toolkit

Editor tools for Cursor/VS Code and MCP-capable AI agents integrating with Unity.

## Features

- **Hot Reload**: TCP server that triggers asset refresh when code changes are detected
- **Console Forwarding**: Streams Unity console output to Cursor/VS Code
- **MCP Bridge**: Model Context Protocol tool dispatch for AI-assisted Unity editing
- **Editor Validation**: Regenerates Unity project files and requests script compilation from Cursor/VS Code
- **Runtime Game Commands**: Project-owned coroutine workflows callable through MCP without UI automation
- **Debug Bridge**: Broadcasts Mono soft debugger port for attach debugging
- **IL Patcher**: Runtime method body swapping during play mode (avoids domain reload)
- **Agent Safety**: Supports read-only MCP sessions and dry-run previews from the companion extension

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
  "com.rankupgames.unity-cursor-toolkit": "1.1.0"
}
```

## Requirements

- Unity 2019.4 or later
- Cursor or VS Code with the Unity Cursor Toolkit extension

## Companion Extension Validation

The VS Code/Cursor companion extension is maintained in the repository's `unity-cursor-toolkit/` folder.

```bash
cd unity-cursor-toolkit
npm ci
npm run validate
```

`npm run validate` compiles the extension, runs strict unused-code checks, executes the runtime test harness, and runs dependency audits.

## AI Agent Usage

The companion extension builds a standalone MCP stdio server at `unity-cursor-toolkit/out/mcp/server.js`. MCP clients can launch it with Node to access the Unity-side tools provided by this package.

Recommended agent flow:

1. Open the Unity project in Unity with this package installed.
2. Start the companion MCP server from an MCP client.
3. Inspect with `project_info`, `read_console`, and `manage_scene` using `action: "getHierarchy"`.
4. Use `profiler_snapshot` with `action: "current"`, then `action: "readConsoleTranscript"` with the captured session id when an agent needs the compact grouped whole-console timeline.
5. Use `editor_validation` with `action: "sync_and_compile"` after file generation changes, then poll `action: "status"` until the result is no longer pending.
6. Use `game_command` with `action: "list"` to discover project-owned runtime workflows.
7. Use `dryRun: true` before mutating assets, scenes, GameObjects, components, play mode, menus, or builds.

Set `UNITY_CURSOR_TOOLKIT_MCP_READ_ONLY=1` for agent sessions that should inspect Unity without changing Editor state.

## Runtime Game Commands

Game code can register deterministic play-mode sequences through `UnityCursorToolkit.AgentCommands.AgentCommandRegistry`. The companion MCP tool is `game_command` with `list`, `run`, `status`, and `cancel` actions.

```csharp
AgentCommandRegistry.Register(
	"auth.select_us_east",
	"Selects the US East server through the game's server selection handler.",
	SelectUsEastServer);
```

Commands run on Unity's main thread as coroutines. They should call existing game subsystem methods, wait for completion, then report `context.Succeed(...)` or `context.Fail(...)`.

See the repository docs:

- `docs/AI_AGENTS.md`
- `docs/GAME_COMMANDS.md`
- `docs/MCP_CLIENTS.md`
- `docs/FEATURE_ROADMAP.md`

## Editor Validation

The MCP tool `editor_validation` supports `list`, `status`, `sync_project_files`, `request_compile`, and `sync_and_compile`. `request_compile` leaves project files unchanged; `sync_and_compile` fails without requesting compilation when Unity cannot provide a project-file synchronization API.

`sync_and_compile` regenerates project files using Unity's active code editor integration, requests script compilation, and writes the latest pollable result to `TestResults/UnityCursorToolkit/EditorValidation/latest.json` under the Unity project root. The same action is available inside Unity at **Tools > Unity Cursor Toolkit > Validation > Regenerate Project Files And Compile**.

## Security Notes

- The companion extension validates Unity/MCP/webview payloads before using them.
- `.meta` resolution and clickable console stack traces are constrained to workspace-safe paths.
- Console webviews use nonce-based Content Security Policy entries for scripts and styles.
- MCP tools expose read-only/destructive annotations for clients that surface tool approval context.
- Packaged VSIX artifacts exclude tests, backups, lockfiles, source maps, and generated bundles.

## Changelog

See `CHANGELOG.md` for Unity package changes. Repository and companion extension changes are documented in the repository root `CHANGELOG.md`.

## License

MIT - See LICENSE.md for details.
