# Unity 6.6 -> Unity 7 Landscape Assessment

Status: dated research snapshot and planning input. Written 2026-07-23 from
the cited announcements, upgrade guide, official Unity MCP docs, and a repo
audit. Updated 2026-08-07 for the standalone CLI and Pipeline documentation;
documentation status reviewed 2026-08-13. Recheck external facts before an
implementation or marketing decision. This assessment does not certify Unity 7
support. Canonical readiness status: `UNITY_7_READINESS.md`. Companion docs:
`UNITY_CLI_AND_PIPELINE_ASSESSMENT.md`, `OFFICIAL_MCP_OVERLAP.md`,
`UNITY_WITHOUT_EDITOR_EXPERIMENTS.md`, `REMOTE_UNITY_STREAMING.md`,
`EDITOR_WINDOW_STREAMING_PLAN.md`, `FEATURE_ROADMAP.md`.

## 1. Dated landscape capture

The items below describe what the cited sources said on the capture dates. They
are not a current release calendar or compatibility matrix.

- **Unity 6.5** shipped June 2026 (current Supported release).
- **Unity 6.6+**: Fast Enter Play Mode becomes the default for new projects.
- **CoreCLR transition preview**: a captured upgrade source described
  experimental CoreCLR desktop-player work around the Unity 6.7 train. Recheck
  the exact Editor channel and support policy before a proof run.
- **Unity 6.8 target**: the captured roadmap described a CoreCLR-only scripting
  runtime and mandatory Fast Enter Play Mode. The captured upgrade guide listed
  these expected consequences:
  - No full domain reload: statics survive play-mode transitions and recompiles.
  - `AppDomain.CurrentDomain.DomainUnload` never fires; use `[AfterCodeReloadSerialization]` / `[BeforeCodeUnloading]` lifecycle attributes.
  - `AppDomain.CurrentDomain.GetAssemblies()` deprecated -> `UnityEngine.Assemblies.CurrentAssemblies.GetLoadedAssemblies()`.
  - Several `Assembly.Load` overloads (incl. `Assembly.Load(byte[])`) incompatible with code reload -> `CurrentAssemblies.LoadFromPath()`.
  - `Assembly.Location` returns empty string -> `Assembly.GetLoadedAssemblyPath()` (UnityEngine.CoreModule, 6.8+).
  - `UnityEditor.Scripting.ManagedDebugger` unsupported -> `System.Diagnostics.Debugger`.
  - Statics management: `[AutoStaticsCleanup]` for automatic reset, or custom cleanup bound to lifecycle events.
- **Unity 7 announcement snapshot**: the captured announcement gave an early
  beta and release window and described these targets:
  - Zero-rebuild upgrade path from Unity 6 (no rebuilding, no new language, nothing broken).
  - Partial domain reload: only changed assemblies reload -> near-instant play mode.
  - **Free official MCP** connecting coding agents to Unity.
  - Continued expansion of CLI/public APIs for validation, builds, deployment,
    and production-pipeline workflows.
  - Surface Cache GI, AI-assisted graphics optimization, Unity Vector (ads AI).
- **Official Unity MCP capture**: on 2026-08-02, the captured
  `com.unity.ai.assistant` package exposed an MCP relay and the inventory in
  `OFFICIAL_MCP_OVERLAP.md`.
- **Standalone Unity CLI capture**: on 2026-08-07, the experimental CLI was
  available independently of Unity 7. The
  experimental `unity` binary is separate from Hub and the Editor, manages
  multiple Editor versions, resolves projects through `ProjectVersion.txt`,
  and exposes Editor/module/project management, local build/run/test,
  licensing, diagnostics, connected-Editor commands, and MCP. Captured release:
  `1.0.0-beta.3` from 2026-07-23.
- **Unity Pipeline capture**: on 2026-08-07, documentation described
  `com.unity.pipeline`
  (`0.4.0-exp.1` in the captured docs). It requires Unity 6.0+ and provides an
  authenticated loopback API plus a large command catalog for live Editors and
  development Players. See `UNITY_CLI_AND_PIPELINE_ASSESSMENT.md` for the full
  inventory, security model, WIA reference snapshot, and adoption plan.
- **Hub CLI status at capture time**: the cited documentation deprecated it
  from Hub 3.18.0 and directed new automation toward the standalone CLI. Unity
  Build Automation remained a separate cloud service in that snapshot.

## 2. Virtualized shell assessment and inferences

- The current architecture still needs an Editor process to render Editor
  windows. The dated CLI, Pipeline, and Assistant inventory did not include a
  remote rendered-window and input shell. Recheck this comparison before
  product positioning.
- **Inference:** Editor architecture continuity may let the internal
  `GUIView.GrabPixels` and `SendEvent` path survive into Unity 7. It remains an
  internal API and needs an exact-version smoke test.
- **Hypothesis:** a CoreCLR Editor can change startup and steady-state cost.
  Re-run E2 on the selected transition Editor and use measurements, not an
  assumed improvement.
