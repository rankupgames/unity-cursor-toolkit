# Editor Window Streaming Plan

Goal: stop re-rendering cameras with our own HTML toolbar and instead stream the *real* Unity editor windows -- Scene View (with its actual toolbar, gizmos, handles, tools), Game View, Inspector, Package Manager, and any custom `EditorWindow` -- into Cursor panels, with Unity running invisibly in the background and auto-launched by the extension.

This builds on the working v0 loop (camera -> RenderTexture -> JPEG -> `viewportFrame` -> webview), which stays as the batchmode/headless fallback.

## 1. The honest constraint first

| Want | Possible? | How |
| --- | --- | --- |
| Real Scene View pixels + controls in Cursor | Yes | Capture the live `SceneView` window surface in-process, inject input as editor `Event`s |
| Unity window not visible anywhere | Yes | Run the full editor (NOT `-batchmode`), hide the app/process; extension owns the lifecycle |
| Unity process not running at all, but Scene View renders | **No** | Scene View, Inspector, Package Manager *are* the editor. No process, no windows. Closest: auto-launch hidden Unity on demand (cold start budget below) |
| Game view without the editor | Yes | Player build streaming (the VDD/remote lane) -- game only, no editor surfaces |

So "close Unity" becomes: the extension launches Unity itself, hidden, when a panel starts; you never see or touch the Unity UI. The editor process still exists -- it is the render farm.

The "no editor process at all" question (DLL mounting, license passthrough, player-build rendering) is explored separately with its own experiment series: see `docs/UNITY_WITHOUT_EDITOR_EXPERIMENTS.md` and the executing-agent prompt in `docs/prompts/unity-without-editor-agent-prompt.md`.

## 2. Capture approaches, compared

| Approach | Fidelity | Works hidden? | Works in `-batchmode`? | Input path | Verdict |
| --- | --- | --- | --- | --- | --- |
| A. Camera re-render (current v0) | Camera image only; no toolbar/gizmos/handles/overlay UI | Yes | Yes | Synthetic Input System events | Keep as headless fallback |
| B. `GUIView.GrabPixels` per EditorWindow (internal API, reflection) | Pixel-perfect real window incl. IMGUI/UIElements chrome | Yes (windows render to their own surfaces; force `Repaint`) | No (no GUIViews exist) | `EditorWindow.SendEvent(Event)` -- in-process, no OS focus needed | **Primary path. Spike included** |
| C. OS window capture (ScreenCaptureKit / Windows Graphics Capture or FFmpeg gdigrab) + OS input | Pixel-perfect, GPU-cheap, 60fps | Partially (hidden/minimized apps can stop compositing; VDD helps on Windows) | No | OS-level events; focus fights with Cursor | Remote-host lane (VDD shell already prototypes this on Windows) |
| D. Rebuild panels natively from MCP data (semantic) | Not pixels -- our UI, Unity data | Yes | Yes | Direct tool calls | Long-term complement (you said no for now; right call for v1) |

**Pick: B**, with A as batch fallback and C as the remote/VDD lane. B is what editor-screenshot/tooling hacks have used across Unity versions: every `EditorWindow` has an internal `m_Parent` (`HostView : GUIView`), and `GUIView.GrabPixels(RenderTexture, Rect)` blits the view's actual backbuffer -- toolbar, handles, gizmos, UIElements, everything. It works while the app is hidden because we drive `Repaint()` ourselves; it does not depend on screen visibility or focus.

Risk: internal API drift in Unity 6.3 (6000.3.9f1). That is exactly what the spike proves in one command (section 7).

Windows is not a fallback-only target. The primary B path is in-process editor code, so the same `GUIView.GrabPixels` and `EditorWindow.SendEvent` spike must pass on Windows editor hosts. Windows-specific capture only enters when we deliberately choose lane C for a remote/VDD shell or player embedding.

## 3. Per-surface plan

