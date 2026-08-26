# Roadmap

Last reviewed: 2026-08-26

This document separates shipped capabilities from planned work. Unity 7 and
CoreCLR are targets, not shipped claims. Unity 7 compatibility is in planning
and preparation.

Background research is in [UNITY_LANDSCAPE.md](UNITY_LANDSCAPE.md) and
[REMOTE_SHELL.md](REMOTE_SHELL.md).

## Shipped

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

## Support baseline

| Area | Current status | Evidence boundary |
| --- | --- | --- |
| Core Unity package | Declares Unity 2019.4 or later | Package metadata; this is not a per-version validation claim |
| VS Code/Cursor extension and standalone MCP server | Shipped | `npm run validate` and release CI |
| Bundled Unity-Unterm tools | Declares Unity 6000.3 or later on macOS and Windows | Local sample baseline is Unity 6000.3.9f1 on macOS; Windows proof is pending |
| Mono debugger and IL patch hot reload | Current legacy-runtime path | Must be gated before a CoreCLR-only Editor is claimed |
| Unity 6.8/CoreCLR | Preparation planned | The CoreCLR preparation work is not complete |
| Unity 7 | Target only | No compatibility claim until the gates below pass |

The repository declares a broad current baseline, but it does not yet have a
complete per-version certification matrix. "Declared," "validated," and
"Unity 7 ready" are separate states.

The target is one stable agent interface across Editor generations. Backend
selection must be explicit and capability-driven. The toolkit must not silently
substitute another Editor version or backend after a failure.

## Planned work

The detailed work is tracked as GitHub issues in this repository. See
<https://github.com/rankupgames/unity-cursor-toolkit/issues>.

- **CoreCLR package audit.** Remove or gate incompatible assembly, reload,
  static-state, and IL-patching paths. Add handshake capabilities.
- **CoreCLR migration assistant.** Scan user projects for transition risks and
  return documented replacements through the extension and MCP.
- **CoreCLR debugger.** Prove a permitted CoreCLR attach path for Cursor and
  other non-Microsoft clients. Keep Mono attach for older Editors.
- **Backend composition and safety.** Keep public schemas compatible, expose
  backend origin, and compose toolkit and first-party surfaces without
  weakening read-only or dry-run policy.
- **Static-state detector.** Detect state that survives Fast Enter Play Mode and
  no-domain-reload transitions.
- **Standalone Unity CLI and Pipeline.** Adopt pinned first-party backends where
  they are eligible and track only genuine Unity 7 deltas.
- **Test runner.** Provide one test schema across legacy bridge, standalone CLI,
  Pipeline, local, and remote execution paths.
- **Remote shell.** Protect the rendered-window and input-control path with
  per-version smoke tests and measured CoreCLR baselines.

None of these areas is a Unity 7 support claim. Each has explicit evidence and
compatibility acceptance criteria.

## Readiness gates

Unity 7 support can be advertised only after all applicable gates have recorded
evidence for an exact preview or release build:

- The package imports and compiles without unsupported API warnings.
- Connection handshake, console streaming, profiler capture, copy snapshot,
  play mode, screenshots, MCP discovery, and safe mutations pass.
- Hot reload selects a supported path and never uses incompatible IL loading.
- Debug attach selects Mono or CoreCLR from capabilities and passes breakpoint,
  stepping, and locals checks.
- Static state and reload lifecycle behavior have explicit cleanup tests.
- EditMode and PlayMode tests return structured results through the selected
  backend.
- CLI/Pipeline use exact versions, pinned dependencies, typed failures, bounded
  cancellation, and visible backend identity.
- Read-only mode and `dryRun` cannot be bypassed through any composed backend.
- The legacy 2019.4 and 2022 LTS smoke paths still pass.
- The README, package docs, Marketplace copy, `llms.txt`, and capability matrix
  match the recorded results.

## Safety and trust

- Extend read-only mode to every new backend before write behavior is exposed.
- Keep `dryRun: true` on mutating tools and backend-selection plans.
- Never silently fall back to another Editor, host, or backend after failure.
- Prefer Unity Undo-backed edits for user-visible state.
- Label destructive operations and report exact targets.
- Validate paths and prevent credential, token, and machine-path leakage.
- Treat arbitrary code execution from any backend as a policy-escape risk.

## Claim policy

Research notes contain dated external-product and roadmap snapshots. Recheck
those sources before implementation or marketing decisions. An open task is not
a shipped feature, and a passing compile is not a full compatibility claim.
