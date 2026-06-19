# Unity Without The Editor: DLL Mounting, Facade Bindings, License Passthrough, And No-Editor Rendering

Question this doc answers: can we trigger Scene View / editor rendering **without running the Unity editor process at all** -- for example by mounting Unity's DLLs into our own host process -- and can we do it with our own license entitlements so every action stays licensed?

Companion: `docs/EDITOR_WINDOW_STREAMING_PLAN.md` (streaming the real editor, hidden). Agent handoff prompt: `docs/prompts/unity-without-editor-agent-prompt.md`. Experiment scaffold: `experiments/editor-dll-mount-probe/`.

## 1. Architecture facts that bound the answer

- `UnityEngine.*.dll` and `UnityEditor*.dll` are **thin managed wrappers**. Nearly every method that touches rendering, objects, assets, or windows is `[MethodImpl(MethodImplOptions.InternalCall)]` or a binding shim: the implementation lives in the **native engine inside the editor executable** (`Unity.app/Contents/MacOS/Unity`), not in the DLLs.
- Those internal calls ("icalls") are registered by the editor binary's boot path: native engine init -> graphics device -> object/asset database -> scripting VM (Mono) with the icall table. Loading the managed DLLs in our own .NET/Mono host gives you metadata and pure-managed code (math structs, enums), and **dead ends at the first icall** -- there is no public native "editor as a library" to bind against on desktop.
- Unity ships exactly one supported embedding: **Unity as a Library (UaaL)** -- the *player* runtime embedded in another app (official for mobile; the Windows player `UnityPlayer.dll` is the same idea on desktop). That embeds a *game*, not the editor; no SceneView/Inspector/AssetDatabase exists in a player.
- Therefore: **the minimum unit that can render editor windows is the editor process.** Anything "without Unity running" must either (a) not be the real editor (player-build re-implementation), or (b) hide/automate the editor process so it *feels* absent.

What we *can* build safely is a clean-room **facade binding shell**:
- Outside Unity: our own DTOs, TypeScript types, JSON-RPC/MCP tool schemas, and small helper classes such as `SceneViewProxy`, `InspectorProxy`, `SelectionProxy`, and `AssetDatabaseProxy`. These expose the operations we need and can feel like "using Unity" from Cursor.
- Inside Unity: a normal package compiled by the official editor/player calls public Unity APIs and selected reflection probes, then returns pixels/data through our protocol.
- Across the boundary: pixels, events, object IDs, serialized metadata, and command results -- never Unity's private native state or a forged icall table.

That gives us the same product ergonomics without pretending `UnityEditor.dll` can run in our process. The shell is allowed to *look like* Unity at the API level we design, but it must not be a redistributed clone of Unity assemblies, a patched loader, or a generated fake `UnityEditor` runtime that attempts to bind Unity internals.

E1 below proves this empirically on our exact editor build rather than taking it on faith, and records the precise failure modes.

## 2. License passthrough -- the legit boundary

"Mounting DLLs with our keys" is not how Unity licensing attaches: **a license activates an editor installation/seat, not a DLL**. The licensed ways to pass our entitlements through to automated/hidden/remote editors:

| Mechanism | Use | How |
| --- | --- | --- |
| CLI activation | One-shot activate a machine/seat | `Unity -batchmode -quit -username "$UNITY_EMAIL" -password "$UNITY_PASSWORD" -serial "$UNITY_SERIAL"` |
| Manual license file (`.ulf`) | Air-gapped/CI hosts | `-createManualActivationFile` -> license.unity3d.com -> `-manualLicenseFile <file>.ulf` |
| Unity Licensing Server (floating) | Pools of deployed VMs / editor farm | On-prem licensing server; editors lease/return seats; built for build farms |
| Build Server licenses | Headless build/automation seats at scale | Separate SKU intended exactly for non-interactive editors |
| Player builds | Deployed viewport service | **No editor license needed at runtime** -- players are freely redistributable (splash-screen rules per tier) |

Hard guardrails (these keep "all licensed actions" true):
- Never patch, spoof, proxy, or bypass license checks; never extract/redistribute the native engine to dodge activation. EULA violations, full stop.
- Reflection-only *inspection* of installed DLLs on a licensed machine (E1) is fine; hacking icall tables to make the editor's managed layer run outside the editor is not a lane we pursue.
- Do not ship Unity-derived stub assemblies or generated API clones from Unity DLL metadata. If an outside-Unity "binding" is useful, define it as our own protocol/facade surface and keep the Unity adapter inside the licensed editor/player package.
- Secrets (`UNITY_EMAIL/UNITY_PASSWORD/UNITY_SERIAL`) live in env/CI secrets, never in the repo. `remote_workspace/unity-shell.json` stays gitignored for the same reason.

## 3. The lanes, ranked by "no editor running"

| Lane | Editor process? | What you get | Cost |
| --- | --- | --- | --- |
| L-1 Clean-room facade shell | No by itself; adapters run in L0/L2 | Unity-like commands/types for Cursor agents and UI; no rendering by itself | Legal/product ergonomics layer only; real behavior still comes from editor/player adapters |
| L0 Hidden auto-launched editor (plan M3) | Yes (invisible, extension-owned) | Everything: real SceneView/Inspector/PM | RAM/CPU of an idle editor; cold start 15-60s |
| L1 Warm daemon / suspended editor (E6: launch at login, OS sleep/VM snapshot resume) | Yes, but pre-paid | Same as L0 with ~instant attach | Background footprint; snapshot infra on remote |
| L2 **Player-build "Viewport Service"** (E3) | **No** | Game view exactly; "scene-view-like" orbit camera with runtime grid/gizmos/selection we re-implement; runtime inspector via reflection | No editor seat at runtime; cold start ~2-5s; NOT the real editor UI -- no AssetDatabase, no editor tooling |
| L3 UaaL desktop embed (E4) | No | L2 rendered inside our own native shell window | Windows semi-documented; macOS undocumented -- exploratory |
| L4 DLL mount of editor assemblies (E1) | -- | **Expected: nonviable** beyond metadata/pure-managed code | One afternoon to prove and archive |

Honest summary: L-1 is how we make the developer surface feel unified and binding-like without crossing the line. For the *real* Scene View with real handles/inspector, L0/L1 is still the floor. L2 is the true "without Unity" renderer and pairs with the deployed-instance goal (it is also the `host: "player"` lane the protocol already anticipates). L4 exists to kill the DLL-mount question with evidence.