| Surface | Capture | Input | Notes |
| --- | --- | --- | --- |
| Scene View | `GetWindow<SceneView>()` -> GrabPixels | `SendEvent`: orbit (Alt+drag), pan (MMB), zoom (wheel), select (click), handles (drag), rect-select; keyboard QWERTY tool switching | Toolbar/gizmos/2D/space buttons come for free -- delete our HTML clones. Camera state also settable semantically (`SceneView.pivot/rotation/size`) for agent commands |
| Game View | `GameView` window via reflection -> GrabPixels | Play-mode input keeps current adapter/Input System lane (game reads real input APIs, not editor events) | Captures the *actual* Game View incl. Screen Space Overlay UI -- fixes a v0 gap. Camera.main re-render remains the batchmode lane |
| Inspector | `UnityEditor.InspectorWindow` via reflection -> GrabPixels | `SendEvent` for toggles/sliders/fields; keyboard events for text | Needs the selection bridge: hierarchy click in Cursor -> new `manage_scene` action `select` (`Selection.activeInstanceID = id`). Not implemented yet -- small |
| Package Manager | `UnityEditor.PackageManager.UI.Window.Open("")` (public API) -> GrabPixels | `SendEvent` | UIElements + async refresh; first paint takes frames |
| Custom EditorWindows | `EditorWindow.GetWindow(Type.GetType(assemblyQualifiedName))` -> GrabPixels | `SendEvent` | One generic protocol target: `{ "target": "window", "windowType": "Foo.Bar, Assembly" }` |
| Hierarchy | Keep the native VS Code tree (already built) | -- | Faster + semantic; streaming the real one adds nothing |

Aux popup windows (`ObjectSelector`, `ColorPicker`, dropdown `PopupWindow`s) are themselves EditorWindows: enumerate `Resources.FindObjectsOfTypeAll<EditorWindow>()` each tick, auto-stream new ones as transient overlay panels in Cursor, route input to them while open.

### Known fidelity gaps to accept (v1)
- `GenericMenu`/context menus and some dropdowns are **native OS menus** -- not capturable, and with a hidden app they pop on the host display or not at all. Mitigation later: intercept right-click in Cursor, query a menu manifest, render a QuickPick, execute the pick Unity-side.
- IME/text composition: plain keystrokes work via events; IME does not.
- OS drag-and-drop into windows: needs `DragAndDrop` API synthesis (phase M4+).
- Mouse cursor shapes (orbit/resize icons) are not transmitted (can hint via CSS later).

## 4. Hidden Unity lifecycle ("close Unity" UX)

Extension gets an **Editor Session Manager**:
1. Resolve editor binary from `ProjectSettings/ProjectVersion.txt` (logic already exists in `scripts/run-internal-viewport-stream.js` -- promote to shared module).
2. Detect running instance via `Temp/UnityLockfile` + our TCP handshake; reuse if alive.
3. Launch full editor (no `-batchmode`): `-projectPath ... -executeMethod UnityCursorToolkit.MCP.HeadlessBootstrap.Start -silent-crashes -logFile <path>`. Bootstrap: ensure server started, apply a minimal saved window layout, set `EditorPrefs` Interaction Mode to "No Throttling" so a hidden/unfocused editor keeps pumping `EditorApplication.update`, and disable App Nap (`NSProcessInfo` activity via plugin or `defaults write NSAppSleepDisabled`).
4. Hide: macOS `osascript -e 'tell application "System Events" to set visible of process "Unity" to false'`; Windows `ShowWindowAsync(..., SW_HIDE)` via PowerShell/user32 (best effort). Dock/taskbar suppression can be handled later by native wrappers -- not v1.
5. Health: heartbeat already exists; relaunch on death; "Stop Unity" command quits via `EditorApplication.Exit`.

Cold start budget: warm Library ~15-45s to first frame. Acceptable; show progress in the panel status bar.

Licensing/locks: one editor per project; session manager is the single owner. Editor seat required on every host that renders editor windows (incl. remote).

## 5. Protocol + transport changes (also fixes v0 review items)

