# Changelog

All notable changes to the Unity Cursor Toolkit VS Code/Cursor extension are documented in this file.

## Unreleased

### Added

- Added the `unity_context` MCP tool for scanning, summarizing, querying, and reading `.umetacontext/index.json`.
- Added `game_command` support for `host: "editorBatchmode"` so non-rendering project-owned command workflows can run through Unity batchmode.
- Added the discoverable `editor_validation` MCP tool for project-file regeneration, compile requests, and pollable validation status.
- Added focused coverage for context indexing, batchmode command planning, and standalone MCP read-only behavior.

### Fixed

- Hardened TCP attach so open Unity-related ports must answer the toolkit `ping`/`pong` handshake before the extension marks them connected.
- Added a clearer attach failure message when an older Unity package exposes a port but does not support the required toolkit handshake.
- Kept editor validation results request-scoped and fail-closed when Unity cannot synchronize project files.
- Updated eligible transitive dev dependency resolutions for `hono` and `js-yaml` through npm's 7-day release-age gate.
- Updated `form-data` and `undici` transitive dev dependency resolutions under an approved security-hotfix age-gate bypass.

## [0.6.2041326] - 2026-05-09

### Added

- Added `out/mcp/server.js`, a standalone MCP stdio server for agents and editors that do not run VS Code extensions directly.
- Added MCP tool annotations, resources, prompts, read-only mode, dry-run previews, and client config snippet commands.
- Added runtime coverage for the standalone MCP server and agent safety behavior.

### Security

- Updated transitive development dependencies so `fast-uri` resolves to `3.1.2`, addressing the GitHub Advisory alert for percent-encoded path traversal and the related authority-delimiter advisory.
- Hardened `.meta` file resolution and console stack-trace file opening against path traversal.
- Replaced unsafe console webview script/style allowances with nonce-based CSP entries.
- Normalized malformed Unity console payloads before storing, filtering, copying, or forwarding them.

### Fixed

- Clearing the console from the webview now clears the backing bridge state used by MCP tools.
- `npm run validate` now compiles before running the runtime test harness, ensuring tests execute against fresh output.

### Tooling

- Added `check:unused` and `validate` scripts.
- Routed CI and release workflows through `npm run validate`.
- Excluded tests, backups, package locks, source maps, and generated bundles from packaged VSIX artifacts.
- Added regression coverage for traversal, CSP, malformed payloads, clear behavior, and MCP `.meta` validation.
