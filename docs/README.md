# Documentation

This directory contains the current user guides, architecture notes, research
snapshots, experiments, and implementation workstreams for Unity Cursor
Toolkit.

## Product Guides

- [AI agent guide](AI_AGENTS.md)
- [MCP client setup](MCP_CLIENTS.md)
- [Runtime game commands](GAME_COMMANDS.md)
- [Feature roadmap](FEATURE_ROADMAP.md)
- [Remote Unity streaming](REMOTE_UNITY_STREAMING.md)

## Unity 7 Readiness

- [Unity 7 readiness plan](UNITY_7_READINESS.md) — canonical public status,
  compatibility targets, gates, and execution order
- [Unity 6.6 to Unity 7 landscape assessment](UNITY_7_LANDSCAPE_ASSESSMENT.md)
  — dated research and product analysis
- [Unity CLI and Pipeline assessment](UNITY_CLI_AND_PIPELINE_ASSESSMENT.md) —
  dated first-party automation inventory and adoption plan
- [Official Unity MCP overlap](OFFICIAL_MCP_OVERLAP.md) — dated capability
  capture and positioning analysis
- [Workstream task index](tasks/README.md) — WS1 through WS8 execution plans

Unity 7 is a planned, evidence-gated target. The package currently declares
Unity 2019.4 or later for its core features. The bundled Unity-Unterm features
require Unity 6000.3 or later on macOS or Windows. Do not treat a roadmap item,
assessment, or unchecked workstream task as proof of Unity 7 support.

## Experiments and Operations

- [Unity without Editor experiments](UNITY_WITHOUT_EDITOR_EXPERIMENTS.md)
- [Editor window streaming plan](EDITOR_WINDOW_STREAMING_PLAN.md)
- [Remote Unity streaming](REMOTE_UNITY_STREAMING.md)
- `docs/prompts/` contains reproducible proof prompts.
- Incident reports record past failures and their safeguards. They are not
  current setup guides.

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