### 3.1 Workaround ladder -- "same editor output" without EULA risk (reviewed 2026-06-10)

There is no loophole to find, because none is needed: the EULA licenses *running the official editor per seat* and restricts *redistribution, derivation, license tampering, and offering Unity as a hosted service to third parties*. It does not restrict where a licensed, installed editor's pixels and data go on behalf of that same licensed user. Every workaround below stays inside that reading; W0 is already shipped in this repo.

| # | Workaround | Output parity | EULA posture | Status |
| --- | --- | --- | --- | --- |
| W0 | Hidden installed editor + in-process `GUIView.GrabPixels` + `SendEvent`, streamed over our protocol | Pixel-exact real editor windows | Uses the user's own installed, licensed editor; nothing redistributed or modified | **Shipped + proven on macOS** (audit: 12 pass / 1 pending) |
| W1 | Offscreen UI Toolkit re-host (E7): bind real `InspectorElement`/editor UITK controls to a runtime panel rendering into a RenderTexture inside the licensed editor | Real editor widgets, our compositor; window-size independent; maybe batchmode-viable | Public API inside the licensed editor | Experiment E7, unproven |
| W2 | Batchmode semantic mirror: `-batchmode` editor as data server (SerializedObject dumps, `UnityEditor.PackageManager.Client` API, menu enumeration) + Cursor-native panels | Same *information*, our pixels; default inspectors high parity; custom IMGUI inspectors are the long tail | Public API inside the licensed editor | Seeds exist (`manage_scene`/`manage_component` tools) |
| W3 | Player Viewport Service | Scene/game *content* rendering is the same engine output; editor chrome re-implemented | Player runtime needs no editor seat; freely distributable | **Green on macOS** (E3) |
| W4 | Remote editors on hosts we control, streamed to our own licensed users; BYOL for third parties (their seat, their machine/VM, our orchestration) | Pixel-exact, displaced | Own-org use = normal seat usage; *hosting editors for third parties* needs a Unity agreement -- BYOL sidesteps that cleanly | VDD lane prototyped |
| W5 | Unity Enterprise / source-access negotiation | Whatever is contracted, including deeper embedding | The only official "loophole": pay for the rights | Business decision, not engineering |

Never-safe list (violations, not workarounds): forging/binding icall tables, shipping Unity-derived stub assemblies or generated API clones, patching/spoofing/proxying license checks, redistributing editor/engine binaries, multiplexing one seat across concurrent users, decompiling editor code to copy its implementation.

On "use the existing Unity without redistributing it": that is precisely W0's design. The toolkit is an editor package + extension; every machine brings its own Hub-installed, activated editor, and we never ship Unity bits. Keep installers/CI fetching Unity through the user's own Hub/license and distribution stays clean.

Caveat: this table is engineering's reading of the ToS, not legal advice. Before selling a hosted/streamed editor product to third parties, have counsel or Unity's partner team confirm the W4 boundary.

## 4. Experiment matrix (specs live in the agent prompt)

| # | Name | Question | Verdict gate |
| --- | --- | --- | --- |
| E1 | Editor DLL mount probe | Where exactly does loading UnityEditor/UnityEngine DLLs in a plain .NET 8 host die? | Report JSON with per-probe outcomes; expected: managed math PASS, any engine icall FAIL |
| E2 | Hidden editor cost baseline | What does L0 actually cost (time-to-first-frame, RSS, CPU idle/streaming)? | Numbers recorded; informs whether L2 is worth building now |
| E3 | Player Viewport Service | Can a tiny player build serve scene-like + game frames over our existing protocol with <5s cold start? | Streams into the existing Cursor panels with `host:"player"`; orbit camera works |
| E4 | UaaL desktop probe | Can `UnityPlayer` be hosted in our shell window (Windows first)? | Spike report only; optional |
| E5 | License automation | Scripted activate/return for hidden+remote editors; floating-server eval for deployed pools | Dry-run scripts + doc of chosen model |
| E6 | Instant-attach editor | Login-launch + hide; VM snapshot resume on remote | Attach latency measurements |
| E7 | Offscreen UITK re-host (workaround W1) | Can real editor UI components (`InspectorElement`, editor controls) render into a RenderTexture via a runtime panel, with input, without any GUIView window? | Non-blank `InspectorElement` RT capture + a synthetic click changing a bound property, or the exact documented blocker; batchmode behavior recorded either way |

## 5. Decision tree after experiments

1. E1 confirms nonviable (expected) -> archive the DLL idea permanently with the report linked here.
2. E2 shows hidden editor idle cost acceptable on dev hosts (macOS and Windows) -> ship plan M3 (hidden editor) as the local default; L2 becomes the *deployed/remote* renderer rather than a local replacement.
3. E3 hits <5s cold start + stable streaming -> promote Viewport Service to the default for "Unity closed" game view, and the only renderer on license-less hosts.
4. E5 picks the licensing model for remote: per-VM serial vs floating server (pools >2 VMs => floating server).
5. E4/E6 only graduate if a concrete UX need appears (native shell embedding, instant attach).

## 6. Current status

- [x] Research + lanes ranked (this doc)
- [x] E1 scaffold committed: `experiments/editor-dll-mount-probe/`
- [x] E1 run on Unity 6000.3.9f1 / macOS -> `experiments/editor-dll-mount-probe/results/2026-06-10-6000.3.9f1-macos.json`
- [x] E2 macOS warm measurements (three warm hidden spikes, macOS 12fps stream run, live Cursor sample, five-surface Cursor/bridge proof, post-crash resource-clamp retest, and rebuilt-Cursor Scene/Game proof recorded; opt-in cold run, soak, and Windows host proof remain)
- [x] E3 ViewportService build target in `CursorUnityTool` (macOS player build/probe green; Cursor player Scene/Game host-selection commands, installed Cursor visual proof, and `1280x720@30` perf measurement complete; Windows build proof still pending)
- [x] E5 activation scripts in `unity-cursor-toolkit/scripts/`
- [x] E4 desk check written (Windows `-parentHWND`/UaaL = GO when Windows host exists; macOS native embed = NO-GO, streaming is the answer)
- [x] E6 decision recorded (skipped per spec; warm-daemon attach already sub-second per auto-proof; reopen only for cold instant-attach needs)
- [ ] E7 offscreen UITK re-host spike (workaround W1; spec in the agent prompt) -- unproven either way

