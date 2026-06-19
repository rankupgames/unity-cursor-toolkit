# Agent Prompt: macOS Closeout -- Live Installed-Cursor Proof On The Rebuilt Cursor

Copy everything below into a fresh AI agent session at the repo root (`unity-cursor-toolkit/`). This is a closeout sprint, not a research task: most of the system is proven; your job is to land the last macOS evidence on the freshly reinstalled Cursor and finish the docs.

---

## Mission and goal

The product goal is already working: Cursor renders the **real Unity editor Scene View and Game View** (plus Inspector, Package Manager, custom EditorWindows) in webview panels, backed by the user's own installed, licensed Unity editor running hidden (`host:"editor"`, `captureMode:"editorWindow"`), with a player-build Viewport Service as the no-editor lane. The fulfillment audit stands at 12 pass / 1 pending (Windows) / 0 fail.

Cursor was reinstalled today (now `3.7.2`, commit `1517f696d8ab6c53eb04fbfdaae705cd146bf3460`, arm64) because the previous install was broken. The automated live proof has not yet passed against the new install. Your goal, in order:

1. Get the automated installed-Cursor Scene/Game frame-hash proof to PASS on Cursor 3.7.2.
2. Archive a clean visual screenshot (the existing one is contaminated by a permission dialog).
3. Fold the already-captured E2 warm-run measurements into the docs.
4. Refresh the fulfillment audit and doc status so the only open gates are: Windows proof, opt-in cold-run, soak, and stretch experiment E7.

Read first: `docs/UNITY_WITHOUT_EDITOR_EXPERIMENTS.md` (status, results, section 3.1 workaround ladder, section 7 recommendation), `docs/prompts/unity-without-editor-agent-prompt.md` (guardrails -- they all still apply: licensed actions only, no EULA bypass, no secrets in the repo, AGENTS.md style, keep `npm run validate` green).

## Exact machine state (verified 2026-06-10 ~16:00 UTC)

- Unity `6000.3.9f1` at `/Applications/Unity/Hub/Editor/6000.3.9f1/`. **No Unity editor process is running**, but `CursorUnityTool/Temp/UnityLockfile` is **stale** (left by a killed proof run). Verify `pgrep -fl 'Unity.app/Contents/MacOS/Unity'` is empty, then remove the lockfile or pass `--force` to runners.
- Node 22 lives at `/opt/homebrew/opt/node@22/bin` (NOT in default non-login-shell PATH). Cursor CLI lives at `/Applications/Cursor.app/Contents/Resources/app/bin/cursor` -- verify `cursor` on PATH resolves THERE and not to a stale shim from the old install (`which -a cursor`). If you automate via `osascript do shell script`, export PATH explicitly; that shell is minimal.
- E2 warm artifacts already archived under `experiments/hidden-editor-cost-baseline/results/`:
  - run 1 (pre-existing): `...warm-spike-measure.json` -- launch-to-result `28.478s`, peak RSS `918.2 MB`.
  - run 2 (new): `...warm-spike2-measure.json` + `...warm-spike2-result.json` -- launch-to-result `20.061s`, peak RSS `1168.6 MB`, peak CPU `266.2%`, success true.
  - run 3 (new): `...warm-spike3-measure.json` + `...warm-spike3-result.json` -- spike GREEN (all five window captures non-blank, SceneView rotation changed `13.276` degrees). Read the measure JSON for its timing numbers; they are not yet in the docs.
- Two FAILED proof attempts are archived and must be kept as evidence, not deleted:
  - `experiments/installed-cursor-smoke/results/2026-06-10-live-rerun-smoke.json` -- failed at `cursor-version` (`cursor --version` hung 19s, empty output) because the OLD Cursor install was broken. Root cause resolved by the reinstall.
  - `experiments/installed-cursor-smoke/results/2026-06-10-live-rerun2-smoke.json` + `2026-06-10-live-rerun2-proof.json` -- ran on the NEW Cursor: extension `0.6.1052828` activated, both panels opened, but the proof froze at `connection.state:"connecting"` (no port) and the run FAILed at the 180s proof timeout. Unity was launched by the extension (hence the stale lockfile) but the bridge never answered. Logs: `/tmp/uct-live-rerun.log`, `/tmp/uct-live-rerun2.log`.
- Today's only Unity crash report is `~/Library/Logs/DiagnosticReports/Unity-2026-06-10-024221.ips` from 02:42 (last night's pre-clamp concurrent-stream crash, already documented). The spike launch/quit cycles look like crashes in the Dock but are normal.
- `remote_workspace/` contains only the example manifest -- the Windows remote lane cannot run from this Mac yet.

## Tasks, in order

