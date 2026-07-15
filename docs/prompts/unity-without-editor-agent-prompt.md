# Agent Prompt: "Unity Without The Editor" Experiment Series

Copy everything below into a fresh AI coding agent session opened at the repo root (`unity-cursor-toolkit/`, branch `feat/simplified-context-engine` or its successor).

---

## Mission

You are executing the experiment series defined in `docs/UNITY_WITHOUT_EDITOR_EXPERIMENTS.md` for the Unity Cursor Toolkit. The product goal: Cursor/VS Code panels that render Unity viewports (Scene View, Game View, Inspector, Package Manager, custom EditorWindows) **without the user ever seeing or manually running the Unity editor**, eventually over the network from a deployed instance. Your job is to (1) empirically settle whether any rendering is possible with no editor process at all, (2) measure the cost of the hidden-editor alternative, (3) build the player-based "Viewport Service" that renders with no editor seat, and (4) automate licensing so every editor instance we start is properly activated with the org's own entitlements.

Work experiment by experiment. Each one ends with committed artifacts and an updated results section. Do not start a later experiment while an earlier one's report is unwritten.

## Non-negotiable guardrails

1. **Licensed actions only.** Never patch, spoof, proxy, hook, or bypass Unity license checks; never extract or redistribute the native engine; never bind/forge internal-call tables to make editor assemblies execute outside the official editor binary. If an experiment's only path forward is one of those, the experiment's correct result is "nonviable" -- write that down and stop.
2. License activation uses only official flows: CLI activation (`-username/-password/-serial`), manual `.ulf` files (`-createManualActivationFile` / `-manualLicenseFile`), Unity Licensing Server (floating), or Build Server seats. Credentials come from env vars (`UNITY_EMAIL`, `UNITY_PASSWORD`, `UNITY_SERIAL`); never commit secrets, never echo them into logs, and never write them into `remote_workspace/*.json` that is not gitignored.
3. Reflection-only inspection of DLLs installed by a licensed editor on this machine is allowed and expected (that is experiment E1).
4. A clean-room facade binding shell is allowed: our own DTOs, TypeScript types, protocol schemas, and helper APIs that *forward* to official editor/player adapters. Do not ship Unity-derived stub assemblies, generated API clones from Unity DLL metadata, or a fake `UnityEditor` runtime.
5. Follow `AGENTS.md`: surgical edits, match existing TS/C# style (tabs, file header comments, explicit braces), never edit `out/`, `out-bundle/`, `*.vsix`, Unity `Library/`, `Temp/`, `obj/`. Run `npm run validate` from `unity-cursor-toolkit/` before declaring any extension-side change done.
6. Unity project mutations are sensitive: prefer additive files; for MCP tools that mutate scenes/assets use `dryRun: true` first.
7. No new always-on network listeners. Anything that listens binds `127.0.0.1` unless the experiment explicitly covers tunneled remote access.

## Context you must internalize before touching anything

Read, in order:
1. `docs/UNITY_WITHOUT_EDITOR_EXPERIMENTS.md` -- the lanes (L0-L4), the licensing table, and the decision tree you are feeding.
2. `docs/EDITOR_WINDOW_STREAMING_PLAN.md` -- the hidden-editor streaming plan (M0-M6); your experiments decide how much of it ships and what runs on deployed hosts.
3. `docs/REMOTE_UNITY_STREAMING.md` -- the remote/VDD architecture these results plug into.
4. `AGENTS.md`, `docs/AI_AGENTS.md`, `docs/MCP_CLIENTS.md`.

