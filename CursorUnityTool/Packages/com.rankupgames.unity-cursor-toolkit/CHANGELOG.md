# Changelog

All notable changes to this package will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-04-13

### Added

- Hot reload server with TCP connectivity and auto-reconnection
- Console forwarding from Unity to Cursor/VS Code
- MCP bridge with tool dispatch via reflection (MCPToolAttribute)
- MCP tools: manage_asset, manage_material, manage_scene, manage_gameobject, manage_component, editor_control, project_info
- Debug bridge for Mono soft debugger port broadcasting
- IL patcher for runtime method body swapping during play mode
- Assembly definition (Editor-only) for isolated compilation
