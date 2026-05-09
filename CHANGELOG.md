# Changelog

All notable repository and VS Code/Cursor extension changes are documented in this file.

The Unity UPM package has its own changelog at `Packages/com.rankupgames.unity-cursor-toolkit/CHANGELOG.md`.

## [0.6.2041326] - 2026-05-09

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
- Added regression tests for path traversal, CSP hardening, malformed console payloads, console clear behavior, and MCP `.meta` input validation.