Current working state (verified):
- A VS Code/Cursor extension (`unity-cursor-toolkit/src/`) connects to a Unity-side TCP server (`Packages/com.rankupgames.unity-cursor-toolkit/Editor/HotReloadHandler.cs`, ports 55500-55504, newline-delimited JSON). `mcpToolCall` messages route through `Editor/MCP/MCPBridge.cs` to `[MCPTool]` handlers; responses return as `mcpToolResult` with `_requestId`.
- `Editor/MCP/ViewportStreamTool.cs` streams real editor-window pixels for `scene`, `game`, `inspector`, `packageManager`, and `window:<full-type-name>` through `captureMode:"editorWindow"`. Frames are sent in-band on `viewportFrame.data`; the old camera/file path path remains available as `captureMode:"camera"`.
- `Editor/MCP/EditorWindowViewportCapture.cs` captures `GUIView.GrabPixels` inside the official installed editor process, reuses render resources, and downscales to the requested stream dimensions. Do not replace this with DLL re-hosting or forged icall bindings.
- `src/viewport/index.ts` now contributes first-class Cursor panels/commands for real editor-hosted Scene View, Game View, Inspector, Package Manager, and custom EditorWindows. The custom command prompts for a full type name and opens `view: "window:<type>"`. It also contributes separate player-hosted Scene/Game commands that use `host:"player"` and `captureMode:"camera"` against a running Viewport Service player without invoking hidden-editor launch.
- `npm --prefix unity-cursor-toolkit run probe:editor-window-stream` now proves five editor-window surfaces on macOS: Scene, Game, Inspector, Package Manager, and `UnityCursorToolkit.InternalSmoke.UCTSpikeProbeWindow`, all in-band with `captureMode:"editorWindow"`.
- The protocol also supports a player host: `viewport_stream` start args include `host: "editor" | "player"`. The macOS Viewport Service player build/probe is green, Cursor now has explicit Player Scene/Game panels, installed Cursor visual proof on macOS rendered both player panels live, and `measure:viewport-service` recorded `1280x720@30` game-stream perf. Windows proof is still pending.
- `npm --prefix unity-cursor-toolkit run smoke:installed-cursor-viewports` packages the VSIX, installs it into isolated Cursor temp dirs, and verifies the installed extension plus viewport command surface. Current command-surface result: `experiments/installed-cursor-smoke/results/2026-06-10-isolated-install.json`. With `--viewport-proof-out`, the same runner creates a temporary proof workspace, installs the VSIX into isolated Cursor dirs, auto-opens editor Scene/Game panels from the packaged extension, and waits for live editorWindow frame hashes. Latest automated proof: `experiments/installed-cursor-smoke/results/2026-06-10-cursor372-proof.json`.
- Installed-Cursor editor UI proof is archived at `experiments/installed-cursor-smoke/results/2026-06-10-installed-editor-scene-game-ui.json` with screenshot `experiments/installed-cursor-smoke/screenshots/2026-06-10-installed-cursor-editor-scene-game.png`. It proves live editor Scene View (`1108x720 #307`) and Game View (`1279x704 #126`) frames in Cursor via the official hidden Unity editor bridge on `55500`.
- Automated installed-Cursor editor frame proof is archived at `experiments/installed-cursor-smoke/results/2026-06-10-cursor372-proof.json` with smoke report `experiments/installed-cursor-smoke/results/2026-06-10-cursor372-smoke.json` and screenshot `experiments/installed-cursor-smoke/screenshots/2026-06-10-cursor372-clean-scene-game.png`. It proves the packaged extension activated in Cursor `3.7.27` (`e48ee6102a199492b0c9964699bf011886708ba0`, arm64), connected to bridge `55500`, and received live `host:"editor"`/`captureMode:"editorWindow"` Scene (`1108x720 #3`, SHA-256 `ac56fbf826315ffb3681e1ca327f84c9814a238c522fbbfd68f705ff4df08b03`) and Game (`1279x704 #3`, SHA-256 `e93413f552633f96726fb27f0bc15bceace0f0ab2141825b98172c19ba96f80c`) frames. The older Cursor `3.6.31` proof remains archived at `experiments/installed-cursor-smoke/results/2026-06-10-installed-editor-scene-game-auto-proof.json`.
- `npm --prefix unity-cursor-toolkit run audit:unity-without-editor` is the current fulfillment audit. It checks the legal boundary, E1/E2/E3/E5 evidence, Cursor command wiring, isolated installed-Cursor smoke, installed-Cursor editor UI proof, automated installed-Cursor editor frame proof, Unity capture implementation, player perf, and the Windows gate. Current result is `PARTIAL` with 12 pass, 1 pending, 0 fail; the pending item is Windows proof. When an executed Windows run writes `experiments/windows-unity-without-editor/results/**/windows-proof-summary.json`, the audit validates that summary plus the Windows preflight artifact, E1 verdict, E2 capture/input result, E2 measure JSON, installed-Cursor Scene/Game frame-hash proof JSON, E3 probe transcript, and E3 `1280x720@30` perf JSON before passing `windows-proof`. Dry-run summaries stay pending.
- `npm --prefix unity-cursor-toolkit run proof:windows-unity-without-editor:preflight -- --unity-path "C:\Program Files\Unity\Hub\Editor\6000.3.9f1\Editor\Unity.exe"` is the fast Windows readiness check. It writes `windows-proof-preflight.json` and checks platform, Node/npm/npx/vsce, dotnet, Cursor CLI, PowerShell, Unity editor path, project markers, lockfile state, scripts, and proof ports. Passing preflight is useful but does not satisfy the Windows audit gate.
- `npm --prefix unity-cursor-toolkit run proof:windows-unity-without-editor` is the Windows evidence runner. Execute it on a Windows host with Unity installed; use `--unity-path "C:\Program Files\Unity\Hub\Editor\6000.3.9f1\Editor\Unity.exe"` if auto-resolution fails. It writes E1/E2/installed-Cursor/E3 JSON plus `windows-proof-summary.json` under `experiments/windows-unity-without-editor/results/<date>-windows/`.
- `npm --prefix unity-cursor-toolkit run proof:windows-unity-without-editor:remote -- --manifest "$PWD/remote_workspace/unity-shell.json"` is the Mac-side SSH launcher. It reads `sshTarget`, `remoteRepoPath`, and `unityEditorPath` from the ignored remote manifest, runs the Windows evidence runner in the remote repo, and fetches the generated proof files back into the local audit tree. Use `--preflight-only` to run only the remote preflight, or `--dry-run --ssh-target <host> --remote-repo-path "C:\path\to\unity-cursor-toolkit"` to inspect the plan when the real manifest is absent.
- `npm --prefix unity-cursor-toolkit run proof:windows-unity-without-editor:import -- --from "/path/to/copied/<date>-windows"` imports a Windows-generated proof directory that was copied back manually, rejects dry-run/planned or non-`win32` summaries, and then runs the strict fulfillment audit.
- A spike harness for real-EditorWindow capture exists: `CursorUnityTool/Assets/Editor/UCTEditorWindowCaptureSpike.cs` + `unity-cursor-toolkit/scripts/run-editor-window-capture-spike.js` (`npm run spike:editor-windows`). Reuse its conventions (result JSON to the OS temp directory, Node runner polls, `resolveUnityPath()` from `ProjectSettings/ProjectVersion.txt`, env override `UNITY_CURSOR_TOOLKIT_UNITY_PATH`).
- Bundled Unity project: `CursorUnityTool/` (Unity 6000.3.9f1, URP, has `SampleScene` with Main Camera, Directional Light, Global Volume, Cube; Input System package installed).
- E1 macOS result is archived under `experiments/editor-dll-mount-probe/results/`; it confirms pure-managed Unity code can run outside the editor but editor/engine icalls fail. Windows E1 remains pending.
- Extension validation: `npm run validate` from `unity-cursor-toolkit/` currently passes with 169 runtime tests, 9 simplified-context tests, 9 remote-shell tests, compile/unused checks, and npm audit. Keep it green.