Windows remains a hard acceptance gate for this prompt, not a polish item. Before this series can be called fulfilled, run the E1 DLL probe, the E2 hidden `GUIView.GrabPixels` spike, the installed Cursor Scene/Game automated frame-hash proof, and the E3 Viewport Service build/run/probe on a Windows editor host. The Windows runner now writes `windows-proof-summary.json`; the fulfillment audit automatically validates that executed `win32` summary plus its E1/E2/installed-Cursor/E3 artifacts and flips `windows-proof` from pending to pass only after those checks succeed. Record whether PowerShell/user32 hiding changes repaint/input behavior and whether the player lane should use `-parentHWND`, `UnityPlayer.dll`, Windows Graphics Capture, or the existing protocol-only windowed player.

Run order and full instructions for the executing agent: `docs/prompts/unity-without-editor-agent-prompt.md`.

### Prompt fulfillment audit -- 2026-06-10

This section tracks the handoff prompt as an acceptance checklist, not just as a plan. Current verdict: **partially fulfilled**. The macOS hidden-editor/editor-window lane is proven and integrated into Cursor, but the full "Unity Without The Editor" experiment series is not done.

| Prompt requirement | Status | Evidence / blocker |
| --- | --- | --- |
| Respect licensing/EULA guardrails | Fulfilled so far | No license bypass, patched loader, native engine redistribution, forged icall table, or Unity-derived stub assemblies were added. Rendering happens in the installed Unity editor; the facade boundary is our DTO/protocol surface. |
| Clean-room facade/binding shell allowed boundary | Fulfilled as architecture, not a separate SDK yet | This doc defines the allowed shell: own DTOs, TypeScript types, MCP schemas, and helper APIs forwarding to official editor/player adapters. No fake `UnityEditor` runtime is present. |
| E1: prove editor DLL mounting result | Fulfilled on macOS | `experiments/editor-dll-mount-probe` builds, macOS result JSON is archived, and the verdict confirms metadata/pure-managed only; editor icalls fail outside the official editor binary. Windows E1 is still pending. |
| E2: hidden editor baseline | Fulfilled for macOS warm/local baseline; Windows and opt-in cold/soak remain | The spike supports `--measure`; `measure:editor-stream` samples live editor-stream cost; three warm hidden runs, one script-owned macOS Scene View 12fps run, one live Cursor-rendering sample, an installed Cursor visual proof, and automated installed-Cursor frame-hash proofs are recorded. Optional cold numbers still require explicit approval to wipe `CursorUnityTool/Library`; sustained soak remains product-hardening work; Windows host run is tracked by the Windows gate. |
| Real editor windows in Cursor without user manually opening Unity | Fulfilled on macOS for Scene/Game/Inspector/Package Manager/custom EditorWindows | Cursor auto-launches the installed editor hidden, connects after toolkit JSON `ping`/`pong`, and streams real Scene/Game/Inspector/Package Manager/custom `EditorWindow` pixels in-band. Custom `window:<type>` has a generic Cursor command that prompts for a full type name. `smoke:installed-cursor-viewports` packages the VSIX, installs it into isolated Cursor user-data/extensions dirs, verifies the viewport command surface, and can run opt-in proof mode that auto-opens editor Scene/Game panels from the packaged extension. Installed-Cursor UI proof records live editor Scene View and Game View panels in Cursor using the official hidden Unity editor bridge; the automated proofs archive frame dimensions, byte counts, and SHA-256 hashes for both live editorWindow streams, including the rebuilt Cursor `3.7.27` proof on 2026-06-10. |
| Windows editor host coverage | Pending | Code paths and docs include Windows Hub resolution and PowerShell/user32 hide attempts, and `npm --prefix unity-cursor-toolkit run proof:windows-unity-without-editor` now orchestrates the E1/E2/installed-Cursor/E3 Windows evidence run and writes `windows-proof-summary.json`. The audit validates that summary only when the packaged Cursor proof archives live editor Scene/Game frame hashes on `win32`; the required Windows visual/spike proof has not been run. Do not claim cross-platform parity yet. |
| E3: player-build Viewport Service | Fulfilled for macOS protocol/player proof, Cursor host-selection shell, installed Cursor visual proof, and player perf; Windows proof pending | `Assets/ViewportService/ViewportServiceServer.cs`, `Assets/Scenes/ViewportService.unity`, build/run/probe/measure scripts, and a macOS player build now exist. `probe:viewport-service` proves `ping/pong`, Scene/Game in-band player frames, and runtime scene input. Cursor now contributes explicit Player Scene/Game panels that request `host:"player"` + `captureMode:"camera"` and attach to a running Viewport Service without invoking hidden-editor launch. Installed Cursor has rendered both Player Scene and Player Game panels live from the Viewport Service. `measure:viewport-service` records cold start, first frame, RSS, CPU, frame size, bytes, and effective fps for `1280x720@30`. Windows build/run/probe remain before this is a polished no-editor product lane. |
| E4: UaaL/native-shell probe | Fulfilled as macOS desk check; Windows hands-on deferred | The feasibility note below records Windows `UnityPlayer.dll` / `-parentHWND` as a future GO path when a Windows host exists, and macOS native embedding as NO-GO; streaming remains the macOS answer. |
| E5: license automation | Fulfilled for dry-run/local CLI wrapper | `unity-cursor-toolkit/scripts/unity-license.js` provides dry-run-first `activate`, `return`, and `status` commands, masks `UNITY_EMAIL`, `UNITY_PASSWORD`, and `UNITY_SERIAL`, and requires `--execute` before running Unity. Production VM pool rollout still needs the chosen org licensing backend. |
| E6: instant attach | Skipped per spec | E3 is green on macOS and warm editor attach is already sub-second against a running bridge. Reopen only if cold instant-attach becomes a product requirement. |
| Repeatable fulfillment audit | Partial by design | `npm --prefix unity-cursor-toolkit run audit:unity-without-editor` checks legal guardrails, E1/E2/E3/E5 artifacts, Cursor command wiring, isolated installed-Cursor smoke, installed-Cursor live editor UI proof, automated installed-Cursor editor frame proof, Unity capture implementation, player perf, the Windows proof runner, and the remaining Windows gate. If `experiments/windows-unity-without-editor/results/**/windows-proof-summary.json` exists from an executed Windows run, the audit validates the summary, Windows preflight artifact, E1 verdict, E2 capture/input result, E2 measure JSON, installed-Cursor Scene/Game frame-hash proof JSON, E3 probe transcript, and E3 `1280x720@30` perf JSON before passing `windows-proof`; dry-runs stay pending. Latest result: `experiments/unity-without-editor-audit/results/2026-06-10-current.json` -> 12 pass, 1 pending, 0 fail. |
| Final recommendation section | Preliminary recommendation written | Local default is L0 hidden editor; deployed/license-less lane is L2 player service; remote real-editor hosts need their own licensed editor seats. Final sign-off is blocked only by the executed Windows proof; cold/soak/E7 are opt-in follow-ups. |

