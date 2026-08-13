# WS6 — Test Runner Bridge

Status: **Standalone CLI parity spike ready (P1)**

Last reviewed: 2026-08-13

Depends on: WS8 CLI baseline for the typed backend. The unified test tools are
not currently shipped.

Goal: provide one stable test-orchestration surface in VS Code/Cursor and MCP
across legacy and current Unity versions. Reuse the standalone CLI's
`unity test` path on Unity 6+ where parity is proven; implement only the gaps
needed for legacy Editors, progress streaming, remote targeting, richer results,
and toolkit safety policy.

Existing plumbing to reuse: connection/command bridge
(`Packages/com.rankupgames.unity-cursor-toolkit/Editor/MCP/MCPBridge.cs`,
`unity-cursor-toolkit/src/core/commandSender.ts`) and batch-mode path
(`unity-cursor-toolkit/src/mcp/gameCommandBatchmode.ts` as the pattern).

New first-party input: `unity test` runs Edit Mode and Play Mode tests in Editor
batch mode, supports filters, Editor selection, NUnit XML output and timeouts,
and returns CLI operation-failed exit code `6` for test failures. See
`docs/UNITY_CLI_AND_PIPELINE_ASSESSMENT.md`.

## Tasks

- [ ] 1. **Standalone CLI parity spike.** Install a pinned verified CLI and run
  list/filter/EditMode/PlayMode/failure/timeout cases through `unity test` on a
  Unity 6 project. Capture stdout, stderr, NUnit shape, JSON/NDJSON behavior,
  exit codes, cancellation, and progress visibility. Produce a measured gap
  table before writing a second launcher. (1 day.)
- [ ] 2. **Typed CLI adapter path.** Add test invocation through the WS8
  `UnityCliAdapter`: argument arrays without a shell, explicit output format,
  bounded timeout, structured exit mapping, and no credential/path leakage.
  Reject missing exact Editor or module state. (1 day.)
- [ ] 3. **Legacy/streaming TestRunnerApi path.** Wrap
  `UnityEditor.TestTools.TestRunner.Api.TestRunnerApi` only for Editors the CLI
  path cannot support or for proven capabilities it lacks: list tests, stream
  progress, run filters, and collect structured status/duration/message/stack.
  (1-2 days.)
- [ ] 4. **Unified protocol and MCP schema.** Expose stable `list_tests` and
  `run_tests` requests independent of backend. Include selected backend and
  Editor version in results. `dryRun` resolves the selection without running;
  read-only mode allows listing and blocks stateful PlayMode runs unless the
  policy explicitly admits them. (1 day.)
- [ ] 5. **Remote and interactive execution.** Route to an explicitly selected
  local CLI, connected Pipeline Editor, toolkit bridge, or remote host based on
  advertised capabilities. Never silently switch backends after failure.
  Stream long-running progress so PlayMode jobs do not look hung. (1 day.)
- [ ] 6. **VS Code surface.** Command palette entry + results in an output
  channel/simple tree; full Test Explorer API integration deferred until
  demand. (1 day.)
- [ ] 7. **Negative and compatibility matrix.** Cover missing CLI, wrong/missing
  Editor, locked project, no discovered tests, malformed NUnit, test failure,
  timeout, cancellation, PlayMode policy refusal, and legacy/Unity 6 parity.
  Record exact counts and skipped suites. (1 day.)
- [ ] 8. **Docs.** `docs/AI_AGENTS.md` section: agent loop = edit -> filtered
  `run_tests` -> read failures -> fix, including backend reporting and dry-run
  guidance. (Half day.)

## Done when

An agent over MCP can list tests, run a filtered EditMode subset headlessly,
receive structured pass/fail with stack traces, and see which backend/Editor ran
it. A PlayMode run streams progress and completes. Unity 6 CLI and legacy
bridge paths satisfy the same public schema without silent backend fallback.
