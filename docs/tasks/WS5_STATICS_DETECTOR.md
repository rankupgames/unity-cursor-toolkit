# WS5 — Statics-Bug Detector (Fast Enter Play Mode)

Status: **Planned; blocked by WS1 capability detection (P1)**

Last reviewed: 2026-08-13

Support impact: no static-state detector is currently shipped.

Goal: detect static state carried across play-mode and runtime transitions.
Recheck the exact Unity transition behavior against the selected Editor before
implementation. Output: “these N statics carried state into play mode.”

Depends on: WS1 task 2 (capability gate; on eligible CoreCLR Editors this also
acts as a no-domain-reload staleness detector). Complements WS2 task 5 (static
inventory).

## Tasks

- [ ] 1. **Snapshotter (Unity side).** Reflection scan of static fields in user assemblies (assembly allowlist; skip Unity/system) capturing a cheap fingerprint per field (hash of value / count for collections / null-ness). Opt-in via toolkit settings. (1-2 days.)
- [ ] 2. **Transition hooks.** Capture on `ExitingEditMode` / `EnteredPlayMode` / `ExitingPlayMode` / `EnteredEditMode`; diff consecutive snapshots; classify carried vs reset. (1 day.)
- [ ] 3. **Perf guardrails.** Budget cap (max fields/time per snapshot), incremental scan, and hard off-switch; measure overhead on CursorUnityTool and record numbers. Fail closed: over budget -> skip snapshot + warn, never stall play mode. (1 day.)
- [ ] 4. **Report surface.** Findings into the live console stream as structured warnings + a "Statics Report" view in the console panel (field, declaring type, transition, before/after fingerprint). (1 day.)
- [ ] 5. **MCP tool.** `statics_report` (read-only): latest diff as JSON so agents can chase heisenbugs. Register in both extension and standalone servers. (Half day.)
- [ ] 6. **Docs.** Short guide: enabling FEPM safely, reading the report, common fixes (`[RuntimeInitializeOnLoadMethod]` resets; on 6.8+, `[AutoStaticsCleanup]`). (Half day.)

## Done when

A deliberately-buggy sample static in CursorUnityTool is flagged on the first play-mode round trip with FEPM on, with overhead numbers recorded and the MCP tool returning the same finding.