### E1 results -- Unity 6000.3.9f1 / macOS

Report: `experiments/editor-dll-mount-probe/results/2026-06-10-6000.3.9f1-macos.json`.

Verdict: **CONFIRMED**. Loading the installed managed assemblies in a plain .NET 8 host gives metadata and pure-managed execution only; engine/editor-bound members fail outside the official Unity editor binary.

Observed probes:

- `UnityEngine.CoreModule.dll` loaded; 6152 types enumerated.
- `UnityEditor.CoreModule.dll` loaded; 12248 types enumerated; `SceneView`, `EditorWindow`, `GUIView.GrabPixels`, and `InspectorWindow` are present as metadata.
- `Vector3.Dot` executed in-host and returned `2`, proving pure managed code can run.
- `Application.unityVersion` failed as expected with `System.Security.SecurityException: ECall methods must be packaged into a system module.`
- `new SceneView()` failed as expected with `System.TypeInitializationException`.
- Sampled icall density: 129 of 2429 sampled public UnityEngine methods were `[InternalCall]`.

Conclusion: DLL mounting is not a viable editor-rendering lane. Keep editor pixels inside L0/L1 (official editor process, hidden if needed), and use L2/E3 player service for the legitimate no-editor-runtime lane.

Windows status: pending. Run the same E1 probe and the `spike:editor-windows -- --hide` capture spike on a Windows editor host before claiming Windows runtime parity.

### E2 results -- warm hidden editor spike

Artifacts:

- Measurement JSON: `experiments/hidden-editor-cost-baseline/results/2026-06-10-6000.3.9f1-macos-warm-spike-measure.json`
- Spike result JSON: `experiments/hidden-editor-cost-baseline/results/2026-06-10-6000.3.9f1-macos-warm-spike-result.json`
- Warm run 2 measurement JSON: `experiments/hidden-editor-cost-baseline/results/2026-06-10-6000.3.9f1-macos-warm-spike2-measure.json`
- Warm run 2 result JSON: `experiments/hidden-editor-cost-baseline/results/2026-06-10-6000.3.9f1-macos-warm-spike2-result.json`
- Warm run 3 measurement JSON: `experiments/hidden-editor-cost-baseline/results/2026-06-10-6000.3.9f1-macos-warm-spike3-measure.json`
- Warm run 3 result JSON: `experiments/hidden-editor-cost-baseline/results/2026-06-10-6000.3.9f1-macos-warm-spike3-result.json`
- Scene View 12fps stream JSON: `experiments/hidden-editor-cost-baseline/results/2026-06-10-6000.3.9f1-macos-scene-12fps-stream-measure.json`
- Live Cursor stream sample JSON: `experiments/hidden-editor-cost-baseline/results/2026-06-10-6000.3.9f1-macos-cursor-live-stream-sample.json`

Run: `npm --prefix unity-cursor-toolkit run spike:editor-windows -- --hide --force --measure --timeout 420` on Unity 6000.3.9f1 / macOS 26.5.0.

Result: **GREEN** for hidden real-EditorWindow capture and SceneView input. Scene View, Game View, Inspector, Package Manager, and a custom `EditorWindow` all captured non-blank pixels through `GUIView.GrabPixels`; SceneView `Alt+drag` changed rotation by `13.275` degrees through `EditorWindow.SendEvent`.

Warm hidden launch campaign:

| Run | Result | Time to result | Peak sampled RSS | Peak sampled CPU | Capture/input proof |
| --- | --- | ---: | ---: | ---: | --- |
| 1 | GREEN | `28.478s` | `918.2 MB` | `117.7%` | All five windows non-blank; SceneView rotation changed `13.275` degrees. |
| 2 | GREEN | `20.061s` | `1168.6 MB` | `266.2%` | All five windows non-blank; SceneView rotation changed `13.275` degrees. |
| 3 | GREEN | `22.173s` | `667.3 MB` | `215.1%` | All five windows non-blank; SceneView rotation changed `13.276` degrees. |

Warm launch-to-result range: `20.061s` to `28.478s`; median `22.173s`. The peak RSS/CPU spread is expected for editor import/repaint timing and supports keeping adaptive fps/resolution as the default policy.

Installed Cursor extension proof: opening `Unity Toolkit: Open Scene View` from Cursor launched the installed Unity editor for `CursorUnityTool` with `-executeMethod UnityCursorToolkit.HotReloadHandler.Start`, connected to the toolkit JSON bridge on port `55500`, and auto-started the real Scene View stream. Opening `Unity Toolkit: Open Game View` auto-started a second real Game View stream. Computer Use inspection showed both Cursor webviews rendering live frames: Scene View `1600x1040 #506` and Game View `1572x865 #257`.

Additional Cursor panel proof: `Unity Toolkit: Open Inspector` and `Unity Toolkit: Open Package Manager` now open first-class Cursor webviews. Computer Use inspection showed the Inspector rendering a live `2024x2040 #87` Unity editor frame and Package Manager advancing through live `2024x2040` frames before the resource-clamp patch.

Post-clamp five-surface bridge proof: after concurrent full-resolution editor-window streams exposed a Unity native graphics/profiler crash, `EditorWindowViewportCapture` was updated to reuse render resources and downscale to the requested stream size. The repeat probe completed without crashing: Scene `554x360`, Game `640x352`, Inspector `357x360`, Package Manager `357x360`, and custom `UnityCursorToolkit.InternalSmoke.UCTSpikeProbeWindow` `540x360`, all `captureMode:"editorWindow"`, `hasData:true`, `hasPath:false`, with Scene input routed through the `editorWindow` layer.

Follow-up live verification after attach hardening: Cursor was connected to hidden Unity on port `55500`; Game View advanced from `#5875` to `#6085`; after clearing a stale direct-probe Scene View session, Scene View restarted and advanced from `#6` to `#164`. The Scene panel rendered the actual Unity editor Scene View pixels, including toolbar/overlay/gizmo UI, and the Game panel rendered the actual Game View. Process sanity showed one hidden Unity editor backend, Cursor connected to it, no ViewportService player, and no leftover direct Node probe helper.

