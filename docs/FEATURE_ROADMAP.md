# Feature Roadmap

Last reviewed: 2026-08-13

This roadmap separates shipped capabilities from planned work. Unity 7 is an
evidence-gated target. The canonical compatibility status and release gates are
in [Unity 7 Readiness](UNITY_7_READINESS.md).

## Shipped Foundations

- Standalone stdio MCP server for VS Code/Cursor, Claude Code, Zed, and other
  MCP clients.
- Stable additive tool schemas, resources, prompts, read-only mode, and dry-run
  previews.
- Live console and profiler sessions, compact transcripts, context indexing,
  safe `.meta` resolution, and project information.
- Runtime `game_command` workflows through an attached Editor or explicit
  editor-batchmode host.
- Scene, asset, component, material, play-mode, build, lifecycle, screenshot,
  and editor-validation tools.
- Native Unity copy action that overwrites one temporary main-camera screenshot
  and appends its absolute path to copied profiler/console context.
- Experimental hidden-editor, remote-shell, and viewport proof lanes.

## Unity 7 Preparation

| Priority | Work | Status | Plan |
| --- | --- | --- | --- |
| P0 | CoreCLR package and vendored-code audit | Ready to start | [WS1](tasks/WS1_CORECLR_AUDIT.md) |
| P0 | CoreCLR Migration Assistant | Planned; depends on WS1 | [WS2](tasks/WS2_MIGRATION_ASSISTANT.md) |
| P0 | CoreCLR debugger feasibility and integration | Spike pending; depends on WS1 | [WS3](tasks/WS3_CORECLR_DEBUGGER.md) |
| P0 | Version/capability matrix and backend-origin policy | Planning active | [WS4](tasks/WS4_MCP_REPOSITION_BACKCOMPAT.md) |
| P1 | Static-state detector for reload changes | Planned; depends on WS1 | [WS5](tasks/WS5_STATICS_DETECTOR.md) |
| P1 | Stable cross-version Test Runner bridge | Parity spike ready | [WS6](tasks/WS6_TEST_RUNNER_BRIDGE.md) |
| P1 | Remote rendered-shell productization | Experimental background work | [WS7](tasks/WS7_REMOTE_SHELL.md) |
| P0 | Pinned Unity CLI/Pipeline adoption and Unity 7 watch | Baseline ready; integration not shipped | [WS8](tasks/WS8_UNITY7_WATCH.md) |

No row in this table is a Unity 7 support claim. Each workstream has explicit
evidence and compatibility acceptance criteria.

## MCP and Product Direction

- Keep one stable public interface across legacy Unity, current Unity 6, the
  CoreCLR transition, and Unity 7.
- Report the selected backend, origin, Editor version, and capability set.
- Compose toolkit, Unity CLI, Pipeline, and Assistant surfaces only after their
  schemas and mutation boundaries are reviewed.
- Add origin-qualified names and aliases without removing current public
  arguments.
- Add richer structured results for builds, tests, profiler snapshots, package
  operations, and compatibility diagnostics.

## Unity Automation

- Prefab and selection tools with Undo-aware mutations.
- Test Runner list/run/progress/results through a stable cross-version schema.
- Build reports with warnings, failures, size deltas, and backend identity.
- Package Manager inspection and reviewed dependency preparation.
- CoreCLR migration reports and static-state transition diagnostics.
- Exact-version Editor/module resolution through a pinned CLI adapter where
  eligible, with no implicit upgrade or `latest` substitution.

## Remote and Rendered Workflows

- Per-version smoke tests for internal Editor-window capture and input paths.
- Measured CoreCLR hidden-editor and player-viewport baselines.
- Low-latency transport selection beyond the current debug path.
- One-command remote-shell preflight, launch, attach, and safe teardown.
- Fleet design only after the single-editor path and licensing model are proven.

## Safety and Trust

- Extend read-only mode to every new backend before write behavior is exposed.
- Keep `dryRun: true` on mutating tools and backend-selection plans.
- Never silently fall back to another Editor, host, or backend after failure.
- Prefer Unity Undo-backed edits for user-visible state.
- Label destructive operations and report exact targets.
- Validate paths and prevent credential, token, and machine-path leakage.
- Treat arbitrary code execution from any backend as a policy-escape risk.

## Near-Term Execution

1. WS1 CoreCLR inventory and capability handshake.
2. WS8 pinned CLI baseline and WS6 test parity spike in parallel.
3. WS2 rule set and WS3 debugger feasibility after the WS1 capability model.
4. WS4 compatibility matrix, documentation positioning, and backend policy.
5. WS5 static-state detection and WS7 per-version shell smoke evidence.
