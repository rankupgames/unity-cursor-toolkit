# 2026-06-10 Claude Desktop Unity Mass-Spawn Incident Report

## Summary

On Wednesday, June 10, 2026, Claude Desktop Local Agent Mode repeatedly launched Unity Cursor Toolkit proof and spike commands for `/Users/dudetru25/GithubProjects/unity-cursor-toolkit`. The runs opened full Unity editor sessions and an isolated Cursor proof workspace. The Cursor viewport proof became stuck waiting for editor Scene/Game frames, and the launch path did not have a cross-process per-project guard. The result was a large number of Unity-related processes, mostly Unity helper processes such as `UnityPackageManager`, in addition to editor, Hub, licensing, compiler, and Cursor helper processes.

The incident was caused by Claude Desktop automation and unsafe launcher behavior in the toolkit proof flow. No evidence was found of a separate actor or unrelated process starting Unity.

## Impact

- Local machine process table filled with Unity, Unity Hub, Unity helper, and isolated Cursor processes.
- Unity and Unity Hub had to be killed manually on the local machine.
- The stuck proof consumed system resources and created user-visible process churn.
- The repo had additional generated/log artifacts from the failed and overlapping proof runs.

## Primary Evidence

- Claude Desktop local agent session:
  - Local session: `local_2e23fedd-7c1a-488f-85db-03e038c428b5`
  - CLI session: `6695cd33-0d7e-4acc-88c5-ffa5176b87ef`
  - Session storage path: `/Users/dudetru25/Library/Application Support/Claude/local-agent-mode-sessions/f14f29c7-39ff-4a12-a4f6-f2255395a2d2/43199283-49fd-4c4b-b57d-ee8d7a06d038/local_2e23fedd-7c1a-488f-85db-03e038c428b5/audit.jsonl`
- Claude launched background shell commands through `mcp__Control_your_Mac__osascript`.
- The key backgrounded commands used `nohup ... &`, which let child processes keep running even after Claude's tool call failed or the local session stopped.
- Stuck Cursor proof result:
  - `/Users/dudetru25/GithubProjects/unity-cursor-toolkit/experiments/installed-cursor-smoke/results/2026-06-10-live-rerun2-proof.json`
  - Last inspected state showed `status: "running"`, `connection.state: "connecting"`, and Scene/Game panels still preparing streams.
- Smoke report:
  - `/Users/dudetru25/GithubProjects/unity-cursor-toolkit/experiments/installed-cursor-smoke/results/2026-06-10-live-rerun2-smoke.json`
  - Finished at `2026-06-10T15:54:33Z` with a timeout waiting for the proof JSON, while the isolated Cursor proof later continued updating state.
- Hidden Unity editor log:
  - `/var/folders/79/yw359m415p1gg2g8dl_tkky40000gn/T/unity-cursor-toolkit-hidden-editor-CursorUnityTool.log`
  - Contained repeated Unity command-line blocks, repeated `UnityPackageManager` launches, licensing handshake failures, an `ObjectDisposedException`, and a long initial asset refresh before the bridge became available.

## Timeline

- `2026-06-10 11:44:41 EDT`: Claude inspected running Unity processes and project locks.
- `2026-06-10 11:45:29 EDT`: Claude launched `smoke:installed-cursor-viewports --open` through `nohup`.
- `2026-06-10 11:47:49 EDT`: Claude launched `spike:editor-windows --hide --measure --timeout 420` through `nohup`.
- `2026-06-10 11:49:23 EDT`: Claude launched another `spike:editor-windows` run through `nohup`.
- `2026-06-10 11:49:46 EDT`: The third editor-window spike produced a successful result, but Unity was still in the process of quitting and cleaning up.
- `2026-06-10 11:51:26 EDT`: Claude launched a second `smoke:installed-cursor-viewports --open` proof through `nohup`.
- `2026-06-10 11:54:33 EDT`: The smoke runner timed out waiting for proof output, but did not close the isolated Cursor proof process tree.
- `2026-06-10 11:58:42 EDT`: The proof JSON was still `running` and `connecting`.
- `2026-06-10 11:59:17 EDT`: Hidden Unity editor log shows another editor startup attempt writing to the shared hidden editor log.
- `2026-06-10 12:00:08 EDT`: Hidden Unity editor finished loading scene data after a long import/compile period, then Unity Hub was launched during shutdown/cleanup.

## Root Cause