Environment: macOS (Apple Silicon) and Windows editor hosts are both in scope. Default Unity Hub paths: `/Applications/Unity/Hub/Editor/<version>/Unity.app/Contents/MacOS/Unity` on macOS and `C:\Program Files\Unity\Hub\Editor\<version>\Editor\Unity.exe` on Windows. `dotnet` 8 SDK may need installing. The Unity editor must be CLOSED for runners that launch the bundled project (they check `CursorUnityTool/Temp/UnityLockfile`).

## Experiments

### E1 -- Editor DLL mount probe (timebox: half a day)

**Question:** when Unity's managed assemblies are loaded into a plain .NET 8 host, exactly where does execution die?
**Hypothesis:** metadata enumeration and pure-managed code (e.g. `Vector3.Dot`) succeed; any engine-bound member (`Application.unityVersion`, `new SceneView()`) fails because internal calls are only registered inside the editor binary. A hard native crash during a probe is itself a confirming result.

Steps:
1. `cd experiments/editor-dll-mount-probe && dotnet build` -- fix any compile issues first (scaffold is unverified).
2. `dotnet run -- --out <os-temp>/uct-e1-report.json` (add `--unity-app` if auto-discovery misses; it walks `UNITY_CURSOR_TOOLKIT_UNITY_PATH`, `/Applications/Unity/Hub/Editor/<ProjectVersion>/Unity.app`, and `C:\Program Files\Unity\Hub\Editor\<ProjectVersion>\Editor`).
3. The probe rewrites the report before each risky step; if the process hard-crashes, the report's `"attempting"` entry is the evidence -- note the crashing probe and continue.
4. Record the icall density number (what % of sampled public UnityEngine methods are `[InternalCall]`) -- it quantifies "the DLLs are wrappers" for the docs.
5. Copy `report.json` to `experiments/editor-dll-mount-probe/results/<date>-<editorVersion>.json` and commit.