### T0 -- Clean slate
Verify no Unity process, remove the stale `CursorUnityTool/Temp/UnityLockfile`, and clear old isolated profile dirs `/tmp/uct-live-rerun2-ud` / `/tmp/uct-live-rerun2-ext`. Never kill a Unity process without first checking it isn't a user session with unsaved work.

### T1 -- Diagnose rerun2, then pass the live proof (the core task)
Diagnose before rerunning: read `/tmp/uct-live-rerun2.log` fully and tail `~/Library/Logs/Unity/Editor.log` (the extension-launched editor writes there). Likely causes, in probability order:
1. First Unity launch after the E2 spike runs hit a longer import/compile than the 180s proof budget.
2. Port handshake: the extension requires a JSON `pong` (not just TCP connect) on `55500-55504`; check nothing else was squatting the ports (`lsof -nP -iTCP:55500-55504 -sTCP:LISTEN`).
3. Cursor 3.7.2 behavior change in extension activation or workspace trust for the temp proof workspace -- compare the rerun2 smoke JSON steps against the passing `2026-06-10-installed-editor-scene-game-auto-smoke.json`.

Then rerun with a longer budget:

```bash
cd /Users/dudetru25/GithubProjects/unity-cursor-toolkit
npm --prefix unity-cursor-toolkit run smoke:installed-cursor-viewports -- --open \
  --user-data-dir /tmp/uct-proof-c372-ud --extensions-dir /tmp/uct-proof-c372-ext \
  --out  experiments/installed-cursor-smoke/results/2026-06-10-cursor372-smoke.json \
  --viewport-proof-out experiments/installed-cursor-smoke/results/2026-06-10-cursor372-proof.json \
  --viewport-proof-timeout-ms 300000
```

(Adjust `--out` paths to absolute if the runner resolves them relative to `unity-cursor-toolkit/`.) Success = proof JSON `status:"pass"` with `connection.state:"connected"`, both panels `host:"editor"` / `captureMode:"editorWindow"`, live frame dimensions + SHA-256 hashes. If it fails the same way, fix the root cause (this proof passed earlier today on the old Cursor -- regressions live in environment, not architecture) and document the fix.

### T2 -- Clean visual screenshot
While the proof Cursor window is showing both panels streaming (use a `--viewport-proof-timeout-ms` long enough to give you a window, or reopen the panels afterward), capture directly to the repo:

```bash
screencapture -x /Users/dudetru25/GithubProjects/unity-cursor-toolkit/experiments/installed-cursor-smoke/screenshots/2026-06-10-cursor372-clean-scene-game.png
```

Open/inspect it: it must show both panels with live frames and NO dialogs/login sheets. Update `docs/UNITY_WITHOUT_EDITOR_EXPERIMENTS.md` to reference it as the primary visual evidence and note the older screenshot (permission dialog visible) is superseded.

### T3 -- E2 docs
In the E2 section of `docs/UNITY_WITHOUT_EDITOR_EXPERIMENTS.md`: add runs 2 and 3 with their numbers (artifacts listed above), declare the three-warm-run requirement satisfied, and update the "Remaining E2 work" list to exactly: (a) cold run -- **gated on explicit operator approval to delete `CursorUnityTool/Library`; never do this without a human yes in-session**; (b) clean-idle `measure:editor-stream --sample-only` after a fresh attach; (c) Windows spike run. Add one line each documenting the two failed proof runs and their causes (broken old Cursor CLI; post-reinstall first-proof timeout) so the evidence trail stays honest.

### T4 -- Audit + status refresh
Run `npm --prefix unity-cursor-toolkit run audit:unity-without-editor`, save the new result JSON, update the "Latest result" line and any fulfillment-table rows that changed (E2 row, visual-proof row, Cursor version references: the proof rows citing Cursor `3.6.31` should note the rerun on `3.7.2`). Expected: 12 pass / 1 pending (Windows) / 0 fail -- investigate anything worse.

### T5 -- Stretch (only if T0-T4 are green)
Run experiment **E7 (offscreen UI Toolkit re-host)** exactly per its spec in `docs/prompts/unity-without-editor-agent-prompt.md`, archiving results under `experiments/uitk-rehost/results/` and updating the section 3.1 workaround table row.

### Out of scope for this sprint
The Windows proof (needs the operator's Windows host; runner + import flow already exist), multi-window soak, and any new transport work. Do not start them; do not regress the editor lane.

## Done means

- Passing proof JSON + clean screenshot archived and referenced in the doc.
- E2 warm campaign documented as complete; remaining items precisely listed.
- Audit re-run and recorded; `npm --prefix unity-cursor-toolkit run validate` green.
- Both failed runs documented with causes. Commit style: `proof(cursor372): live installed-cursor scene/game proof on rebuilt cursor`.
