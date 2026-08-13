# Workstream Task Index (Unity 6.6 to Unity 7)

Last reviewed: 2026-08-13

These are committed implementation plans. An unchecked task is not a shipped
feature or support claim. Canonical public status and compatibility gates:
`docs/UNITY_7_READINESS.md`. Source assessments:
`docs/UNITY_7_LANDSCAPE_ASSESSMENT.md` and
`docs/UNITY_CLI_AND_PIPELINE_ASSESSMENT.md` (updated 2026-08-07). Each
workstream doc breaks the offer into small tasks sized for a single focused
session; tasks are ordered so each leaves the repo shippable.

| # | Workstream | Doc | Impact/Effort/Urgency | Status |
| --- | --- | --- | --- | --- |
| WS1 | CoreCLR package audit + fixes | `WS1_CORECLR_AUDIT.md` | 7/2/9 | Ready to start (P0) |
| WS2 | CoreCLR Migration Assistant | `WS2_MIGRATION_ASSISTANT.md` | 9/4/9 | Planned; blocked by WS1 |
| WS3 | CoreCLR debugger for Cursor | `WS3_CORECLR_DEBUGGER.md` | 9/6/8 | Feasibility spike pending |
| WS4 | MCP ops-layer reposition + backwards compat | `WS4_MCP_REPOSITION_BACKCOMPAT.md` | 8/4/7 | Planning active; evidence pending |
| WS5 | Statics-bug detector (Fast Enter Play Mode) | `WS5_STATICS_DETECTOR.md` | 7/3/8 | Planned; blocked by WS1 |
| WS6 | Test runner bridge | `WS6_TEST_RUNNER_BRIDGE.md` | 6/4/5 | CLI parity spike ready |
| WS7 | Remote shell productization | `WS7_REMOTE_SHELL.md` | 9/8/5 | Experimental background work |
| WS8 | Standalone Unity CLI + Pipeline adoption; Unity 7 delta watch | `WS8_UNITY7_WATCH.md` | 8/5/8 | Baseline ready; adapter not shipped |

Recommended execution order: WS1 -> WS2 -> WS3, with WS4 and the WS8
baseline/parity spikes in parallel; then WS5 and the WS6 gap implementation;
WS7 continues as steady background work. Unity 7-specific WS8 delta checks stay
event-driven, but standalone CLI/Pipeline adoption is active now.

Cross-cutting dependencies: WS1 task 2 (version/capability detection) is used by
WS2, WS3, WS4, WS5, and WS8 backend selection. WS8's `UnityCliAdapter` and
Pipeline capability capture inform WS4 composition and WS6 test execution.

When a task starts, attach exact Editor/package/CLI versions and evidence paths.
Update this index and `docs/UNITY_7_READINESS.md` when a status changes.