Success criteria: report written; verdict line resolves to CONFIRMED (or documented surprise); E1 row + verdict pasted into `docs/UNITY_WITHOUT_EDITOR_EXPERIMENTS.md` section 6.

### E2 -- Hidden editor cost baseline (timebox: half a day)

**Question:** what does lane L0 (hidden, extension-owned editor) cost on this machine?

Steps:
1. Reuse `scripts/run-editor-window-capture-spike.js --measure` and `scripts/measure-editor-streaming.js`; do not rebuild those harnesses unless a gap is proven.
2. Run the remaining three hidden measurements with `--hide`; record cold (first run after `rm -rf CursorUnityTool/Library`) vs warm numbers. Cold run will take several minutes (full reimport) -- raise `--timeout`.
3. Start real stream sessions through the extension or bridge and sample RSS/CPU during 60s of Scene View streaming at 12fps, then repeat for multi-window streaming after the resource-clamp patch.
4. Write numbers into `docs/UNITY_WITHOUT_EDITOR_EXPERIMENTS.md`: cold start s, warm start s, clean idle RSS/CPU, streaming RSS/CPU, observed profiler pressure/crash notes, and whether adaptive FPS/resolution is mandatory.

Success criteria: the decision tree question "is hidden-editor idle cost acceptable locally?" is answerable with numbers, not vibes.

Windows note: also run `npm --prefix unity-cursor-toolkit run spike:editor-windows -- --hide` on a Windows editor host. Record whether hidden `GUIView.GrabPixels` remains non-blank and whether PowerShell/user32 hiding affects repaint/input differently from macOS.

### E3 -- Player-build Viewport Service (timebox: 2-3 days; the big one)

**Question:** can a tiny Unity *player* build (no editor process, no editor license at runtime) serve interactive viewport frames into the existing Cursor panels?

