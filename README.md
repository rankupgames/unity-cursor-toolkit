# Unity Cursor Toolkit

[![VS Code Marketplace](https://img.shields.io/badge/VS_Code_Marketplace-Install-007ACC?logo=visualstudiocode&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=rankupgames.unity-cursor-toolkit)
[![Open VSX](https://img.shields.io/open-vsx/v/rankupgames/unity-cursor-toolkit?label=Open%20VSX)](https://open-vsx.org/extension/rankupgames/unity-cursor-toolkit)
[![Open VSX Downloads](https://img.shields.io/open-vsx/dt/rankupgames/unity-cursor-toolkit?label=Open%20VSX%20Downloads)](https://open-vsx.org/extension/rankupgames/unity-cursor-toolkit)
[![CI](https://img.shields.io/github/actions/workflow/status/rankupgames/unity-cursor-toolkit/ci.yml?branch=main&label=CI)](https://github.com/rankupgames/unity-cursor-toolkit/actions)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://opensource.org/licenses/MIT)

Unity Cursor Toolkit connects VS Code, Cursor, and MCP agents to Unity. The
package targets Unity 2019.4 or later; the recorded Windows baseline is
6000.3.9f1. Unity 2019.4 parity remains blocked, and Unity 7/CoreCLR is readiness
work rather than general shipped support.

Use it for console and project context on local, remote, or virtual desktops,
with enforced MCP read-only and dry-run controls. The toolkit composes Unity's
first-party CLI where supported and keeps each backend explicit. Remote
streaming remains experimental; Pipeline production execution is pending.

## Disclaimer

This extension is not affiliated with, endorsed by, or an official product of Unity Technologies. Unity and the Unity logo are trademarks or registered trademarks of Unity Technologies or its affiliates in the U.S. and elsewhere.

## Features

### Hot Reload

Save-to-refresh with debounced file watching and compilation feedback in the status bar. IL patching supports play-mode method body updates on the compatible Mono path. CoreCLR capability checks refuse IL patching.

### Live Console

Real-time streaming, severity filtering, text search across messages and stack traces, safe clickable `Assets/...` stack traces, copy/export, send-to-AI-chat, and a bounded ring buffer (up to 1,000 entries). Console snapshots can include the current Unity profiler session so agents get logs, frame trends, hot frames, and hot paths together. The native Unity copy button also captures the visible main Unity Editor window to one stable temporary PNG, overwrites it on every click, and appends its absolute path to the copied context.

### Connection

TCP state machine with toolkit ping/pong validation, heartbeat, exponential backoff reconnect, and multi-port auto-select (55500-55504). Open ports that do not answer the Unity Cursor Toolkit handshake are ignored so the extension does not attach to unrelated Unity listeners.

### Status Bar

Two-part layout: one-click connect toggle plus quick-access dropdown with play mode controls, console snapshot, and project info.

### Play Mode Control

Enter, exit, pause, and single-frame step directly from VS Code / Cursor -- no need to switch to the Unity Editor.

### MCP Server

AI agents (Cursor, Claude Code, Copilot, Zed, and other MCP clients) can read console output, inspect project state, control play mode, manage scenes/assets, query project info, capture screenshots, inspect profiler snapshots, query a compact Unity context index, run game-authored command sequences, and use read-only or dry-run safeguards before mutating Unity state.

### Mono Debugger

Attach to the Unity Editor or a Development Player via the built-in Mono soft debugger (port 56000 default).

### Meta File Management

Auto-hide `.meta` files from explorer and Cmd+P, with workspace-contained on-demand resolve for AI workflows.

### Unity Package (C# side)

A companion UPM package (`com.rankupgames.unity-cursor-toolkit`) provides the Unity-side scripts: console forwarding, hot reload handler, MCP bridge, runtime command registry, debug bridge, and IL patcher. Installable via OpenUPM, Git URL, or scoped registry.

## Quick Start

1. Install the extension from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=rankupgames.unity-cursor-toolkit) or [OpenVSX](https://open-vsx.org/extension/rankupgames/unity-cursor-toolkit).
2. Install the Unity package (see [Unity Package Installation](#unity-package-installation)).
3. Open a Unity project folder in VS Code or Cursor.
4. Click **Unity Attach** in the status bar to connect.

## AI Agent Quick Start

The extension now builds a standalone MCP stdio server for agents that do not run VS Code extensions directly.

```bash
cd unity-cursor-toolkit
npm ci
npm run compile
npm run mcp:serve
```

Use **Unity Toolkit: Copy MCP Client Config** in VS Code/Cursor to copy setup snippets, or read [MCP Client Setup](docs/MCP_CLIENTS.md) for Cursor, Claude Code, VS Code Copilot Agent mode, and Zed examples.

Agent safety defaults:

- Set `UNITY_CURSOR_TOOLKIT_MCP_READ_ONLY=1` to block mutating tools.
- Pass `dryRun: true` to mutating tools to inspect the normalized Unity command without executing it.
- Start with `project_info`, `read_console`, and `manage_scene` using `action: "getHierarchy"` before scene or asset edits.
- Use `unity_context` with `action: "scan"` to refresh `.umetacontext/index.json`, then use `summary`, `query`, and `read` to inspect assets, GUIDs, serialized objects, components, and references without broad file reads.
- Use `game_command` with `action: "list"` to discover project-authored runtime workflows before scheduling them.

See the [documentation index](docs/README.md), [AI Agent Guide](docs/AI_AGENTS.md), [Runtime Game Commands](docs/GAME_COMMANDS.md), [Roadmap](docs/ROADMAP.md), and [llms.txt](llms.txt) for agent-facing context.

## Requirements

- VS Code or Cursor 1.60+
- Unity 2019.4+ as the declared core package baseline; see the evidence table
  below

## Unity Version Support and Unity 7 Readiness

The [capability matrix](docs/CAPABILITY_MATRIX.md) records exact observations,
not certification of an entire Editor family. The
[local compatibility runner](docs/UNITY_COMPATIBILITY.md) describes fixture
isolation and proof limits.

| Target | Recorded scope |
| --- | --- |
| Unity 2019.4 | Declared package minimum; real parity proof is user-blocked |
| Unity 2020-2022 LTS | Declared legacy range; no exact LTS candidate is configured, so it remains untested |
| Unity 6000.3.9f1, Windows | Isolated canonical-package activation, TCP handshake, console and standalone MCP checks passed |
| Other Unity 6 versions and macOS | Evidence is per exact version and operation; unrun matrix cells remain untested |
| Unity 7000.0.0a7, Windows/CoreCLR | Exact isolated checks passed as readiness preparation; no general Unity 7 support claim |

The fixture configures an available port and isolates its preferences.
Default-install listener activation is not proved by those checks.

### First-party backend composition

The current source stack includes a Unity CLI adapter, CLI Doctor, and an
explicitly selected test backend. Unity owns the CLI's build and test execution;
the toolkit adds transport, capability checks, policy, normalized results, and
owned-process cleanup. It does not replace the existing batchmode path.

Pipeline 0.8.0-exp.1 has an eligibility gate and disposable install, safety, and
composition experiments. Production Pipeline execution is still pending.
Source-stack additions are not a claim that an older published extension
contains them. See the dated [backend evidence](docs/UNITY_LANDSCAPE.md) and
[Unity 7 delta watch](docs/UNITY7_DELTA_WATCH.md).

### Migration and debugger status

The current source includes a [CoreCLR migration assistant](docs/AI_AGENTS.md#coreclr-migration-inspection)
that reports source review candidates and can inspect bounded static metadata.
It does not rewrite scripts or certify a migration.

| Runtime | Debugger position |
| --- | --- |
| Mono | Existing soft-debugger attach path for the Editor or Development Player |
| CoreCLR, exact 7000.0.0a7 | netcoredbg feasibility failed; shipping is blocked, with no verified breakpoint, step, or locals flow |

The [debugger experiment](experiments/coreclr-debug-probe/README.md) records the
failure. Runtime capability checks select supported paths; they do not add a
CoreCLR debugger. See the [roadmap](docs/ROADMAP.md) for remaining work.

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
  "com.rankupgames.unity-cursor-toolkit": "1.1.0"
}
```

## Runtime Game Commands

Unity projects can register runtime command sequences that agents can call through MCP without driving the UI. Commands are registered from game code through `UnityCursorToolkit.AgentCommands.AgentCommandRegistry`, run as coroutines during play mode, and are scheduled through the `game_command` MCP tool.

Typical flow:

```json
{ "action": "list" }
```

```json
{ "action": "run", "commandName": "auth.select_us_east", "args": {} }
```

Then poll with:

```json
{ "action": "status", "runId": "<run id returned by run>" }
```

See [Runtime Game Commands](docs/GAME_COMMANDS.md) for registration patterns and project integration notes.

For non-rendering command discovery and execution in CI or headless automation, pass `host: "editorBatchmode"`. The MCP server launches Unity with `UnityCursorToolkit.AgentCommands.BatchCommandEntry.Run`, writes structured arguments to a temp file, and returns the Unity log tail plus the command result JSON.

## Remote Unity Workflows

The experimental [remote shell](docs/REMOTE_SHELL.md) streams Editor or Player
surfaces from a host. See the [remote workspace](remote_workspace/README.md)
for setup and [Unity licensing guide](docs/LICENSING.md) for seats, build licenses,
BYOL, and operator approval before activation.

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `unityCursorToolkit.console.enabled` | `true` | Enable the Unity Console panel in the sidebar |
| `unityCursorToolkit.console.autoStream` | `true` | Auto-stream console output when connected |
| `unityCursorToolkit.console.maxEntries` | `1000` | Max entries in the console ring buffer |
| `unityCursorToolkit.hotReload.preferILPatch` | `true` | Prefer IL patching over full asset refresh in play mode |
| `unityCursorToolkit.hotReload.ilPatchTimeout` | `5000` | Timeout (ms) for IL patch before falling back to full refresh |
| `unityCursorToolkit.workspaceScanPaths` | `[]` | Additional paths to scan for `.code-workspace` files |

## Development and Validation

The extension package lives in `unity-cursor-toolkit/`.

```bash
cd unity-cursor-toolkit
npm ci
npm run validate
```

`npm run validate` is the canonical local and CI gate. It compiles the extension, runs a strict unused-code type check, executes the runtime test harness, and runs both production and full npm audits.

Dependency updates should use npm 11.14.1 or newer with the repository age gate, for example `npm update <package> --package-lock-only --ignore-scripts --min-release-age=7`. Prefer lockfile-scoped security fixes for transitive audit findings. If a fixed package is newer than 7 days, leave the advisory pending unless the update is explicitly approved as a security hotfix.

For packaging checks:

```bash
npx vsce package --no-dependencies
```

The VSIX package is intentionally limited to runtime extension assets: compiled `out/` files, metadata, icon, and license. Tests, backups, lockfiles, source maps, and generated bundles are excluded through `.vscodeignore`.

## Unity CLI Diagnostics

Run **Unity Toolkit: Unity CLI Doctor** (`unity-cursor-toolkit.doctor`) to check
the standalone first-party CLI. Set `unityCursorToolkit.unityCli.path` to its
native executable, or use `UNITY_CURSOR_TOOLKIT_UNITY_CLI_PATH` or `PATH`.
An explicit invalid path fails; the adapter does not select another installation.

The CLI status item reports the resolved version or **CLI not found**, separately
from the toolkit connection. The recorded pin is **1.0.0-beta.12**. A mismatch
shows expected and found versions; diagnostics can still run. The command reports
selected doctor checks and CLI version availability. It omits account
identifiers, authentication data, and recent logs.

Each call uses a direct argument array and complete JSON output, with a deadline.
Cancellation stops only the adapter-owned process tree. No Editor is installed,
upgraded, launched, or substituted by this diagnostic command. Existing MCP and
batchmode operations retain their current paths. This diagnostic backend does
not certify Unity 7 or enable Pipeline execution. See the
[recorded failure matrix](docs/UNITY_LANDSCAPE.md#adapter-failure-matrix).

## Security Hardening

- Dependency audits run through `npm run validate` and GitHub Actions.
- Dependency updates follow a 7-day npm release-age gate unless an explicit security hotfix exception is documented.
- TCP attach requires the current Unity package handshake; if Unity exposes an older package server, the extension reports that the package should be updated instead of treating the port as connected.
- Console webviews use nonce-based CSP for scripts and styles.
- Console payloads are normalized before rendering, filtering, copying, or forwarding to chat.
- Clickable stack traces and `.meta` resolution reject paths that escape the current workspace.

## Commands

| Command | Description |
|---------|-------------|
| `unity-cursor-toolkit.doctor` | Check the pinned standalone Unity CLI and selected diagnostics |
| `unity-cursor-toolkit.startConnection` | Start/Attach to a Unity project |
| `unity-cursor-toolkit.reloadConnection` | Reload the current connection |
| `unity-cursor-toolkit.stopConnection` | Stop the connection |
| `unity-cursor-toolkit.console.clear` | Clear the console panel |
| `unity-cursor-toolkit.console.sendToChat` | Send console output to AI chat |
| `unity-cursor-toolkit.console.copy` | Copy console/profiler context to the clipboard |
| `unity-cursor-toolkit.console.snapshot` | Take a console/profiler snapshot |
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
| `unity-cursor-toolkit.mcp.showServerPath` | Show the standalone MCP server path |
| `unity-cursor-toolkit.mcp.copyClientConfig` | Copy MCP client config snippets |

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
│       ├── Runtime/
│       │   └── AgentCommands/         # Runtime command registry and coroutine runner
│       └── Editor/
│           ├── ConsoleToCursor.cs       # Console log forwarding
│           ├── ProfilerSnapshot.cs      # Profiler session snapshots and MCP access
│           ├── HotReloadHandler.cs      # Asset refresh on code changes
│           ├── Core/                    # MCP tool attribute, interfaces
│           ├── Debug/                   # Mono debug bridge
│           ├── HotReload/              # IL patcher
│           └── MCP/                     # MCP bridge, scene/asset/editor tools
├── CursorUnityTool/                # Unity test project
├── zed/                            # Zed editor integration (MCP)
├── docs/                           # Product guides, Unity 7 readiness, research, and workstreams
├── AGENTS.md                       # Coding-agent repo instructions
├── llms.txt                        # AI-readable documentation index
├── .github/workflows/              # CI and release pipelines
├── CONTRIBUTING.md
├── SECURITY.md
└── CODE_OF_CONDUCT.md
```

## Distribution

- **VS Code Marketplace** -- Primary distribution
- **OpenVSX** -- Windsurf, VSCodium, Theia
- **Cursor** -- Native support
- **Zed** -- Via standalone MCP server (see `zed/`)

CI and release workflows publish separate VS Code Marketplace and OpenVSX VSIX artifacts. Publishing fails loudly when `VSCE_PAT` or `OVSX_PAT` repository secrets are missing, so a green release means both registry uploads were attempted with valid credentials.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for repository and extension changes. The Unity package changelog lives at [Packages/com.rankupgames.unity-cursor-toolkit/CHANGELOG.md](Packages/com.rankupgames.unity-cursor-toolkit/CHANGELOG.md).

## Security

See [SECURITY.md](SECURITY.md) for vulnerability reporting.

## License

MIT License -- Copyright (c) 2025 Rank Up Games LLC. See
[LICENSE](unity-cursor-toolkit/LICENSE) for details.