The direct trigger was Claude Desktop Local Agent Mode repeatedly launching long-running toolkit commands in the background:

- `npm --prefix unity-cursor-toolkit run spike:editor-windows -- --hide --measure --timeout 420 ...`
- `npm --prefix unity-cursor-toolkit run smoke:installed-cursor-viewports -- --open ... --viewport-proof-out ...`

The toolkit allowed this to become a mass-spawn condition because:

1. The installed Cursor proof opened an isolated Cursor workspace and did not reliably clean it up on timeout or failure.
2. The proof loop retried Scene/Game panel opens while still disconnected.
3. The extension had `unityCursorToolkit.autoLaunchEditor` enabled by default.
4. The extension launch guard only protected the immediate in-process spawn promise, not the full Unity bridge boot window.
5. There was no cross-process per-project launch lock, so separate Claude/Node/Cursor processes could attempt hidden Unity launches for the same project.
6. Unity full editor startup fans out into many helper processes, so a small number of overlapping editor launches can appear as dozens of Unity-related processes.

## Why It Looked Like More Than 40 Unity Instances

The process list likely contained a mix of:

- Full Unity editor processes.
- Unity Hub.
- `UnityPackageManager` helpers.
- `UnityShaderCompiler`.
- Unity licensing helpers.
- Unity crash/logging helpers.
- Cursor helper processes from isolated proof profiles.

So the count was probably not 40 full editor windows. It was the combined fan-out of multiple overlapping full editor launches plus their helper process trees.

## Fix Implemented

The prevention patch was implemented after the investigation, without opening Unity.

Changed files:

- `/Users/dudetru25/GithubProjects/unity-cursor-toolkit/unity-cursor-toolkit/src/core/unityEditorLauncher.ts`
  - Added an atomic per-project hidden-editor launch lock in the temp directory.
  - Added refusal to launch another hidden editor when the Unity project `Temp/UnityLockfile` exists.
  - Added stale lock handling with a 10-minute default TTL and PID checks.
- `/Users/dudetru25/GithubProjects/unity-cursor-toolkit/unity-cursor-toolkit/src/extension.ts`
  - Added a single active connection attempt across the full 90-second bridge boot wait.
- `/Users/dudetru25/GithubProjects/unity-cursor-toolkit/unity-cursor-toolkit/src/viewport/index.ts`
  - Throttled automated proof panel reopen attempts to every 5 seconds.
- `/Users/dudetru25/GithubProjects/unity-cursor-toolkit/unity-cursor-toolkit/scripts/smoke-installed-cursor-viewports.js`
  - Added isolated Cursor cleanup after proof pass, failure, or timeout.
  - Added `--keep-open` as an explicit escape hatch for manual inspection.
- `/Users/dudetru25/GithubProjects/unity-cursor-toolkit/unity-cursor-toolkit/test/run-tests.js`
  - Added regression coverage for project-lock refusal and cross-process launch-lock behavior.

## Verification Completed

The following checks completed successfully on June 10, 2026:

- `npm run compile`
- `node test/run-tests.js`
- `npm test`
- `node scripts/smoke-installed-cursor-viewports.js --dry-run --viewport-proof-out /tmp/uct-safe-proof-dry-run.json --out /tmp/uct-safe-smoke-dry-run.json --user-data-dir /tmp/uct-safe-smoke-ud --extensions-dir /tmp/uct-safe-smoke-ext`
- `pgrep -afil '/Applications/Unity/Hub/Editor|/Applications/Unity Hub.app|UnityPackageManager|UnityShaderCompiler|UnityLicensingClient|UnityCrashHandler'` returned no running Unity, Unity Hub, or Unity helper processes after verification.

Unity was not opened during the fix or verification.

## Current Safety State

- Unity and Unity Hub are no longer globally denied for explicit future requests.
- Agents should still avoid opening Unity automatically unless the user explicitly asks for it or a scoped task requires it.
- If a proof command opens an isolated Cursor workspace, it now attempts to clean up that isolated Cursor process tree unless `--keep-open` is passed.
- Hidden Unity auto-launch now has both an in-process connection guard and a cross-process per-project lock.

## Remaining Notes

- This report documents local incident evidence and the implemented local repo fix. It is not deployment or package readiness proof.
- The repo was already dirty with Claude-generated Unity/toolkit work before this report and prevention patch. This report does not attempt to classify or clean unrelated generated files.