Connection hardening added during this proof: Cursor now treats TCP connect as insufficient and requires a JSON `pong` response during attach, so Unity's built-in editor/player listener on `55504` is not mistaken for the toolkit bridge. The Unity bridge answers `ping` immediately on the socket thread, keeping attach probes responsive while the editor is importing, repainting, or processing queued main-thread work.

Fresh installed-VSIX retest after the viewport panel cleanup: a stale disposed-panel reopen path was fixed by marking `UnityViewportPanel` disposed immediately, clearing the panel reference, and notifying the owner before awaiting `viewport_stream stop`. Cursor was repackaged and reinstalled, then Scene View and Game View were reopened through Unity Quick Actions. Both panels started cleanly, displayed live real-Unity frames, and kept toolkit status/meta text in the bottom status bar instead of overlaying HUD text on top of the captured Unity pixels. Runtime tests now guard against reintroducing `viewport-hud` / `streamBadge` overlays into the webview source.

Additional stream-cost harness: `npm --prefix unity-cursor-toolkit run measure:editor-stream`. The bridge-owned mode starts its own `viewport_stream` session through the toolkit bridge. `--sample-only` measures an already-live Cursor session without starting another stream.

Canonical stream run from the repo root: `npm --prefix unity-cursor-toolkit run measure:editor-stream -- --idle-seconds 15 --duration 60 --fps 12 --out ../experiments/hidden-editor-cost-baseline/results/2026-06-10-6000.3.9f1-macos-scene-12fps-stream-measure.json`.

Observed during the canonical run (Unity PID `69852`, Scene View `editorWindow`, 12fps target):

- Idle pre-stream sample window: 15s, 3 process samples.
- Stream window: 60s, 12 process samples.
- Frames: `717`, effective `11.95fps`, frame data `92168` bytes each.
- Idle RSS: min `977.7 MB`, max `1199.7 MB`, avg `1077.5 MB`.
- Idle CPU: min `176.1%`, max `220.8%`, avg `191.0%`.
- Streaming RSS: min `925.5 MB`, max `1882.0 MB`, avg `1294.0 MB`.
- Streaming CPU: min `174.8%`, max `344.2%`, avg `242.2%`.
- Errors: none.

Interpretation: forcing full-resolution `GUIView.GrabPixels` + JPEG at 1600x1040 and 12fps is functional but CPU-heavy. The v1 product should keep Scene View fps/resolution adaptive and prioritize lower default rates unless the user explicitly needs smoother interaction. The post-clamp retest proves the lower-resolution resource-reuse path works, but Unity still logged profiler buffering pressure during validation, so sustained multi-window soak testing remains required.

Live Cursor sample run from the repo root: `npm --prefix unity-cursor-toolkit run measure:editor-stream -- --sample-only --duration 60 --out ../experiments/hidden-editor-cost-baseline/results/2026-06-10-6000.3.9f1-macos-cursor-live-stream-sample.json`.

Observed during the live sample (Unity PID `69852`, Cursor panels already rendering Scene/Game):

- Duration: 60s, 12 process samples.
- RSS: min `119.5 MB`, max `222.6 MB`, avg `162.9 MB`.
- CPU: min `2.2%`, max `5.0%`, avg `3.6%`.
- Errors: none.

Interpretation: this is valid evidence for the already-live Cursor-rendering backend cost in that current session, but it does not include frame counts because `--sample-only` intentionally does not start or observe a stream.

Remaining E2 work:

- Optional cold run after explicit operator approval to wipe `CursorUnityTool/Library`; do not run this casually.
- Optional sustained multi-window soak to quantify profiler pressure and long-session stability.
- Windows hidden `GUIView.GrabPixels` spike through the Windows proof runner; record whether user32/PowerShell hiding affects repaint/input.

### E3 results -- macOS Viewport Service player proof

Runtime service:

- `CursorUnityTool/Assets/ViewportService/ViewportServiceServer.cs` -- player-safe MonoBehaviour, no `UnityEditor` references.
- `CursorUnityTool/Assets/Scenes/ViewportService.unity` -- build scene generated by the editor build step.
- `CursorUnityTool/Assets/Editor/ViewportServiceBuild.cs` -- editor-only build automation; the editor is used only for the licensed build step.

Node scripts:

```bash
npm --prefix unity-cursor-toolkit run build:viewport-service
npm --prefix unity-cursor-toolkit run run:viewport-service -- --hide
npm --prefix unity-cursor-toolkit run probe:viewport-service
npm --prefix unity-cursor-toolkit run measure:viewport-service -- --hide
```

Build run:

```bash
npm --prefix unity-cursor-toolkit run build:viewport-service -- --target macos --timeout 900
```

Result: **GREEN** on Unity 6000.3.9f1 / macOS. The command produced `CursorUnityTool/Builds/ViewportService/ViewportService.app`.

Runtime run:

```bash
npm --prefix unity-cursor-toolkit run run:viewport-service -- --player /Users/dudetru25/GithubProjects/unity-cursor-toolkit/CursorUnityTool/Builds/ViewportService/ViewportService.app --port 55500 --hide
```

Result: player answered toolkit `ping` on `127.0.0.1:55500`.

Probe:

```bash
npm --prefix unity-cursor-toolkit run probe:viewport-service
```

Observed:

- Connected to Viewport Service on port `55500`.
- Scene frame: `640x360`, `host:"player"`, `captureMode:"camera"`, in-band data length `19892`.
- Game frame: `640x360`, `host:"player"`, `captureMode:"camera"`, in-band data length `19892`.
- Scene input routed through the runtime layer.

Conclusion: the legitimate no-editor-runtime lane now exists as a working macOS player proof. It is not real editor UI and does not claim SceneView/Inspector parity; it is a player runtime with exact game-camera rendering plus a scene-like runtime orbit camera/grid.

Cursor shell update: the extension now contributes `Unity Toolkit: Open Player Scene View` and `Unity Toolkit: Open Player Game View`, plus Quick Actions for both. These panels are separate from the real editor-window Scene/Game panels, keep `host:"player"` in panel state, start streams with `captureMode:"camera"`, and call the connection manager directly so Connect attaches to an already running Viewport Service instead of launching the hidden Unity editor. Editor panels remain the default for real Scene/Game/Inspector/Package Manager/custom EditorWindow streaming.