- `viewport_stream` grows a `target` concept: `scene | game | inspector | packageManager | window:<type>` (sessions already multi-keyed -- good).
- **Frames go in-band**: add `"data": "<base64 jpeg>"` to `viewportFrame` and drop the `fs.readFile(path)` hop. The extension already base64s anyway; this kills the same-filesystem assumption (remote-ready) and the disk-leak (also stop writing per-frame files at all, or cap to latest-only for the MJPEG debug server).
- Input becomes a typed event union routed to the session's window: `{kind: move|down|up|drag|wheel|key|char, x, y, dx, dy, button, modifiers, key, char}` -- coordinates normalized 0..1 against the streamed image (webview maps letterbox + DPI; Unity multiplies by `window.position.size`, builds `Event` with `EditorGUIUtility.pixelsPerPoint` awareness).
- Capture perf ladder: reuse one RT + `Texture2D` per session -> `AsyncGPUReadback` -> skip-if-identical (frame hash) -> dynamic resolution. JPEG stays v1; WebRTC/H.264 is the v2 transport per `REMOTE_UNITY_STREAMING.md`.
- Security (pre-deploy hard requirements): bind TCP to loopback instead of `IPAddress.Any`, pairing token on connect, reply `mcpToolResult` to the requesting client only (currently broadcast to all).

## 6. "Mount our shit" -- two readings, both answered

**Mount Unity windows inside Cursor as native children:** not possible on macOS -- there is no cross-process `NSView`/window reparenting, and Cursor (Electron/VS Code) offers no embedding surface. Streaming into webview panels (this plan) *is* the mounting story, same model as VS Code Remote renders remote UI. The SwiftUI `native-shell/UnityVddShell` remains the path to free-floating native windows that *feel* mounted (own titlebars, Metal-decoded frames) when you outgrow webviews.

On Windows, there are more native-window tricks, but they split by surface:
- **Editor windows:** still stream pixels/events. Do not rely on HWND reparenting for the editor; it is brittle with docked IMGUI/UIElements windows, focus, modal dialogs, and Unity upgrades.
- **Player builds:** Windows is stronger. Unity documents `-parentHWND` and `UnityPlayer.dll` for embedding a player build in a host process/window, which is exactly E4's lane for the no-editor Viewport Service.
- **Remote/VDD:** Windows stays the best host for virtual-display capture. Prefer Windows Graphics Capture/Desktop Duplication when building a real transport; keep FFmpeg `gdigrab` as a smoke-test path because it is already simple and scriptable.

**Mount the project/workspace when Unity runs elsewhere:**
- VS Code/Cursor **Remote-SSH**: extension host runs next to remote Unity -- today's code (TCP localhost + even the file-path frames) works unchanged; webview gets frames over Cursor's own channel. Cheapest remote win; test it before building transports.
- SSHFS/NFS project mount for casual browsing: fine for `Assets/`, exclude `Library/Temp` (lock + perf).
- Preferred per existing docs: `.umetacontext` summaries + narrow file fetch instead of bulk mounts.

## 7. Spike harness (included in this commit)

The riskiest assumptions are (1) `GrabPixels` exists and produces non-blank captures of SceneView/Inspector/PackageManager/custom windows on Unity 6.3, hidden; (2) `SendEvent` actually drives SceneView orbit. The spike proves both in one shot, with Unity closed beforehand:

```bash
# close Unity first (runner refuses if Temp/UnityLockfile is held)
node unity-cursor-toolkit/scripts/run-editor-window-capture-spike.js --hide
# or: npm --prefix unity-cursor-toolkit run spike:editor-windows
```