- Licensing and EULA conclusions are limited to the dated source review. The
  W0/W3/W4 lanes and the never-safe list in
  `UNITY_WITHOUT_EDITOR_EXPERIMENTS.md` remain the planning boundary.

## 3. What is threatened

1. **Mono debugger (port 56000): transition risk.** The current protocol is
   Mono-specific. WS3 must recheck permitted CoreCLR debugger options and prove
   attach behavior before a replacement is selected.
2. **Hot reload / IL patching: transition risk.** The captured CoreCLR guide
   identifies the current `Assembly.Load(byte[])` path as incompatible. WS1
   must gate or replace the path on the exact selected Editor.
3. **MCP basics: commoditized** by official Assistant and Pipeline surfaces.
   Do not compete on tool count; compete on version span, remote/rendered
   workflows, project-specific orchestration, structured context, and safety.
   See `OFFICIAL_MCP_OVERLAP.md` and
   `UNITY_CLI_AND_PIPELINE_ASSESSMENT.md`.

### Repo audit findings (CoreCLR-breaking API sites, non-third-party)

- `AppDomain.CurrentDomain.GetAssemblies()`: `Editor/MCP/EditorValidationTool.cs:608`, `Editor/MCP/EditorWindowViewportCapture.cs:312`, `Editor/MCP/MCPBridge.cs:44`, `Editor/HotReload/ILPatcher.cs:266,428,523`
- `Assembly.Load(dllBytes)`: `Editor/HotReload/ILPatcher.cs:381`
- Vendored Unterm hits: `UntermExecuteCodeTools.cs`, `UntermMcpServer.cs`, `UntermToolGroup.cs`, `UntermExternalCodeEditor.cs` (audit or upstream fixes to the vendor).
- `AssemblyReloadEvents` usage (`HotReloadHandler.cs:114`, `ProfilerSnapshot.cs`, `EditorWindowViewportCapture.cs:27`) — verify semantics under partial reload; the event model changes even if the API survives.

## 4. Current features, rated

Scale: value today / viability through 6.8 -> Unity 7 / differentiation vs official Unity stack, each out of 10.

| Feature | Today | 6.8/U7 | Diff. | Verdict |
| --- | --- | --- | --- | --- |
| Hot Reload (IL patching) | 8 | 3 | 4 | Sunset-by-version |
| Live Console (+ profiler fusion) | 8 | 8 | 7 | Keep, invest |
| Connection layer (TCP state machine) | 9 | 9 | n/a | Keep — it's the platform |
| Status Bar / Play Mode Control | 7 | 7 | 5 | Maintain |
| MCP Server | 9 | 6 | 5 -> 8 | Reposition (ops layer) |
| Mono Debugger | 8 | 1 | 9 | Replace with CoreCLR attach |
| Meta File Management | 6 | 6 | 6 | Maintain |
| Unity C# package | 9 | 5 as-is | n/a | CoreCLR audit now |
| Unterm (in-editor terminal) | 7 | 6 | 7 | Audit, keep |
| Virtualized shell (W0/W3/W4) | 7 | 9 | 10 | Invest — flagship |

Notes:

- **Hot Reload**: strongest today, weakest tomorrow. Gate by version: full IL patching for 2019.4-6.5; on 6.8+ becomes a thin wrapper over Unity's native reload. This is the backwards-compat story (section 7).
- **Live Console**: unaffected by announced changes; profiler-fused snapshots are not matched by the official MCP console tool. Safest asset.
- **MCP Server**: tool count and common local headless build/run/test workflows
  are commoditized. The remaining envelope is legacy-version support,
  remote/project-specific orchestration, rendered streaming, no AI Assistant
  dependency, explicit read-only/dry-run policy, `.umetacontext`, and a stable
  interface across backends.
- **Mono Debugger**: a current legacy-runtime differentiator and a
  high-urgency transition risk. WS3 owns the replacement feasibility proof.
- **Virtualized shell**: low "today" only because experimental/unshipped; highest strategic score of anything owned.

## 5. New offers, rated

Impact / effort / urgency out of 10 (urgency = cost of being late).

| Offer | Impact | Effort | Urgency | Call |
| --- | --- | --- | --- | --- |
| CoreCLR compatibility audit + fixes | 7 | 2 | 9 | Do first |
| CoreCLR debugger for Cursor (netcoredbg) | 9 | 6 | 8 | Do second |
| MCP ops-layer reposition + official-MCP proxy | 8 | 4 | 7 | Do in parallel |
| Integrate standalone CLI + Pipeline now; watch Unity 7 deltas | 8 | 5 | 8 | Active — APIs published |
| Remote shell productization | 9 | 8 | 5 | Invest steadily |
| Unterm CoreCLR audit | 5 | 2 | 6 | Fold into audit |

First three = survival tier (each defends a feature that otherwise dies or commoditizes). Last three = growth tier.