Post-shell direct player probe: `run:viewport-service -- --player ... --port 55500 --hide --timeout 45` answered toolkit ping, and `probe:viewport-service` returned Scene and Game frames at `640x360`, `host:"player"`, `captureMode:"camera"`, in-band data length `20564`, with scene input routed through the runtime layer. The temporary player listener was stopped afterward.

Installed Cursor player visual proof: after installing `/tmp/unity-cursor-toolkit-smoke.vsix` into Cursor and reloading the window, the command palette exposed `Unity Toolkit: Open Player Scene View` and `Unity Toolkit: Open Player Game View`. With the Unity editor not running and the Viewport Service player attached on `127.0.0.1:55500`, Cursor rendered both panels live: Player Scene View `1280x720 #1271`, Player Game View `1280x720 #465`, both with Connect tooltips saying "Attach to a running Viewport Service player bridge". Screenshot evidence was saved to `/tmp/uct-cursor-player-scene-game-proof.png`.

Installed Cursor isolated package smoke:

```bash
npm --prefix unity-cursor-toolkit run smoke:installed-cursor-viewports -- --out ../experiments/installed-cursor-smoke/results/2026-06-10-isolated-install.json
```

Result JSON: `experiments/installed-cursor-smoke/results/2026-06-10-isolated-install.json`.

Observed on Cursor `3.6.31` / macOS:

- Packaged `/tmp/unity-cursor-toolkit-smoke.vsix` with local `vsce`.
- Installed into isolated Cursor dirs under the OS temp folder, not the user's normal Cursor profile.
- `cursor --list-extensions --show-versions` returned `rankupgames.unity-cursor-toolkit@0.6.1052828`.
- The packaged manifest exposed Scene View, Game View, Player Scene View, Player Game View, Inspector, Package Manager, and Custom EditorWindow commands.

This smoke proves the packaged Cursor surface is installable and command-complete. Pixel proof is covered by the installed-Cursor visual inspection, the automated installed-Cursor editor frame proof below, and the bridge/player probes.

Installed Cursor editor Scene/Game UI proof:

Result JSON: `experiments/installed-cursor-smoke/results/2026-06-10-installed-editor-scene-game-ui.json`.

Screenshot: `experiments/installed-cursor-smoke/screenshots/2026-06-10-installed-cursor-editor-scene-game.png`.

Observed with Computer Use after running the isolated Cursor smoke with `--open`:

- Cursor command palette exposed `Unity Toolkit: Open Scene View` and `Unity Toolkit: Open Game View` from the installed extension.
- Opening Scene View launched the official installed editor process: `/Applications/Unity/Hub/Editor/6000.3.9f1/Unity.app/Contents/MacOS/Unity -projectPath .../CursorUnityTool -executeMethod UnityCursorToolkit.HotReloadHandler.Start`.
- Unity bridge listened on `55500`; Cursor status showed `Connected to Unity on port 55500`.
- `Unity Scene View` panel showed `image Unity Scene View frame`, `Live frame 307`, `1108x720 #307`.
- `Unity Game View` panel showed `image Unity Game View frame`, `Live frame 126`, `1279x704 #126`.

Installed Cursor automated editor Scene/Game frame proof:

```bash
npm --prefix unity-cursor-toolkit run smoke:installed-cursor-viewports -- --open --user-data-dir /tmp/uct-cursor-auto-proof7-user-data --extensions-dir /tmp/uct-cursor-auto-proof7-extensions --out ../experiments/installed-cursor-smoke/results/2026-06-10-installed-editor-scene-game-auto-smoke.json --viewport-proof-out ../experiments/installed-cursor-smoke/results/2026-06-10-installed-editor-scene-game-auto-proof.json --viewport-proof-timeout-ms 120000
```

Smoke result: `experiments/installed-cursor-smoke/results/2026-06-10-installed-editor-scene-game-auto-smoke.json`.

Proof result: `experiments/installed-cursor-smoke/results/2026-06-10-installed-editor-scene-game-auto-proof.json`.

Observed from the packaged extension running in isolated Cursor dirs:

- Extension `rankupgames.unity-cursor-toolkit@0.6.1052828` activated inside Cursor `3.6.31`.
- The extension auto-opened editor-hosted Scene/Game panels only because the temporary smoke workspace set `unityCursorToolkit.viewportProof.out`.
- Connection state was `connected` on Unity bridge port `55500`.
- Scene panel used `host:"editor"` and `captureMode:"editorWindow"`, received `Live frame 1`, `1108x720`, `45685` bytes, SHA-256 `c72f842fdd99e6abc258476683807f5cb37872178bd2560632c5d6d3264c07b8`.
- Game panel used `host:"editor"` and `captureMode:"editorWindow"`, received `Live frame 1`, `1280x704`, `31996` bytes, SHA-256 `bae3b7998f95fa743ced83402f9403cb041b9ae9bdb1359a6df63d1d32361f0d`.

Rebuilt Cursor closeout proof on 2026-06-10:

```bash
npm --prefix unity-cursor-toolkit run smoke:installed-cursor-viewports -- --open --keep-open --cursor /Applications/Cursor.app/Contents/Resources/app/bin/cursor --user-data-dir /tmp/uct-proof-c372-ud --extensions-dir /tmp/uct-proof-c372-ext --out ../experiments/installed-cursor-smoke/results/2026-06-10-cursor372-smoke.json --viewport-proof-out ../experiments/installed-cursor-smoke/results/2026-06-10-cursor372-proof.json --viewport-proof-timeout-ms 300000 --screenshot ../experiments/installed-cursor-smoke/screenshots/2026-06-10-cursor372-clean-scene-game.png
```

Smoke result: `experiments/installed-cursor-smoke/results/2026-06-10-cursor372-smoke.json`.

Proof result: `experiments/installed-cursor-smoke/results/2026-06-10-cursor372-proof.json`.

Screenshot: `experiments/installed-cursor-smoke/screenshots/2026-06-10-cursor372-clean-scene-game.png`.

Observed from the rebuilt installed Cursor proof:

- Cursor CLI reported `3.7.27`, commit `e48ee6102a199492b0c9964699bf011886708ba0`, `arm64`.
- The packaged extension `rankupgames.unity-cursor-toolkit@0.6.1052828` installed into isolated Cursor dirs and connected to the hidden Unity bridge on `55500`.
- Scene panel used `host:"editor"` and `captureMode:"editorWindow"`, received `Live frame 3`, `1108x720`, `41755` bytes, SHA-256 `ac56fbf826315ffb3681e1ca327f84c9814a238c522fbbfd68f705ff4df08b03`.
- Game panel used `host:"editor"` and `captureMode:"editorWindow"`, received `Live frame 3`, `1279x704`, `32166` bytes, SHA-256 `e93413f552633f96726fb27f0bc15bceace0f0ab2141825b98172c19ba96f80c`.
- The clean screenshot shows both Cursor webview panels streaming; the hidden Unity editor and isolated Cursor proof window were closed afterward, and the stale `CursorUnityTool/Temp/UnityLockfile` was removed.

Failed proof attempts preserved as evidence:

- `experiments/installed-cursor-smoke/results/2026-06-10-live-rerun-smoke.json`: `cursor --version` returned no stdout and the runner failed before installing/opening Cursor. Log: `/tmp/uct-live-rerun.log`.
- `experiments/installed-cursor-smoke/results/2026-06-10-live-rerun2-smoke.json` plus `experiments/installed-cursor-smoke/results/2026-06-10-live-rerun2-proof.json`: Cursor `3.7.21` installed and opened the proof workspace, but the proof timed out after `180000ms` with both panels stuck in `connection.state:"connecting"` and no port. The follow-up fix pinned `UNITY_CURSOR_TOOLKIT_PROJECT_PATH` for isolated proof workspaces and retried auto-start when the webview signaled `ready`, then the rebuilt Cursor proof passed. Log: `/tmp/uct-live-rerun2.log`.

This is the strongest current macOS proof for the product goal: Cursor renders the real editor-backed Scene and Game views in the same workspace using the user's installed Unity editor as backend.

Perf measurement:

```bash
npm --prefix unity-cursor-toolkit run measure:viewport-service -- --player /Users/dudetru25/GithubProjects/unity-cursor-toolkit/CursorUnityTool/Builds/ViewportService/ViewportService.app --port 55501 --view game --width 1280 --height 720 --fps 30 --quality 72 --idle-seconds 5 --duration 30 --timeout 60 --hide --out ../experiments/player-viewport-service/results/2026-06-10-6000.3.9f1-macos-game-1280x720-30fps.json
```

Result JSON: `experiments/player-viewport-service/results/2026-06-10-6000.3.9f1-macos-game-1280x720-30fps.json`.

Observed on Unity 6000.3.9f1 / macOS 26.5.0:

- Port-ready startup: `6572ms`.
- First frame from launch: `11692ms`; first frame after stream start: `87ms`.
- Frames: `866` over the 30s stream window; effective `28.89fps`.
- Frame size: `1280x720`, `host:"player"`, `captureMode:"camera"`; frame data `84328` bytes each.
- Idle RSS: average `272.5 MB`, max `284.5 MB`; idle CPU average `25.5%`, max `64.0%`.
- Stream RSS: average `199.5 MB`, max `287.5 MB`; stream CPU average `40.3%`, max `49.7%`.
- Errors: none. The measurement script stopped the player afterward; no `55501` listener or Viewport Service process remained.

Interpretation: the macOS player lane sustains near-target `1280x720@30` in-band streaming with low memory compared with the hidden editor lane. Cold port-ready startup missed the aspirational `<5s` target on this run, but once the stream starts the first frame lands quickly. Treat startup warming and Windows validation as productization work, not as blockers for the legality/architecture question.

Remaining E3 work before promoting it as a polished product lane:

- Add a repeatable installed-Cursor UI smoke harness if this proof needs to run in CI-like environments; current proof is manual UI automation plus screenshot.
- Repeat player cold/warm start, RSS, and fps at `1280x720@30` on Windows.
- Validate the build/run/probe sequence on Windows and decide whether to use `-parentHWND` / `UnityPlayer.dll` for native embedding.
- Keep generated `CursorUnityTool/Builds/ViewportService/` out of commits; it is a local build artifact.

Windows proof runner:

```bash
npm --prefix unity-cursor-toolkit run proof:windows-unity-without-editor:preflight -- --unity-path "C:\Program Files\Unity\Hub\Editor\6000.3.9f1\Editor\Unity.exe"
npm --prefix unity-cursor-toolkit run proof:windows-unity-without-editor -- --unity-path "C:\Program Files\Unity\Hub\Editor\6000.3.9f1\Editor\Unity.exe"
```

The preflight writes `windows-proof-preflight.json` and checks the Windows host before the expensive run: platform, Node/npm/npx/vsce, dotnet, Cursor CLI, PowerShell, Unity editor path, project markers, Unity lockfile, proof scripts, and proof ports. The full runner writes E1/E2/installed-Cursor/E3 result JSON plus `windows-proof-summary.json` under `experiments/windows-unity-without-editor/results/<date>-windows/`, runs the hidden EditorWindow spike with PowerShell/user32 hiding, runs the packaged installed-Cursor automated editor Scene/Game proof with archived SHA-256 frame hashes, builds the Windows Viewport Service player, probes Scene/Game/player input, measures `1280x720@30`, and cleans up the temporary player listener. From non-Windows hosts, use `--dry-run` only to inspect the command plan; dry-run summaries are intentionally ignored as proof by the audit.

Remote Windows proof launcher from this Mac:

```bash
npm --prefix unity-cursor-toolkit run proof:windows-unity-without-editor:remote -- --manifest "$PWD/remote_workspace/unity-shell.json"
```

This SSH wrapper reads `sshTarget`, `remoteRepoPath`, and `unityEditorPath` from the ignored `remote_workspace/unity-shell.json`, runs the Windows proof runner in the remote repo, then fetches only the generated proof files back to the local `experiments/windows-unity-without-editor/results/<date>-windows/` folder. Add `--preflight-only` to run and fetch only the remote preflight. If the real manifest is not present, `--dry-run --ssh-target <host> --remote-repo-path "C:\path\to\unity-cursor-toolkit"` prints the remote command plan without connecting. The local fulfillment audit still requires the fetched `win32` `windows-proof-summary.json`; a remote wrapper report or preflight alone is not proof.

Manual artifact import after a Windows-side run:

```bash
npm --prefix unity-cursor-toolkit run proof:windows-unity-without-editor:import -- --from "/path/to/copied/2026-06-10-windows"
```

The import command copies a result folder containing `windows-proof-summary.json` into the local audit tree and immediately runs the strict fulfillment audit. It rejects dry-run/planned summaries and non-`win32` summaries before copying, so a copied folder cannot accidentally satisfy the Windows gate unless it is an executed passing Windows proof.

