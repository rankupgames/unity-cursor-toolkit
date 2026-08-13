# Unity 7 Readiness Plan

Last reviewed: 2026-08-13

Status: **planning and preparation**. Unity 7 compatibility is not yet a
shipped or validated product claim.

This document is the canonical summary for Unity 7 preparation. The detailed
research remains in `UNITY_7_LANDSCAPE_ASSESSMENT.md`,
`UNITY_CLI_AND_PIPELINE_ASSESSMENT.md`, and `OFFICIAL_MCP_OVERLAP.md`. The
implementation checklists live under `docs/tasks/`.

## Current Support Baseline

| Area | Current status | Evidence boundary |
| --- | --- | --- |
| Core Unity package | Declares Unity 2019.4 or later | Package metadata; this is not a per-version validation claim |
| VS Code/Cursor extension and standalone MCP server | Shipped | `npm run validate` and release CI |
| Bundled Unity-Unterm tools | Declares Unity 6000.3 or later on macOS and Windows | Local sample baseline is Unity 6000.3.9f1 on macOS; Windows proof is pending |
| Mono debugger and IL patch hot reload | Current legacy-runtime path | Must be gated before a CoreCLR-only Editor is claimed |
| Unity 6.8/CoreCLR | Preparation planned | WS1 through WS3 are not complete |
| Unity 7 | Target only | No compatibility claim until the gates below pass |

The repository declares a broad current baseline, but it does not yet have a
complete per-version certification matrix. “Declared,” “validated,” and
“Unity 7 ready” are separate states.

## Target Compatibility Model

| Editor family | Intended toolkit path | Readiness state |
| --- | --- | --- |
| Unity 2019.4 through 2022 LTS | Existing toolkit bridge, Mono debugger, and legacy hot reload | Declared range; preserve and add exact-version matrix evidence |
| Current Unity 6 releases | Existing bridge plus declared Unity-Unterm features | Unity 6000.3.9f1 macOS sample exists; expand exact-version and platform proof |
| CoreCLR transition releases | Capability-gated reload, lifecycle, and debugger behavior | Planned in WS1 through WS3 |
| Unity 7 previews and release | Same public agent interface with version-selected backends | Watch and validate; not yet claimed |

The target is one stable agent interface across Editor generations. Backend
selection must be explicit and capability-driven. The toolkit must not silently
substitute another Editor version or backend after a failure.

## Workstreams

1. **WS1 — CoreCLR package audit.** Remove or gate incompatible assembly,
   reload, static-state, and IL-patching paths. Add handshake capabilities.
2. **WS2 — CoreCLR Migration Assistant.** Scan user projects for transition
   risks and return documented replacements through the extension and MCP.
3. **WS3 — CoreCLR debugger.** Prove a permitted CoreCLR attach path for
   Cursor and other non-Microsoft clients while preserving Mono attach for
   older Editors.
4. **WS4 — Stable operations layer.** Keep public schemas compatible, expose
   backend origin, and compose toolkit and first-party surfaces without
   weakening read-only or dry-run policy.
5. **WS5 — Static-state detector.** Detect state that survives Fast Enter Play
   Mode and no-domain-reload transitions.
6. **WS6 — Test Runner bridge.** Provide one test schema across legacy bridge,
   standalone CLI, Pipeline, local, and remote execution paths.
7. **WS7 — Remote shell.** Protect the rendered-window and input-control path
   with per-version smoke tests and measured CoreCLR baselines.
8. **WS8 — Unity CLI, Pipeline, and Unity 7 watch.** Adopt pinned first-party
   backends where they are eligible and track only genuine Unity 7 deltas.

See [the task index](tasks/README.md) for dependencies and detailed acceptance
criteria.

## Readiness Gates

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

## Immediate Execution Order

1. Start WS1 inventory and capability detection.
2. Run the WS8 pinned CLI baseline and WS6 test parity spike in parallel.
3. Use WS1 evidence to start WS2 and the WS3 debugger feasibility spike.
4. Build the WS4 compatibility matrix and backend-origin model.
5. Add WS5 and WS7 version-specific smoke coverage.
6. Re-run the complete matrix for each material Unity 7 preview.

## Research and Claim Policy

The assessments contain dated external-product and roadmap snapshots. Recheck
those sources before implementation or marketing decisions. If current evidence
conflicts with an assessment, update the assessment and this summary together.
An unchecked task is not a shipped feature, and a passing compile is not a full
compatibility claim.
