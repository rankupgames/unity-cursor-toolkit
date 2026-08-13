# WS4 — MCP Ops-Layer Reposition + Backwards-Compat Product Line

Status: **Planning active; compatibility and composition evidence pending (P0)**

Last reviewed: 2026-08-13

Depends on: WS1 capability detection and WS8 backend captures. The Unity 7
version span is a target, not a current certification.

Goal: stop competing with official Unity automation on tool count; win on
version span, remote deployment, rendered viewport/shell, structured context,
and enforceable safety policy. Evaluate composition of first-party automation
and the toolkit bridge behind one explicit capability model. The target is one
agent interface from the declared 2019.4 baseline through validated future
Unity versions; the headline must name only the matrix that has passed.

Depends on: WS1 task 2 (capability handshake). Existing code:
`unity-cursor-toolkit/src/mcp/*` and
`Packages/com.rankupgames.unity-cursor-toolkit/Editor/MCP/*` (mirrored in the
sample Unity project package copy).

## Tasks

- [ ] 1. **Three-surface overlap analysis.** Preserve the dated Assistant MCP
  capture, then enumerate standalone `unity` CLI and `com.unity.pipeline`
  commands separately. Classify every overlapping capability by origin,
  minimum Editor, transport, headless/live behavior, and mutation risk. Inputs:
  `docs/OFFICIAL_MCP_OVERLAP.md` and
  `docs/UNITY_CLI_AND_PIPELINE_ASSESSMENT.md`. (1 day.)
- [ ] 2. **Capability matrix doc.** Feature x Unity-version table (2019.4 / 2020-2022 LTS / 6.0-6.5 / 6.8+ / U7) generated from the handshake capability set — becomes README + marketplace content and the CI matrix definition. (Half day.)
- [ ] 3. **Version-gated feature detection tidy-up.** Extension consumes handshake capabilities everywhere it currently assumes (hot reload mode, debugger type, reload semantics); one code path per capability, no version sniffing scattered around. (1 day.)
- [ ] 4. **Official-surface composition spikes.** Evaluate Assistant relay and
  Pipeline composition separately. For Pipeline, prefer documented `unity`
  CLI JSON/NDJSON and exit codes; for both origins, attach source metadata,
  classify schemas by hand, and block/isolate arbitrary C# execution in
  read-only sessions. Kill-or-commit each path independently. (2 days.)
- [ ] 5. **CI compatibility matrix.** GitHub Actions jobs, or local runner scripts where licenses constrain CI, exercise package activation, handshake, and console/MCP smoke on the declared baseline, a legacy LTS Editor, the current sample baseline, and the exact CoreCLR Editor selected by WS1. (1-2 days.)
- [ ] 6. **Repositioning pass.** README, marketplace listing, `llms.txt`,
  `docs/AI_AGENTS.md`: lead with version span, remote/virtualized workflows,
  safety policy, and composition. Do not claim generic local headless builds or
  tests as unique now that `unity build/run/test` exist. Fold in WS2 task 8
  marketing. No feature-count comparisons. (1 day.)
- [ ] 7. **Catalog namespace and policy design.** Define stable origin-qualified
  names/aliases for toolkit, Pipeline, and Assistant tools; resolve collisions;
  preserve existing public schemas; and prove read-only mode cannot be bypassed
  through `eval`, `eval_file`, or `Unity_RunCommand`. (1 day.)
- [ ] 8. **Legacy-LTS outreach content (optional).** Short doc/post targeting
  studios pinned on 2020-2022 LTS: official Assistant/Pipeline live-Editor
  command catalogs require Unity 6+, while the toolkit supplies its own
  agent-control, streaming, and safety surface for legacy LTS. Do not claim the
  standalone CLI cannot manage an older Editor without version-matrix proof.
  (Half day; marketing judgment call.)

## Done when

Marketplace listing and README lead with the safety/version-span/remote story;
CI proves the span; Assistant and Pipeline composition decisions are made with
separate spike evidence; origin-qualified catalogs cannot weaken read-only mode.
