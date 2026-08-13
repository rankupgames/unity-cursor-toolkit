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

- Preserve the package's declared Unity 2019.4 baseline
- Wrap editor-only code in `#if UNITY_EDITOR` / `#endif`

The declared baseline is not a tested compatibility claim. Record the exact
Unity Editor version and platform for each proof run. For CoreCLR or Unity 7
work, update `docs/UNITY_7_READINESS.md`, the affected file under `docs/tasks/`,
and public compatibility wording together.

## Documentation Status

- Use the status terms in `docs/README.md`.
- Keep both package documentation mirrors byte-identical.
- Do not advertise Unity 7 or CoreCLR support until the readiness gates have
  exact-version evidence.
- Keep research and experiment results dated. Recheck external product facts
  before using them for implementation or marketing.

## Code Style

- TypeScript strict mode
- Tabs for indentation
- Prefer typed boundaries for webview, MCP, and Unity payloads
- Validate filesystem paths before reading or writing user/workspace-provided paths
- Keep extension package artifacts lean; do not ship tests, backups, lockfiles, source maps, or generated bundles in the VSIX