Official-surface composition detail: evaluate `com.unity.ai.assistant` relay and
standalone CLI/Pipeline composition separately, then expose origin-qualified
Assistant, Pipeline, and toolkit catalogs through one policy layer. The safety
claim is valid only if arbitrary C# execution and every other mutating command
cannot bypass read-only/dry-run enforcement.

## 6. Additional new ideas

1. **CoreCLR Migration Assistant** (impact 9, effort 4, urgency 9). Projects
   that adopt the selected CoreCLR transition release need a repeatable scan.
   Turn the local audit into an MCP tool and extension command only after its
   rules are rechecked against current primary documentation.
2. **Statics-bug detector for Fast Enter Play Mode** (impact 7, effort 3,
   urgency 8). Snapshot static fields across play-mode transitions and report
   what carried state. Recheck default reload behavior on each tested Editor.
3. **Test orchestration bridge** (impact 6, effort 3). Start with a parity spike
   against `unity test`, which already runs EditMode/PlayMode tests headlessly
   with filters and NUnit output. Build only the missing value: legacy Editor
   support, progress streaming, toolkit safety policy, richer structured
   results, remote targeting, and one stable MCP schema across backends.
4. **Editor fleet orchestration** (impact 7, effort 7, later). Post-remote-shell upsell: N hidden/remote editors leased by agents for parallel work; validation farms for the Unity 7 "asset validation without editor access" workflow. Pairs with Unity Licensing Server / build-server seats (see licensing table in `UNITY_WITHOUT_EDITOR_EXPERIMENTS.md`).

## 7. The backwards-compatibility offer

Headline product line, not a footnote. **Impact 8, effort 3, urgency 6** — mostly positioning + CI matrix on top of what exists.

Target: **one agent interface from the declared Unity 2019.4 baseline through
the exact future Editor matrix that passes the readiness gates.**

Why it works:

- Official live-Editor agent surfaces are split across the Assistant package
  and Unity 6+ Pipeline package. The standalone CLI can manage multiple Editor
  generations, but Pipeline live control does not cover legacy projects.
- This toolkit already runs on 2019.4+, needs no Unity AI packages, and provides
  one stable live-agent interface across legacy and current projects. That
  cross-version continuity—not an unverified claim that no official CLI can
  touch an older project—is the durable offer.
- The intended version split becomes an evidence-backed feature matrix:
  - Legacy Editors retain the Mono debugger and legacy hot-reload path where
    the exact matrix passes.
  - Eligible CoreCLR Editors select only capabilities proved by WS1 and WS3.
  - The MCP, console, and connection interface stays stable while results name
    the selected backend and Editor.
- Compounds with the Migration Assistant: the install serving a 2021 LTS team today walks them across CoreCLR tomorrow. Capture before the transition, keep after — exactly the window where official tooling would otherwise absorb them.

Concrete work: version-gated capability detection in the C# package, an
exact-version Editor/platform matrix, and README plus Marketplace wording that
matches recorded evidence.

## 8. Priority order

1. CoreCLR package audit + fixes
2. CoreCLR Migration Assistant
3. CoreCLR debugger for Cursor (netcoredbg)
4. MCP ops-layer reposition + backwards-compat positioning
5. Statics-bug detector (FEPM)
6. Test runner bridge
7. Remote shell productization (re-baseline E2 on CoreCLR; internal-API smoke tests per Unity version; validate player viewport service on 6.7 CoreCLR player)
8. Standalone Unity CLI + Pipeline adoption now; Unity 7-specific delta watch
   and editor fleet orchestration follow after the local integration is proven

## 9. Sources

- https://unity.com/news/unity-7-roadmap-revealed-at-unite-seoul
- https://www.gamedeveloper.com/programming/unity-unveils-unity-7-roadmap-with-update-path-that-won-t-break-your-build
- https://discussions.unity.com/t/path-to-coreclr-2026-upgrade-guide/1714279
- https://discussions.unity.com/t/coreclr-scripting-and-serialization-update-june-2026/1723299
- https://docs.unity3d.com/Packages/com.unity.ai.assistant@2.7/manual/integration/unity-mcp-overview.html
- https://unity.com/blog/unity-ai-mcp-how-to-get-started
- https://discussions.unity.com/t/unity-6-5-is-now-available/1723176
- https://docs.unity3d.com/6000.7/Documentation/Manual/scripting-backends-coreclr.html
- https://www.creativebloq.com/3d/video-game-design/unity-7s-most-surprising-advance-isnt-a-feature-upgrade
- https://docs.unity.com/en-us/unity-cli
- https://docs.unity.com/en-us/unity-cli/unity-cli-reference
- https://docs.unity.com/en-us/unity-cli/release-notes
- https://docs.unity.com/en-us/unity-production-pipeline/local-tools-cli/unity-pipeline-package
- https://docs.unity3d.com/Packages/com.unity.pipeline@0.4/manual/index.html
