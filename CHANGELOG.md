# Changelog

All notable repository and VS Code/Cursor extension changes are documented in this file.

The Unity UPM package has its own changelog at `Packages/com.rankupgames.unity-cursor-toolkit/CHANGELOG.md`.

## [0.6.1052826] - 2026-05-28

### Added

- Added the `game_command` MCP tool for listing, scheduling, polling, and canceling game-authored runtime command sequences.
- Added runtime command registration docs for Unity projects that want MCP-callable gameplay workflows without UI automation.

### Changed

- Bumped the UPM package to `1.1.0` for the runtime command registry API.
- Updated CI and release workflows to publish separate VS Code Marketplace and OpenVSX artifacts and fail when registry tokens are missing.

## [0.6.2041326] - 2026-05-09

### Added

- Added a standalone MCP stdio server for Cursor, Claude Code, VS Code Copilot Agent mode, Zed, and other MCP clients.
- Added MCP resources, prompts, tool annotations, read-only mode, and dry-run previews for safer agent workflows.
- Added AI-ready documentation: `AGENTS.md`, `llms.txt`, `docs/AI_AGENTS.md`, `docs/MCP_CLIENTS.md`, and `docs/FEATURE_ROADMAP.md`.

### Security

- Updated transitive development dependencies so `fast-uri` resolves to `3.1.2`, addressing the GitHub Advisory alert for percent-encoded path traversal and the related authority-delimiter advisory.
- Hardened Unity `.meta` file resolution so user-provided asset paths must resolve inside the active workspace before any filesystem read occurs.
- Hardened console stack-trace file links so only safe `Assets/...` paths can be opened from the webview.
- Replaced the console webview's inline script/style policy with nonce-based Content Security Policy entries.
- Normalized malformed Unity console payloads before storing, filtering, copying, or forwarding them to chat.

### Fixed

- Fixed console panel clear behavior so clearing from the webview also clears the backing console bridge used by MCP tools.
- Fixed validation drift by making `npm run validate` compile before running the runtime test harness.

### Tooling

- Added `npm run check:unused` and `npm run validate`.
- Routed CI and release workflows through `npm run validate` so compile, strict unused-code checks, runtime tests, and npm audits all run the same way locally and in GitHub Actions.
- Updated VSIX packaging ignores so test files, backup files, package locks, source maps, and generated bundles are not shipped in extension artifacts.
- Added runtime tests for MCP server initialization, tool/resource/prompt discovery, read-only blocking, dry-run behavior, and client config snippets.
- Added regression tests for path traversal, CSP hardening, malformed console payloads, console clear behavior, and MCP `.meta` input validation.
