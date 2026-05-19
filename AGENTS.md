# Agent Instructions

This repository contains the Unity Cursor Toolkit: a VS Code/Cursor extension in `unity-cursor-toolkit/` and a Unity UPM package in `Packages/com.rankupgames.unity-cursor-toolkit/`.

## Working Rules

- Prefer small, surgical edits that match the existing TypeScript and Unity C# style.
- Do not edit generated build output in `unity-cursor-toolkit/out/`, `out-bundle/`, `.vsix` files, Unity `Library/`, `Temp/`, `Obj/`, or package artifacts.
- Keep the standalone MCP server free of `vscode` imports. It must run as `node unity-cursor-toolkit/out/mcp/server.js` from any MCP client.
- Treat Unity project mutations as sensitive. Use `dryRun: true` first for scene, asset, material, build, play mode, menu, and batch operations when planning changes.
- Keep public MCP tool schemas backward compatible. Add aliases rather than removing existing argument names.

## Validation

Run from `unity-cursor-toolkit/`:

```bash
npm run validate
```

For workflow edits, also run from the repo root:

```bash
npx --yes github-actionlint .github/workflows/ci.yml .github/workflows/release.yml
```

For packaging smoke tests:

```bash
cd unity-cursor-toolkit
npx vsce package --no-dependencies --out /tmp/unity-cursor-toolkit-smoke.vsix
```

## Architecture Notes

- Extension entrypoint: `unity-cursor-toolkit/src/extension.ts`
- Core TCP bridge: `unity-cursor-toolkit/src/core/connection.ts`
- Standalone MCP server: `unity-cursor-toolkit/src/mcp/server.ts`
- Shared MCP tool metadata and safety hints: `unity-cursor-toolkit/src/mcp/toolMetadata.ts`
- Unity-side MCP bridge: `Packages/com.rankupgames.unity-cursor-toolkit/Editor/MCP/`

Agents should read `docs/AI_AGENTS.md` and `docs/MCP_CLIENTS.md` before changing MCP behavior.
