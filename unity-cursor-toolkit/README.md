# Unity Cursor Toolkit Extension

VS Code / Cursor extension for Unity hot reload, live console streaming, MCP tool routing, play mode controls, `.meta` resolution, Mono debugger attach support, and standalone MCP access for AI agents.

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

Inside VS Code/Cursor, run **Unity Toolkit: Copy MCP Client Config** to copy client snippets.

## Packaging

```bash
npx vsce package --no-dependencies
```

The generated VSIX includes only runtime extension assets: compiled `out/` files, metadata, icon, and license. Tests, backup files, lockfiles, source maps, and generated bundles are excluded through `.vscodeignore`.

## Security Notes

- Console webviews use nonce-based CSP for scripts and styles.
- Console payloads are normalized before they are stored, filtered, copied, or sent to chat.
- Clickable stack traces and `.meta` resolution reject paths that escape the active workspace.
- The standalone MCP server supports read-only mode and dry-run previews for mutating Unity tools.
- Dependency audits are part of `npm run validate` and the GitHub Actions workflows.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).