### E4 results -- UaaL desktop embed desk check (macOS-only setup)

Per the experiment spec, this is a documentation-research desk check; no Windows host was available, so no code was written.

- **Windows: viable documented seam.** Unity officially documents integrating the Windows player into host applications ("Unity as a Library", `UnityPlayer.dll`; see References), and windowed players support `-parentHWND <hwnd>` to render inside a host-supplied window. This is the natural future seam for `native-shell/UnityVddShell` to host the Viewport Service player natively. Defer the hands-on probe to the Windows evidence run.
- **macOS: no-go for native embedding.** There is no documented desktop UaaL for macOS, and AppKit offers no supported cross-process `NSView`/window reparenting. Closest options remain what we already do (protocol streaming into Cursor webviews) or coordinating a borderless player window positioned by our shell; ScreenCaptureKit window capture stays a fallback lane.
- Go/no-go: **GO** for a Windows `-parentHWND` probe when the Windows host is provisioned (fold into the Windows proof trip); **NO-GO** for macOS native embedding -- streaming is the macOS answer.

### E6 status -- instant-attach: skipped with rationale + existing data point

Skipped per spec ("skip if E3 succeeded and E2 showed acceptable cost"): E3 is green on macOS (port-ready `6572ms`, first frame `11692ms` from launch) and the E2 warm hidden-editor cost is acceptable (`~28.5s` launch-to-result, attach-to-running-bridge effectively instant).

Data point already in evidence: the automated installed-Cursor proof went from start to live Scene+Game frame hashes in `0.64s` against an already-running hidden editor -- i.e., a warm editor daemon delivers sub-second attach. If a product need for instant *cold* attach appears (login-item warm launch, VM snapshot resume for remote pools), reopen E6 with those two measurements; otherwise the warm-daemon behavior we already have covers it.

### E5 results -- license automation dry-run wrapper

Script: `unity-cursor-toolkit/scripts/unity-license.js`.

Package command:

```bash
npm --prefix unity-cursor-toolkit run unity:license -- status
npm --prefix unity-cursor-toolkit run unity:license -- activate
npm --prefix unity-cursor-toolkit run unity:license -- activate --manual
npm --prefix unity-cursor-toolkit run unity:license -- activate --manual --ulf /path/to/license.ulf
npm --prefix unity-cursor-toolkit run unity:license -- return
```

Verdict: **GREEN for local automation wrapper**. The script wraps only Unity's official editor command-line flows and defaults to dry-run. It prints the exact Unity invocation with credentials masked and does nothing to the real seat unless `--execute` is passed.

Supported flows:

- Serial/named-user activation: `Unity -quit -batchmode -serial ... -username ... -password ...`
- Return a seat: `Unity -quit -batchmode -returnlicense -username ... -password ...`
- Manual activation request: `Unity -batchmode -createManualActivationFile`
- Manual license import: `Unity -batchmode -manualLicenseFile <file>.ulf`
- Status helper: reports resolved Unity path, known local `.ulf` candidates, and whether required env vars are present. Unity does not expose a stable documented editor CLI "status" command, so authoritative seat status remains Unity Hub / Unity ID portal / Licensing Server admin.

Credential rules:

- `UNITY_EMAIL`, `UNITY_PASSWORD`, and `UNITY_SERIAL` are read from environment only.
- Dry-run output masks all credential values, including email and serial.
- `--execute` fails before launching Unity if required env vars or files are missing.
- No secrets belong in `remote_workspace/*.json`; Windows sidecar manifests should reference environment variable names supplied by the host/CI secret store.

Lane mapping:

| Lane | Runtime license requirement | Build/automation requirement |
| --- | --- | --- |
| L0 hidden editor | Editor seat required on the local machine | Use `unity:license activate --execute` only after operator approval, or rely on pre-activated Unity Hub |
| L1 warm editor/daemon | Editor seat required for each warm host | Floating Licensing Server is preferred when the pool has more than two hosts |
| L2 player Viewport Service | No editor seat at runtime | Editor seat or Build Server license is required only for the build step |
| L3 UaaL/player shell | No editor seat at runtime | Same as L2 |
| Remote Windows VDD editor | Editor seat required per active Windows editor host | Prefer Unity Licensing Server for VM pools; per-VM serials are acceptable for one or two stable hosts |

Validation: `npm run validate` covers the dry-run command planner, credential masking, manual activation/import commands, return safety, and Windows status path handling.

## 7. Recommendation (preliminary -- final sign-off blocked only by the Windows gate)

- **Local default lane: L0 hidden installed editor** with `captureMode:"editorWindow"` streaming. It is shipped, proven end-to-end in installed Cursor on macOS, and EULA-clean (W0). Adaptive fps/resolution must be the default policy, not an option: the measured full-resolution 12fps Scene stream averaged `242%` CPU on the Unity process, while the post-clamp downscaled path is stable.
- **Deployed / license-less lane: L2 player Viewport Service.** Exact engine rendering for game view plus the scene-like rig, ~`200 MB` RSS, ~`29fps` at 720p, no editor seat at runtime. Editor seats are consumed only by build steps and any remote *editor* hosts.
- **Remote real-editor needs: own-seat editors (VDD lane), floating Licensing Server for pools >2, BYOL for third parties.** Never host our seats for external users without a Unity agreement.
- **Closed lanes:** DLL mounting (E1: CONFIRMED nonviable), macOS native embedding (E4 desk check). **Open upgrades:** E7 offscreen UITK re-host could decouple Inspector/Package Manager panels from window geometry; Windows proofs port everything above to the second platform.
- Remaining before final: executed Windows proof (`proof:windows-unity-without-editor`). Opt-in follow-ups are multi-window soak, E2 cold-run numbers after an operator-approved `Library/` wipe, and E7 offscreen UITK re-host.

## 8. References

- Unity Terms of Service, "Use Restrictions" (reviewed June 10, 2026): https://unity.com/legal/terms-of-service
- Unity Manual, "Integrate Unity into Windows applications" (Unity as a Library / `UnityPlayer.dll`): https://docs.unity3d.com/Manual/UnityasaLibrary-Windows.html
- Unity Manual, "Manage your license through the command line": https://docs.unity3d.com/6000.4/Documentation/Manual/ManagingYourUnityLicense.html
- Unity Manual, "Submit a license request from a command line and browser (Windows)": https://docs.unity3d.com/6000.4/Documentation/Manual/ManualActivationCmdWin.html