Build, inside `CursorUnityTool`:
1. New scene `Assets/Scenes/ViewportService.unity` + runtime assembly code under `Assets/ViewportService/` (runtime asmdef or plain Assets; do NOT reference UnityEditor).
2. `ViewportServiceServer` (MonoBehaviour): a TCP server speaking the **same newline-delimited JSON protocol** as `HotReloadHandler` (subset: `ping/pong`, `mcpToolCall` for `viewport_stream` and `game_command`, `mcpToolResult`, `viewportFrame`). Reuse the message shapes exactly so `src/core/connection.ts` can attach unchanged; default port from `-uctViewportPort` arg, bind `127.0.0.1`.
3. Frame capture: render the active camera to a RenderTexture, `AsyncGPUReadback` -> JPEG (`ImageConversion.EncodeToJPG`) -> **send base64 in-band** in the `viewportFrame` payload as `"data"` (do not write files). Add the matching few lines to `src/viewport/index.ts` `handleViewportFrame`: if `payload.data` is a string, use it directly instead of `fs.readFile` (keep the path branch for editor compatibility).
4. "Scene-view-like" mode: a second camera rig with orbit/pan/zoom driven by `viewport_stream` input messages (`sceneDrag`/`sceneZoom` -> rotate/dolly the rig), an infinite grid shader or line-rendered grid, and a selection raycast that returns instanceID + draws an outline. This is parity-by-reimplementation -- document divergences, do not chase pixel parity with the real SceneView.
5. Build automation: `unity-cursor-toolkit/scripts/build-viewport-service.js` -- launches the editor once in `-batchmode -quit -executeMethod` (editor needed only to BUILD, which is normal licensed usage) calling a new `Assets/Editor/ViewportServiceBuild.cs` that produces a macOS player into `CursorUnityTool/Builds/ViewportService/`. Then `scripts/run-viewport-service.js` launches the built player (`-batchmode` is forbidden here; use windowed mode with `-screen-width 320 -screen-height 200`, position offscreen or rely on `--hide` osascript like the spike runner) and prints attach instructions.
6. Measure: player cold start to first frame (target < 5s warm), RSS, fps at 1280x720@30. Current macOS command: `npm --prefix unity-cursor-toolkit run measure:viewport-service -- --player /Users/dudetru25/GithubProjects/unity-cursor-toolkit/CursorUnityTool/Builds/ViewportService/ViewportService.app --port 55501 --view game --width 1280 --height 720 --fps 30 --quality 72 --idle-seconds 5 --duration 30 --timeout 60 --hide --out ../experiments/player-viewport-service/results/2026-06-10-6000.3.9f1-macos-game-1280x720-30fps.json`. Result: `866` frames, `28.89fps` effective, `6572ms` port-ready startup, `11692ms` first frame from launch, average stream RSS `199.5 MB`, average stream CPU `40.3%`, no errors.

Success criteria: with the Unity editor fully closed, `node scripts/run-viewport-service.js` + clicking Connect/Start in `Unity Toolkit: Open Player Game View` shows live game frames and `Unity Toolkit: Open Player Scene View` shows scene-like frames with orbit input; `npm run validate` and the node tests stay green; results recorded in the doc.

### E4 -- UaaL desktop embed probe (timebox: half a day, optional, Windows-first)

Only if a Windows host is available: assess hosting the player (`UnityPlayer.dll`) inside a custom shell window, as a future seam for `native-shell/UnityVddShell`-style local embedding. Deliverable is a short feasibility note in the doc (APIs found, blockers, go/no-go) -- no production code. On macOS-only setups, write the note from documentation research alone and mark it "desk check".

### E5 -- License automation (timebox: 1 day)

**Question:** how do hidden local editors and deployed remote editors stay licensed hands-free?

Steps:
1. `unity-cursor-toolkit/scripts/unity-license.js` with subcommands `activate`, `return`, `status`: wraps the official CLI flows, reading `UNITY_EMAIL/UNITY_PASSWORD/UNITY_SERIAL` from env, `--manual` mode wrapping `-createManualActivationFile`/`-manualLicenseFile`. Every command supports `--dry-run` (prints the exact Unity invocation with secrets masked) -- default to dry-run unless `--execute` is passed, so CI documentation can be generated without touching the real seat.
2. Document in `docs/UNITY_WITHOUT_EDITOR_EXPERIMENTS.md`: which lanes need a seat (L0/L1 yes, E3 player runtime no, E3 build step yes), when to choose floating licensing server vs per-VM serials (pools > 2 VMs => floating), and how `remote-shell` manifests should reference license env vars on the Windows sidecar host.
3. Do NOT run `--execute` against the real account unless the human operator explicitly confirms in-session.

### E6 -- Instant-attach editor (timebox: half a day, stretch)

Measure perceived "Unity isn't running" via warmth: (a) login-item/lazy background launch of the hidden editor and (b) on the remote Windows VDD host, VM snapshot/resume attach latency. Numbers + recommendation in the doc. Skip if E3 succeeded and E2 showed acceptable cost -- note why.

