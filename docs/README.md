# Documentation

This directory contains the user guides, roadmap, research notes, and experiment
records for Unity Cursor Toolkit.

## Product Guides

- [AI agent guide](AI_AGENTS.md)
- [MCP client setup](MCP_CLIENTS.md)
- [Runtime game commands](GAME_COMMANDS.md)

## Roadmap and Research

- [Roadmap](ROADMAP.md) — shipped capabilities, support baseline, planned
  work, and Unity 7 readiness gates
- [Unity landscape research](UNITY_LANDSCAPE.md) — dated Unity 7, CoreCLR,
  standalone CLI, Pipeline, and Assistant MCP research
- [Remote shell](REMOTE_SHELL.md) — streaming architecture, editor-window
  capture, no-editor experiments, and recorded results

Planned work is tracked as
[GitHub issues](https://github.com/rankupgames/unity-cursor-toolkit/issues).

Unity 7 is a planned, evidence-gated target. The package currently declares
Unity 2019.4 or later for its core features. The bundled Unity-Unterm features
require Unity 6000.3 or later on macOS or Windows. Do not treat a roadmap item,
research note, or open issue as proof of Unity 7 support.

## Status Language

- **Shipped**: present in released code and covered by current validation.
- **Declared**: named in package metadata or documentation; this is not proof.
- **Validated**: supported by recorded evidence on the named Editor/platform.
- **Planned**: designed but not implemented or proven.
- **Pending** or **Unverified**: required evidence does not exist yet.
- **Watch**: re-evaluate when a material Unity preview or release changes the
  assumptions.
- **Historical evidence**: a dated test or incident record that must not be
  promoted to a current support claim.

Every compatibility claim must name the Editor version and evidence. General
phrases such as “Unity 7 ready” must not be used until the readiness gates pass.
