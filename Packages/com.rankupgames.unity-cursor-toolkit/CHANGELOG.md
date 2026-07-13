# Changelog

All notable changes to this package will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- Added `BatchCommandEntry` for `game_command` editor batchmode list/run support.
- Added command catalog capability metadata for the editor batchmode host.
- Added the `editor_validation` MCP tool and menu command for project-file regeneration plus script compile requests.
- Added the audited Unity-Unterm fork as a toolkit-internal terminal, Claude Code, code editor, completion, and debugger feature for Unity 6000.3 on macOS and Windows.
- Added Unity-Unterm launch aliases under `Tools > Unity Cursor Toolkit > Unterm`.

### Security

- Unity-Unterm MCP access is disabled by default and uses local, uncommitted current-project policies; arbitrary C# requires a separate full-machine-access opt-in, and unclassified tools never auto-run.
- Vendored source, managed assemblies, and native plugins are pinned to an attested fork commit and verified by SHA-256.

### Fixed

- Declared the built-in JSON serialization module required by runtime game-command argument parsing.
- Added immediate TCP `ping`/`pong` handling so the extension can verify it attached to a current Unity Cursor Toolkit package.
- Preserved Unity-Unterm tab icons across live title changes and reduced idle texture, resize, file, and diff polling work.

## [1.1.0] - 2026-05-28

### Added

- Added the runtime `UnityCursorToolkit.AgentCommands` assembly with `AgentCommandRegistry`, `AgentCommandRunner`, and status/result contracts for game-authored MCP workflows.
- Added the editor-side `game_command` MCP adapter with `list`, `run`, `status`, and `cancel` actions.
- Added runtime game command documentation and project integration guidance.

### Fixed

- Avoided aborting the hot reload TCP thread during editor assembly reload; the handler now requests shutdown and reports a warning when the thread is still alive.

## [1.0.0] - 2026-04-13

### Documentation

- Clarified the companion VS Code/Cursor extension validation workflow and security hardening expectations.
- Documented that repository and companion extension changes are tracked in the repository root changelog.
- Documented standalone MCP client setup, AI agent workflows, read-only mode, and dry-run previews.

### Added

- Hot reload server with TCP connectivity and auto-reconnection
- Console forwarding from Unity to Cursor/VS Code
- MCP bridge with tool dispatch via reflection (MCPToolAttribute)
- MCP tools: manage_asset, manage_material, manage_scene, manage_gameobject, manage_component, editor_control, project_info
- Debug bridge for Mono soft debugger port broadcasting
- IL patcher for runtime method body swapping during play mode
- Assembly definition (Editor-only) for isolated compilation