### E7 -- Offscreen UI Toolkit re-host (timebox: 1 day; workaround W1)

**Question:** can we render *real* editor UI components without any EditorWindow/GUIView -- e.g. an `InspectorElement` bound to a `SerializedObject` -- by attaching them to a runtime `PanelSettings` panel whose `targetTexture` is a RenderTexture inside the licensed editor process?

Why it matters: it would decouple editor-quality Inspector/Package Manager panels from window geometry (arbitrary per-panel resolution in Cursor, no `GrabPixels`, no hidden-window repaint pumping) and might even work under `-batchmode`. It is the highest-parity workaround that is not yet proven either way. Everything stays public-API inside the licensed editor.

Steps:
1. New editor spike `CursorUnityTool/Assets/Editor/UCTUitkRehostSpike.cs` + Node runner, following the `UCTEditorWindowCaptureSpike` conventions (result JSON to OS temp, auto-quit flag, menu item for manual runs).
2. Create a `PanelSettings` instance at runtime with `targetTexture` = RT; attach `new InspectorElement(new SerializedObject(selectedComponent))` plus a few editor controls (`PropertyField`, `ObjectField`) to the panel's root.
3. Force layout/repaint, read the RT back, save JPEG, and apply the spike's distinct-color non-blank metric. Record whether editor stylesheets resolve and whether an `IMGUIContainer`-based custom inspector draws.
4. Dispatch a synthetic pointer event through the panel at a `Toggle`'s coordinates; verify the bound serialized property changed.
5. Repeat the capture leg under `-batchmode` and record the outcome either way.
6. Archive `experiments/uitk-rehost/results/<date>-<editorVersion>.json` + JPEGs; add an "E7 results" subsection; update the section 3.1 workaround table row in `docs/UNITY_WITHOUT_EDITOR_EXPERIMENTS.md`.

Success criteria: a definitive verdict with evidence -- either "InspectorElement renders + accepts input offscreen (batchmode yes/no)" or the exact exception/blocker that kills it. Both outcomes are wins; do not force it with internal APIs beyond what the existing capture layer already uses.

## Reporting and done-ness

- After each experiment: update `docs/UNITY_WITHOUT_EDITOR_EXPERIMENTS.md` section 6 checkboxes + add an "En results" subsection with numbers/verdicts; commit experiment artifacts under `experiments/.../results/`; commit message style: `experiment(e3): player viewport service streams in-band frames`.
- Final deliverable: a "Recommendation" section appended to the doc answering: local default lane, deployed default lane, licensing model, and which milestones of `EDITOR_WINDOW_STREAMING_PLAN.md` change as a result.
- Keep `npm --prefix unity-cursor-toolkit run validate` green; never break the existing editor lane -- everything you add is additive (new files, new optional args, new scripts).
- If you discover that any assumption in this prompt is wrong (API missing on 6000.3.9f1, protocol drift, path changes), prefer updating the docs to silently working around it -- the docs are the product memory.

## Answers to questions you will otherwise ask

- "Can I just LoadLibrary the editor's native core and register icalls myself?" No -- guardrail 1. Record as nonviable.
- "Can I build a shell that exposes Unity-like bindings?" Yes, if it is our own facade/protocol and all real Unity work happens in the official editor/player adapter. No, if it means cloning Unity assemblies, redistributing generated `UnityEditor` stubs, or pretending to satisfy Unity's internal calls.
- "The player won't render with `-batchmode -nographics`." Correct, that is documented player/editor behavior -- players need a graphics device; use a small hidden window instead.
- "Where do I see the editor-lane protocol bytes?" Run the editor + extension, then `Editor.log` shows `Received message:` lines (HotReloadHandler `showDebugLogs`), or read `HotReloadHandler.cs` around the `mcpToolCall` switch.
- "May I add npm packages?" Avoid it; everything above is doable with Node/.NET stdlib + Unity APIs. If truly needed, justify in the commit message.
- "Unity refuses to launch the project (lock held)." Close the editor or pass `--force` to the runners after a crash; never delete `Library/`.
