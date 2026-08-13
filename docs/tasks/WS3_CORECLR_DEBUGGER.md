# WS3 — CoreCLR Debugger for Cursor

Status: **Feasibility spike pending (P0)**

Last reviewed: 2026-08-13

Depends on: WS1 capability detection. No CoreCLR debugger is currently shipped.

Goal: prove and, if permitted, add a CoreCLR attach path while preserving the
Mono soft debugger for legacy Editors. Recheck debugger support and license
constraints against current primary sources before implementation.

Depends on: WS1 task 2 (capability handshake tells the extension which runtime is on the other end). Existing code: `unity-cursor-toolkit/src/debug/{debugAdapter,launchJsonGenerator,index}.ts` (Mono, port 56000).

## Tasks

- [ ] 1. **Feasibility spike.** Select an eligible CoreCLR Editor and player, record their exact versions and platform, then test a permitted DAP debugger. Confirm breakpoints, stepping, and locals; save findings and exact flags in `experiments/coreclr-debug-probe/results/`. This is the kill-or-commit gate for the workstream. (1-2 days.)
- [ ] 2. **Attach discovery.** Decide how the extension finds the target: PID via the toolkit handshake (`project_info` already knows the editor process) vs. process-name scan. Prefer handshake-provided PID. (Half day.)
- [ ] 3. **Binary acquisition.** Download per-platform netcoredbg release on first use (verify checksum, cache under extension global storage); no bundling in the VSIX. Offline: fail loud with manual-install docs. (1 day.)
- [ ] 4. **Debug adapter integration.** Register `unity-coreclr` debug type; `debugAdapter.ts` spawns netcoredbg in DAP mode and proxies; keep `unity-mono` type intact. (1-2 days.)
- [ ] 5. **launch.json generation.** `launchJsonGenerator.ts` emits Mono config for <= 6.5 projects, CoreCLR config for 6.8+, both when undetermined — keyed off `ProjectVersion.txt` + handshake capability. (Half day.)
- [ ] 6. **Editor-side prep.** Verify Code Optimization mode (Debug) requirement on CoreCLR editor; add a toolkit command/MCP action to flip it, mirroring the docs. (Half day.)
- [ ] 7. **Player debugging.** Extend attach to Development CoreCLR players once 6.7's experimental player stabilizes; document limits. (1 day; can trail the release.)
- [ ] 8. **Docs + matrix.** README debugger section becomes a version matrix (Mono <= 6.5 / CoreCLR >= 6.8); Cursor-specific setup walkthrough since that's the differentiator. (Half day.)

## Done when

In Cursor, on the recorded CoreCLR Editor: set a breakpoint in package code,
attach through the toolkit debug configuration, hit it, inspect locals, and
step. The recorded Mono legacy path must still pass unchanged.
