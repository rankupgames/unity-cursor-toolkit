# Unity Cursor Toolkit Extension

[![VS Code Marketplace](https://img.shields.io/badge/VS_Code_Marketplace-Install-007ACC?logo=visualstudiocode&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=rankupgames.unity-cursor-toolkit)
[![Open VSX](https://img.shields.io/open-vsx/v/rankupgames/unity-cursor-toolkit?label=Open%20VSX)](https://open-vsx.org/extension/rankupgames/unity-cursor-toolkit)

Unity Cursor Toolkit connects VS Code, Cursor, and MCP agents to Unity console,
profiler, project, and runtime context. The package targets Unity 2019.4+; the
recorded Windows baseline is exact 6000.3.9f1. Use local, remote, or virtual
desktop workflows with enforced MCP read-only/dry-run policy and explicit
first-party backend composition. Remote streaming is experimental.

## Current Support and Unity 7

- Unity 6000.3.9f1 on Windows passed isolated canonical-package activation,
  TCP handshake, console, and standalone MCP checks. The fixture uses a free
  port and isolated preferences; default-install listener activation is unproved.
- Unity 2019.4 parity is user-blocked. Legacy LTS versions without an exact
  configured candidate, other versions, and other platforms remain untested.
- Exact 7000.0.0a7/CoreCLR checks are readiness preparation, not general shipped
  Unity 7 support.
- Bundled Unity-Unterm declares Unity 6000.3+ on macOS or Windows; that minimum
  is separate from the core package target and exact test evidence.

## Backend, Migration, and Debugger Status

The current source includes Unity CLI Doctor and an explicitly selected CLI
test backend. Unity owns CLI execution; the toolkit adds capability checks,
policy, transport, and normalized results. Pipeline eligibility and disposable
composition proofs exist, but production Pipeline execution is pending.
These source-stack additions do not imply availability in older published
extensions.

The CoreCLR migration assistant reports source review candidates and optional
bounded static metadata. It does not rewrite scripts or certify a migration.

| Runtime | Debugger position |
| --- | --- |
| Mono | Existing Editor/Development Player soft-debugger adapter |
| CoreCLR, exact 7000.0.0a7 | Feasibility failed; shipping blocked, with no verified breakpoint, step, or locals flow |

Read the [repository documentation](https://github.com/rankupgames/unity-cursor-toolkit#readme)
for the capability matrix, compatibility proof limits, backend experiments,
migration guide, and Unity 7 delta watch.

## Development

```bash
npm ci
npm run validate
```

`npm run validate` compiles the extension, runs the strict unused-code type check, executes the runtime test harness, and runs both production and full npm audits.

## Standalone MCP Server

Build and run the agent-facing stdio server:

```bash
npm run compile
npm run mcp:serve
```

The compiled entrypoint is `out/mcp/server.js`. It can be launched by Cursor, Claude Code, VS Code Copilot Agent mode, Zed, or any MCP client that supports stdio servers.

Useful environment variables:

- `UNITY_CURSOR_TOOLKIT_MCP_READ_ONLY=1` blocks mutating tools.
- `UNITY_CURSOR_TOOLKIT_PROJECT_PATH=/path/to/unity/project` sets the project root for `.meta` resolution.
- `UNITY_CURSOR_TOOLKIT_MCP_PORTS=55500,55501,55502,55503,55504` overrides the Unity TCP port scan.
- `UNITY_CURSOR_TOOLKIT_UNITY_PATH=/path/to/Unity` optionally sets the executable used by `game_command` with `host: "editorBatchmode"`.

Inside VS Code/Cursor, run **Unity Toolkit: Copy MCP Client Config** to copy client snippets.

Use the `game_command` MCP tool to list, schedule, poll, or cancel runtime workflows registered by the Unity project through the UPM package's `UnityCursorToolkit.AgentCommands` API.

Use the `unity_context` MCP tool to refresh `.umetacontext/index.json` with `action: "scan"`, then inspect compact project context with `summary`, `query`, and `read`.

The Unity toolbar copy action builds compact profiler and console context,
captures the visible main Unity Editor window, overwrites one stable PNG in
`Application.temporaryCachePath`, and appends the absolute image path to the
clipboard text.

## Packaging

```bash
npx vsce package --no-dependencies
```

The generated VSIX includes only runtime extension assets: compiled `out/` files, metadata, icon, and license. Tests, backup files, lockfiles, source maps, and generated bundles are excluded through `.vscodeignore`.

GitHub Actions builds separate VS Code Marketplace and OpenVSX artifacts. Publish jobs require both `VSCE_PAT` and `OVSX_PAT`; missing registry tokens fail the workflow instead of silently skipping an upload.

## Security Notes

- Console webviews use nonce-based CSP for scripts and styles.
- Console payloads are normalized before they are stored, filtered, copied, or sent to chat.
- Clickable stack traces and `.meta` resolution reject paths that escape the active workspace.
- TCP attach requires the Unity package to answer the toolkit ping/pong handshake; update `com.rankupgames.unity-cursor-toolkit` if Unity is running but attach reports an older package.
- The standalone MCP server supports read-only mode and dry-run previews for mutating Unity tools.
- Dependency audits are part of `npm run validate` and the GitHub Actions workflows.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).
