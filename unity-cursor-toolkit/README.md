# Unity Cursor Toolkit Extension

VS Code / Cursor extension for Unity hot reload, live console streaming, MCP tool routing, play mode controls, `.meta` resolution, and Mono debugger attach support.

## Development

```bash
npm ci
npm run validate
```

`npm run validate` compiles the extension, runs the strict unused-code type check, executes the runtime test harness, and runs both production and full npm audits.

## Packaging

```bash
npx vsce package --no-dependencies
```

The generated VSIX includes only runtime extension assets: compiled `out/` files, metadata, icon, and license. Tests, backup files, lockfiles, source maps, and generated bundles are excluded through `.vscodeignore`.

## Security Notes

- Console webviews use nonce-based CSP for scripts and styles.
- Console payloads are normalized before they are stored, filtered, copied, or sent to chat.
- Clickable stack traces and `.meta` resolution reject paths that escape the active workspace.
- Dependency audits are part of `npm run validate` and the GitHub Actions workflows.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).
