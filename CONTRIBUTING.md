# Contributing to Unity Cursor Toolkit

Thank you for your interest in contributing. Please follow these guidelines.

## Dev Setup

```bash
git clone <repo-url>
cd unity-cursor-toolkit
cd unity-cursor-toolkit
npm ci
npm run validate
```

The first `cd unity-cursor-toolkit` enters the repository root. The second enters the VS Code/Cursor extension package.

## Branch Naming

- `feature/<name>` — New features
- `fix/<name>` — Bug fixes
- `chore/<name>` — Maintenance, docs, tooling

## PR Process

1. Fork the repository
2. Create a branch from `Version-*` or `main`
3. Implement your changes
4. Test locally (see Testing below)
5. Open a PR against the appropriate base branch

## Testing

- `npm run validate` must pass before opening a PR
- `npm run validate` runs compile, strict unused-code checks, runtime tests, and npm audits
- `npx vsce package --no-dependencies` should pass for extension packaging changes
- Test against a Unity project with the extension installed
- Verify hot reload, console panel, and connection behavior as relevant

## Unity Scripts

Changes to `unity-assets/` C# files must:

- Compile in Unity 2019+
- Wrap editor-only code in `#if UNITY_EDITOR` / `#endif`

## Code Style

- TypeScript strict mode
- Tabs for indentation
- Prefer typed boundaries for webview, MCP, and Unity payloads
- Validate filesystem paths before reading or writing user/workspace-provided paths
- Keep extension package artifacts lean; do not ship tests, backups, lockfiles, source maps, or generated bundles in the VSIX
