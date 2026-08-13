# WS8 — Standalone Unity CLI + Pipeline Adoption and Unity 7 Watch

Status: **Baseline and parity work ready; adapter and composition not shipped (P0)**

Last reviewed: 2026-08-13

Support impact: the dated CLI/Pipeline assessment is research input, not an
enabled production backend.

Goal: adopt the standalone Unity CLI and `com.unity.pipeline` now, make the
toolkit the safest version-spanning client of those first-party surfaces, and
keep only Unity 7-specific deltas in watch status.

The 2026-08-07 assessment found enough information to start a pinned baseline;
it did not prove a production backend. That dated snapshot recorded `unity`
`1.0.0-beta.3` and Pipeline documentation for `com.unity.pipeline`
`0.4.0-exp.1`. Recheck availability, version requirements, and package age
before installation. Canonical inventory, security analysis, WIA snapshot, and setup plan:
`docs/UNITY_CLI_AND_PIPELINE_ASSESSMENT.md`.

Depends on: WS1 task 2 for project capability detection. Feeds WS4 official
surface composition and WS6 test orchestration.

## Tasks

- [ ] 1. **Pinned CLI baseline.** Install the standalone CLI through an
  approved distribution method; record exact version, channel, checksum or
  package-manager identity, and publication date. Run `unity --version`,
  `unity doctor`, `unity env --format json`, `unity editors -i --format json`,
  and `unity auth status`. Do not modify a Unity project in this task. (Half day.)
- [ ] 2. **CLI contract capture.** Save `unity --help` plus help for `editors`,
  `open`, `build`, `run`, `test`, `pipeline`, `command`, `list`, `status`, and
  `mcp`. Capture human/TSV/JSON/NDJSON output and documented exit-code behavior.
  Treat installed help as authority for the beta. (Half day.)
- [ ] 3. **Editor and project resolution proof.** Against an isolated sample and
  WIA, prove `ProjectVersion.txt` selects the exact Editor, modules are checked
  per installation, and non-interactive missing-Editor/module cases fail
  closed. Do not permit an implicit upgrade or `latest` substitution. (Half day.)
- [ ] 4. **Local test/build/run parity.** Run one filtered Edit Mode test, one
  Play Mode test, one non-signing development build, and one registered
  headless command. Record logs, structured results, exit codes, interruption,
  timeout, dirty-worktree behavior, and what project-specific build steps are
  not covered. Coordinate the test matrix with WS6. (1 day.)
- [ ] 5. **`UnityCliAdapter`.** Implement a TypeScript adapter that invokes the
  binary without a shell, passes argument arrays, selects JSON/NDJSON
  explicitly, separates stdout/stderr, maps exit codes to typed results, and
  applies bounded cancellation. Add CLI version/presence to doctor/status.
  Do not hardcode Editor installation paths. (1-2 days.)
- [ ] 6. **Pipeline package eligibility gate.** Query available versions and
  registry publication timestamps; select a version at least seven days old,
  pin it, and document the approval. Reject unsupported pre-Unity-6 projects
  before package mutation. (Half day.)
- [ ] 7. **Isolated Pipeline install.** In a disposable project or reviewed
  branch, run `unity pipeline install --package-version <pinned>`, review the
  manifest/lock diff, wait for compilation, and prove `pipeline list`,
  `status`, `list`, and `command editor_status`. Record package/reload impact.
  (1 day.)
- [ ] 8. **Pipeline safety matrix.** Prove loopback-only binding, bearer-token
  discovery, multi-Editor project targeting, `dry_run`/`confirm`, Undo, and
  authoring-root constraints. Classify every advertised command as read-only,
  mutating, destructive, or policy-escape; isolate `eval`/`eval_file`, package
  changes, deletion, build, and project-setting mutation. (1 day.)
- [ ] 9. **Pipeline adapter and MCP composition.** Add explicit Pipeline command
  discovery/execution behind toolkit policy. Decide with evidence whether to
  compose `unity mcp` as a child process or invoke `unity command` directly.
  Origin-qualify tools, preserve public aliases, and prove toolkit read-only
  mode cannot be bypassed. Coordinate with WS4. (1-2 days.)
- [ ] 10. **WIA integration cleanup.** Replace hardcoded Editor discovery in the
  WIA test runner with declared-version/CLI resolution; remove sibling/clone
  generation of missing SpacetimeDB bindings in favor of the explicit portable
  artifact and fail-closed error. Preserve custom CIBuilder behavior for data,
  Addressables, Odin AOT, variants, signing, and build profiles. (1 day.)
- [ ] 11. **Compatibility and failure matrix.** Cover CLI absent, wrong version,
  missing Editor, missing module, auth failure, Pipeline absent/unsupported,
  multiple Editors, locked project, compile/test/build failure, malformed
  output, timeout, cancellation, and read-only policy refusal across legacy,
  2022 LTS, current Unity 6, and preview Unity. (1-2 days.)
- [ ] 12. **Docs and positioning.** Update README, marketplace copy,
  `docs/AI_AGENTS.md`, and `llms.txt` with installation, backend status,
  capability matrix, security boundaries, and recovery. Present CLI/Pipeline
  as composed first-party backends, not toolkit-owned inventions. (1 day.)
- [ ] 13. **Unity 7 delta watch.** Track only features not present in the current
  CLI/Pipeline releases: new Unity 7 commands/APIs, CoreCLR-only behavior,
  production-pipeline services, and editor-fleet primitives. Re-run WS4 overlap
  and this workstream's matrices on each material beta. (Ongoing.)
- [ ] 14. **Fleet design follow-on.** After single-project local/remote
  integration is stable, design leased Editor instances, licensing, scheduling,
  and validation-farm orchestration. Design only until a measured user need and
  supported licensing model exist. (Later.)

## Done when

The toolkit reports and uses a pinned standalone CLI without hardcoded Editor
paths; resolves exact project Editors and modules; runs structured build/test
jobs; safely discovers and invokes a pinned Pipeline package on Unity 6+; keeps
legacy projects on an explicit supported backend; and exposes a composed MCP
catalog whose origin and mutation policy are unambiguous. Unity 7 watch notes
then contain only genuine deltas beyond this shipped baseline.