It launches `CursorUnityTool` (full editor, no batchmode, optionally hidden), runs `UCTEditorWindowCaptureSpike`, and prints a verdict table: per-window capture success, dimensions, non-blank color count, and whether synthetic Alt+drag changed `SceneView.rotation`. JPEGs land in the OS temp directory (`/tmp/uct-editor-window-spike/` on macOS/Linux, `%TEMP%\uct-editor-window-spike\` on Windows) for eyeballing. Inside the editor it is also runnable via `Tools > Unity Cursor Toolkit > Editor Window Capture Spike`.

Interpreting results:
- All captures non-blank + rotation changed -> green-light M1/M2 as designed.
- `GrabPixels` missing -> result JSON lists available `GUIView` methods; fall back to `InternalEditorUtility.ReadScreenPixel` (visible-window constraint) or escalate lane C.
- Captures blank while hidden -> keep editor visible-but-background during M1, fix repaint pumping in M3.

## 8. Milestones with test gates

| # | Deliverable | Test gate |
| --- | --- | --- |
| M0 | Spike passes on Unity 6.3 | `run-editor-window-capture-spike.js` exit 0 |
| M1 | `EditorWindowStreamTool`: GrabPixels sessions for scene/game targets, in-band frames, RT reuse, loopback bind | `probe:editor-window-stream` proves scene/game `captureMode:"editorWindow"` frames with in-band data; existing node tests stay green |
| M2 | Real input: pointer/wheel/key -> `SendEvent`, coordinate normalization; delete HTML toolbar clones from panels | Scripted asserts: orbit changes rotation, click changes `Selection`, W/E/R switches `Tools.current`; local p50 input->frame < 100ms |
| M3 | Editor Session Manager: auto-launch hidden, no-throttle prefs, health/relaunch, Stop command | Cold start -> first frame < 60s with no visible Unity window; kill -9 recovery |
| M4 | Inspector + Package Manager + custom-window targets; `manage_scene select` bridge; aux popup overlay capture | Click cube in hierarchy -> inspector panel shows it < 300ms; object picker popup streams |
| M5 | Remote: token auth, in-band frames over SSH tunnel; Remote-SSH validated; WebRTC decision spike | Stream from a second machine; no unauthenticated LAN listener (scan) |
| M6 | Perf: AsyncGPUReadback, frame-hash skip, dynamic res | 1280x720@30 game + 720p@12 scene simultaneously < ~25% of one core Unity-side |

## 9. Decision log

- Real-window streaming over semantic rebuild for v1 -- explicit user call ("render the stuff from Unity rather than our own buttons").
- Editor must run for editor surfaces; product answer is invisible, extension-owned Unity.
- Internal APIs via reflection with per-call fallbacks and a permanent spike to catch Unity upgrades.
- Hierarchy stays native; everything pixel-streamed keeps a semantic command side-channel so agents are not click-bots.
- Windows editor hosts are first-class for the spike and hidden-editor lane; Windows player embedding/VDD capture remain the preferred no-editor remote path.

## 10. Current Implementation Evidence

- `viewport_stream` now supports `captureMode: "editorWindow"` for `view: "scene"`, `view: "game"`, `view: "inspector"`, `view: "packageManager"`, and custom `view: "window:<full-type-name>"`. Unity captures the actual `EditorWindow` HostView backbuffer with `GUIView.GrabPixels`, broadcasts JPEG data in-band on `viewportFrame.data`, and keeps the legacy camera capture path as `captureMode: "camera"`.
- The editor-window capture helper now reuses `RenderTexture`/`Texture2D` resources and downscales to the requested stream dimensions before JPEG encoding. This avoids the previous full-window allocation churn where Inspector/Package Manager streamed at `2024x2040` every frame.
- Cursor panels are first-class for Scene View, Game View, Inspector, Package Manager, and arbitrary custom EditorWindows. The extension contributes `Unity Toolkit: Open Scene View`, `Unity Toolkit: Open Game View`, `Unity Toolkit: Open Inspector`, `Unity Toolkit: Open Package Manager`, and `Unity Toolkit: Open Custom EditorWindow`; Quick Actions expose all five. Custom windows prompt for a full type name and stream through `view: "window:<type>"`.
- The same Cursor shell now exposes the legitimate no-editor player lane separately: `Unity Toolkit: Open Player Scene View` and `Unity Toolkit: Open Player Game View`. Those panels request `host:"player"` with `captureMode:"camera"` and attach to a running Viewport Service player without triggering hidden-editor launch. They are not real editor UI; they are the player/runtime adapter called out in `docs/UNITY_WITHOUT_EDITOR_EXPERIMENTS.md`. Installed Cursor visual proof on macOS rendered both player panels live from the Viewport Service with the editor not running.
- macOS player perf proof for that lane is recorded at `experiments/player-viewport-service/results/2026-06-10-6000.3.9f1-macos-game-1280x720-30fps.json`: `1280x720@30` game stream, `866` frames, `28.89fps` effective, `6572ms` port-ready startup, `11692ms` first frame from launch, average stream RSS `199.5 MB`, average stream CPU `40.3%`, no leftover listener/process after cleanup.
- Repeatable fulfillment audit: `npm --prefix unity-cursor-toolkit run audit:unity-without-editor` writes the current acceptance state. Latest result `experiments/unity-without-editor-audit/results/2026-06-10-current.json` is `PARTIAL`: legal/macOS editor-window/player evidence passes, Windows installed-host proof remains pending. When an executed Windows run writes `experiments/windows-unity-without-editor/results/**/windows-proof-summary.json`, the audit validates the summary plus E1/E2/installed-Cursor/E3 artifacts before passing the Windows gate; dry-runs stay pending.
- Isolated installed-Cursor smoke: `npm --prefix unity-cursor-toolkit run smoke:installed-cursor-viewports` packages the VSIX, installs it into temp Cursor user-data/extensions dirs, and verifies `rankupgames.unity-cursor-toolkit@0.6.1052828` plus the viewport command surface. Latest command-surface result: `experiments/installed-cursor-smoke/results/2026-06-10-isolated-install.json`. The same runner now supports opt-in automated editor frame proof with `--viewport-proof-out`, which opens editor Scene/Game panels from the packaged extension and waits for live editorWindow frame hashes. Latest automated proof: `experiments/installed-cursor-smoke/results/2026-06-10-installed-editor-scene-game-auto-proof.json`.
- Installed-Cursor editor UI proof: `experiments/installed-cursor-smoke/results/2026-06-10-installed-editor-scene-game-ui.json` records Cursor command-palette availability, official Unity editor process launch, bridge `55500`, live `Unity Scene View` frame `1108x720 #307`, and live `Unity Game View` frame `1279x704 #126`. Screenshot: `experiments/installed-cursor-smoke/screenshots/2026-06-10-installed-cursor-editor-scene-game.png`.
- Automated installed-Cursor editor frame proof: `experiments/installed-cursor-smoke/results/2026-06-10-installed-editor-scene-game-auto-proof.json` records packaged extension activation in Cursor `3.6.31`, bridge `55500`, Scene `host:"editor"`/`captureMode:"editorWindow"` frame `1108x720 #1` with SHA-256 `c72f842fdd99e6abc258476683807f5cb37872178bd2560632c5d6d3264c07b8`, and Game `host:"editor"`/`captureMode:"editorWindow"` frame `1280x704 #1` with SHA-256 `bae3b7998f95fa743ced83402f9403cb041b9ae9bdb1359a6df63d1d32361f0d`.
- Windows gate runner: `npm --prefix unity-cursor-toolkit run proof:windows-unity-without-editor` now orchestrates the required Windows evidence run for E1 DLL mount, E2 hidden `GUIView.GrabPixels` spike, packaged installed-Cursor Scene/Game frame-hash proof, E3 Windows player build/probe, and E3 player perf, and writes `windows-proof-summary.json` incrementally so failed attempts still leave usable evidence. This is a runner only until it is executed on a Windows Unity host.
- Windows preflight: `npm --prefix unity-cursor-toolkit run proof:windows-unity-without-editor:preflight` writes `windows-proof-preflight.json` and checks the Windows host for required tools and paths before the full proof run. It is a readiness check only; it cannot satisfy the audit without the full executed proof summary.
- Remote Windows proof launcher: `npm --prefix unity-cursor-toolkit run proof:windows-unity-without-editor:remote -- --manifest "$PWD/remote_workspace/unity-shell.json"` SSHes to the manifest's Windows host, runs the Windows proof runner in `remoteRepoPath`, and fetches the generated proof artifacts back into the local audit tree. The wrapper report is not accepted by the audit by itself; only the fetched `win32` proof summary and artifacts can pass the gate.
- Manual Windows proof import: `npm --prefix unity-cursor-toolkit run proof:windows-unity-without-editor:import -- --from "/path/to/copied/<date>-windows"` imports a Windows-generated result folder and runs the strict fulfillment audit. It rejects dry-run/planned and non-`win32` summaries before copying.
- Cursor-installed extension visual proof on Unity 6000.3.9f1, macOS 26.5.0: opening `Unity Toolkit: Open Scene View` from Cursor launched the installed Unity editor with `-projectPath CursorUnityTool -executeMethod UnityCursorToolkit.HotReloadHandler.Start`, hid it best-effort, connected only after the toolkit JSON `ping`/`pong` handshake on port `55500`, and auto-started the Scene View stream. Opening `Unity Toolkit: Open Game View` auto-started a second stream. Computer Use inspection showed both Cursor webviews displaying `<img>` frames: Scene View `1600x1040 #506`, Game View `1572x865 #257`, both `Streaming`.
- Cursor live UI proof for the new non-viewport surfaces on macOS: `Unity Toolkit: Open Inspector` and `Unity Toolkit: Open Package Manager` opened separate Cursor webviews, each displaying live real-editor frames from the installed Unity backend. Inspector showed `2024x2040 #87`; Package Manager advanced to `2024x2040 #1271` before the resource-clamp patch.
- Post-clamp bridge probe on Unity 6000.3.9f1, macOS 26.5.0: `npm --prefix unity-cursor-toolkit run probe:editor-window-stream` connected to toolkit bridge `55500` and proved in-band frames for all five surfaces: Scene `554x360`, Game `640x352`, Inspector `357x360`, Package Manager `357x360`, and custom `UnityCursorToolkit.InternalSmoke.UCTSpikeProbeWindow` `540x360`, all with `captureMode:"editorWindow"`, `hasData:true`, `hasPath:false`. Scene View `sceneDrag` input returned `layer:"editorWindow"`.
- Hidden full-editor spike on Unity 6000.3.9f1, macOS 26.5.0: `GUIView.GrabPixels` captured non-blank Scene View (`1600x1040`), Game View (`1572x865`), Inspector (`2024x2040`), Package Manager (`2024x2040`), and custom `EditorWindow` (`840x560`); `EditorWindow.SendEvent` changed SceneView rotation by `13.275` degrees. Warm launch-to-result with `--measure`: `28.478s`, peak sampled RSS `918.2 MB`, peak sampled CPU `117.7%`.
- Stability note from the live proof: before the resource-clamp patch, concurrent full-resolution editor-window streams triggered a Unity native segfault in the graphics/profiler path and left a stale `Temp/UnityLockfile`. After the patch, the five-surface probe completed without crashing, but Unity still logged profiler buffering pressure during validation; sustained multi-window streaming still needs longer soak tests and adaptive FPS/resolution before product completion.
- Connection hardening: Cursor now rejects open TCP ports that do not answer toolkit JSON `pong`, which prevents false attachment to Unity's built-in editor/player listener on `55504`.
- Fresh installed-VSIX retest after panel cleanup: stale disposed webviews no longer throw when Scene/Game panels are closed and reopened from Unity Quick Actions; Scene/Game streams reopened cleanly and kept toolkit status/meta text in the bottom status bar instead of overlaying HUD text on captured Unity pixels.
- `npm run validate` passes after the implementation: TypeScript compile, unused checks, 162 runtime tests, 9 simplified-context tests, 7 remote-shell tests, and npm audit.
- Repeatable bridge check: open the Unity project with the toolkit bridge running, then run `npm --prefix unity-cursor-toolkit run probe:editor-window-stream`.

Remaining before calling the cross-platform/product program done: run the same installed-extension visual proof on a Windows editor host, record hidden repaint/input behavior under PowerShell/user32 hiding, then complete player perf and Windows build/run/probe numbers for deployed/license-less hosts.
