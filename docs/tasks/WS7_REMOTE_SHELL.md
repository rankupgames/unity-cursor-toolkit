# WS7 — Remote Shell Productization

Status: **Experimental background work (P1)**

Last reviewed: 2026-08-13

Support impact: proof lanes exist, but Unity 7 and production remote-shell
compatibility are not validated.

Goal: move the virtualized shell from experiment to a supported product. The
dated first-party inventory does not replace the rendered-window and input
plane, but that comparison must be rechecked before positioning claims.
Governing docs: `docs/UNITY_WITHOUT_EDITOR_EXPERIMENTS.md`,
`docs/REMOTE_UNITY_STREAMING.md`, `docs/EDITOR_WINDOW_STREAMING_PLAN.md`.
Existing code: `src/remote-shell/`, `src/viewport/`, `experiments/*`.

Steady-background pace; each task independently valuable.

## Tasks

- [ ] 1. **Internal-API smoke tests.** Automated per-version check that `GUIView.GrabPixels` + `SendEvent` reflection paths still resolve and produce frames; wire into the WS4 CI matrix so a Unity release breaking W0 is caught the week it ships, not by users. (1 day.)
- [ ] 2. **Re-baseline E2 on CoreCLR.** Re-run the hidden-editor cost baseline (time-to-first-frame, RSS, and idle/streaming CPU) on the exact CoreCLR Editor selected by WS1; update `experiments/hidden-editor-cost-baseline/results/`. Measure the result without assuming an improvement. (1 day.)
- [ ] 3. **Player viewport on a CoreCLR player.** Validate the E3 player viewport service against an eligible exact-version CoreCLR desktop player and record deltas. (1 day.)
- [ ] 4. **Transport plan v1.** Design doc + spike replacing MJPEG debug path with a real low-latency transport (H.264/WebCodecs or equivalent); decide encoder strategy per platform. Spike only — pick, measure latency, write down the decision. (2 days.)
- [ ] 5. **Launch UX hardening.** `remote-shell init/launch` manifest flow: clearer errors, preflight checks (SSH reachability, sidecar version, license state), and a doctor command. (1-2 days.)
- [ ] 6. **W0 hidden-editor attach UX.** One command from VS Code/Cursor: auto-launch hidden licensed editor for the open project, stream target window, teardown on disconnect. The M3 plan from `EDITOR_WINDOW_STREAMING_PLAN.md` broken to its own checklist when started. (Multi-day; split before starting.)
- [ ] 7. **Licensing/BYOL doc.** User-facing doc of the W0-W4 licensing posture (own seat, BYOL for remote hosts, licensing-server lane for fleets) distilled from the experiments doc; flag the "counsel before hosted-for-third-parties" caveat. (Half day.)
- [ ] 8. **Fleet design doc (later).** Editor fleet orchestration (N leased hidden/remote editors, validation-farm workflow) — design only, after task 6 ships. Gate: do not build before single-editor UX is solid. (1 day design.)

## Done when

CI guards the reflection paths across the version matrix; CoreCLR baselines are recorded; a user can go from workspace to streamed hidden-editor window with one command on macOS.
