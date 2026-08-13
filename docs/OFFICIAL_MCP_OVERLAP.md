# Official Unity MCP overlap analysis

Status: dated capability capture. Assistant MCP capture completed 2026-08-02;
standalone Unity CLI and Pipeline implications added 2026-08-07; documentation
status reviewed 2026-08-13. Ticket TASK-6.1, scope TASK-6 (WS4). Re-run the
capture before current-version comparisons or marketing claims. Canonical
Unity 7 status: `UNITY_7_READINESS.md`.

This document records what the official Unity MCP server exposes, what Unity
Cursor Toolkit exposes, and which behavior is commoditized by the official
package. It is the input for the repositioning pass (TASK-6.6) and the proxy
spike (TASK-6.4). Refresh it whenever the official package ships a new minor
version; the capture procedure at the end is reproducible.

Both inventories in this document are observed, not read off marketing pages.
Raw captures live in `.agent/runs/TASK-6.1/artifacts/`.

Scope clarification: the original capture compares the AI Assistant MCP
(`com.unity.ai.assistant`) with Unity Cursor Toolkit. The 2026-08-07 update
incorporates Unity's already-published separate standalone `unity` CLI and
`com.unity.pipeline` package with its own MCP adapter. Those are not the same
product or transport as the Assistant MCP.
The full CLI/Pipeline inventory and adoption plan lives in
`UNITY_CLI_AND_PIPELINE_ASSESSMENT.md`; this document preserves the dated
Assistant capture and records the resulting positioning correction.

## Captured versions

| Side | Identity | Version | Minimum editor |
| --- | --- | --- | --- |
| Official | `com.unity.ai.assistant` from `https://packages.unity.com` | `2.17.0-pre.1` (registry `latest` on 2026-08-02, tarball shasum `284c75a8…`) | `6000.0.60f1` |
| Official | MCP relay binary, installed to `~/.unity/relay/` by the editor | ships inside the package | same |
| Official | Standalone Unity CLI | `1.0.0-beta.3` (released 2026-07-23) | Independent binary; manages multiple Editor versions |
| Official | `com.unity.pipeline` | `0.4.0-exp.1` documentation captured 2026-08-07 | Unity 6.0+ |
| Toolkit | `unity-cursor-toolkit` VS Code / Cursor extension | `0.6.1052826` | VS Code engine `^1.60.0` |
| Toolkit | `com.rankupgames.unity-cursor-toolkit` Unity package | `1.1.0` | `2019.4` |

The toolkit version and inventory above belong to the dated source capture.
The extension source keeps a base package version, while release CI can assign
a different distribution version. Check release artifacts separately; this
document does not replace historical inventory values with current metadata.

Capture editor: Unity `6000.5.2f1` on macOS arm64, isolated empty project,
`-batchmode -nographics`. The official inventory was read from the package's own
public registry API (`McpToolRegistry.GetAllToolsForSettings()`), so it reflects
what the bridge would advertise, including per-tool enabled state.

## Observed inventories

The official server registered 54 tools, of which 7 are enabled by default. The
toolkit server advertised 20 tools, 6 resources and 4 prompts, all enabled.
These numbers are not comparable and are recorded only as capture facts: the
official surface splits one capability across many narrow tools (14 separate
`Unity_Profiler_*` tools), while the toolkit dispatches on an `action`
parameter inside a smaller number of tools. Do not use either number in
positioning material.

Official tools, by group (full names, schemas and descriptions in
`official-mcp-tool-inventory.json`):

- Scripting: `Unity_CreateScript`, `Unity_DeleteScript`, `Unity_ManageScript`,
  `Unity_ManageScript_capabilities`, `Unity_ApplyTextEdits`,
  `Unity_ScriptApplyEdits`, `Unity_ValidateScript`, `Unity_GetSha`,
  `Unity_ManageShader`, `Unity_RunCommand`.
- Scene and objects: `Unity_ManageScene`, `Unity_ManageGameObject`.
- Assets: `Unity_ManageAsset`, `Unity_ImportExternalModel`,
  `Unity_FindProjectAssets`, `Unity_AudioClip_Edit`, and nine
  `Unity_AssetGeneration_*` tools.
- Editor: `Unity_ManageEditor`, `Unity_ManageMenuItem`, `Unity_GetProjectData`,
  `Unity_GetUserGuidelines`, `Unity_PackageManager_GetData`,
  `Unity_PackageManager_ExecuteAction`.
- Capture: `Unity_Camera_Capture`, `Unity_SceneView_Capture2DScene`,
  `Unity_SceneView_CaptureMultiAngleSceneView`.
- Console: `Unity_GetConsoleLogs`, `Unity_ReadConsole`.
- Files and search: `Unity_Grep` (bundled ripgrep over `Assets`),
  `Unity_ListResources`, `Unity_ReadResource`, `Unity_FindInFile`.
- Profiler analysis: 14 `Unity_Profiler_*` tools.

Enabled by default: `Unity_RunCommand`, `Unity_GetConsoleLogs`,
`Unity_Camera_Capture`, `Unity_SceneView_Capture2DScene`,
`Unity_SceneView_CaptureMultiAngleSceneView`,
`Unity_AssetGeneration_GenerateAsset`, `Unity_AssetGeneration_GetModels`.
Everything else, including all scene, GameObject, asset-management and profiler
tools, is registered but off until a user enables it in Project Settings.

Toolkit tools: `manage_scene`, `manage_gameobject`, `manage_component`,
`manage_asset`, `manage_material`, `play_mode`, `editor_lifecycle`,
`execute_menu_item`, `screenshot`, `project_info`, `editor_validation`,
`game_command`, `profiler_snapshot`, `build_trigger`, `batch_execute`,
`unity_context`, `viewport_stream`, `read_console`, `clear_console`,
`resolve_meta`. Plus resources `unity://project/info`,
`unity://scene/hierarchy`, `unity://console/recent`, `unity://console/errors`,
`unity://tools/catalog`, `unity://context/summary`, and four workflow prompts.

## Overlap classification

### Commoditized — the official package now covers this

Treat these as table stakes. They are no longer a reason to choose the toolkit,
and messaging should not lead with them.

| Capability | Official | Toolkit |
| --- | --- | --- |
| Read console messages with filters and stack traces | `Unity_GetConsoleLogs`, `Unity_ReadConsole` | `read_console`, `clear_console` |
| Scene and hierarchy manipulation | `Unity_ManageScene` | `manage_scene` |
| GameObject create, find, modify, destroy | `Unity_ManageGameObject` | `manage_gameobject`, `manage_component` |
| Asset create, move, delete, import | `Unity_ManageAsset`, `Unity_ImportExternalModel` | `manage_asset`, `manage_material` |
| Editor state and play mode control | `Unity_ManageEditor` | `play_mode`, `editor_lifecycle` |
| Menu item invocation | `Unity_ManageMenuItem` | `execute_menu_item` |
| Project metadata for agents | `Unity_GetProjectData` | `project_info`, `unity://project/info` |
| Visual capture of a camera or scene view | `Unity_Camera_Capture`, `Unity_SceneView_*` | `screenshot` |
| Compile and script validation feedback | `Unity_ValidateScript`, `Unity_ManageScript` | `editor_validation` |

### Parity in name, different in shape

Same words, materially different behavior. These need care in messaging: claim
the difference, not the category.

- **Profiler.** Official has the broader analysis vocabulary — 14 tools for
  counter summaries, frame-range top-time, GC allocation breakdowns and sample
  drill-down. They all read `ProfilerDriver` state, meaning whatever capture is
  already loaded in the editor's Profiler window; nothing in the official MCP
  surface starts, stops, saves or loads a capture, and every profiler tool is
  disabled by default. The toolkit's `profiler_snapshot` owns the capture
  lifecycle instead (`current`, `saveSession`, `listSessions`, `readSession`,
  `clearSessions`, `discoverCounters`) and fuses the capture with a compact
  whole-console transcript (`readConsoleTranscript`). The honest claim is
  agent-driven capture and console-fused timelines, not deeper profiler
  analysis.
- **Script editing.** Official ships a full editing suite plus
  `Unity_RunCommand`, which compiles and executes arbitrary C# in the editor.
  The toolkit has no equivalent and should not grow one casually: an
  unrestricted code-execution tool is exactly the surface the toolkit's safety
  rails exist to constrain. Note this in the proxy spike (TASK-6.4) —
  `Unity_RunCommand` is enabled by default upstream and bypasses any per-tool
  policy a proxy would apply to the narrower mutating tools.
- **Project search.** Official bundles ripgrep behind `Unity_Grep` plus
  resource read tools. The toolkit's `unity_context` answers a different
  question: it queries a tracked asset/meta/object graph at
  `.umetacontext/index.json` by GUID, class id, scene, prefab and dependency
  edges, rather than searching file text.

### Unique to the toolkit in the dated Assistant-only comparison

The points below compare the toolkit with the captured Assistant package only.
They do not by themselves establish uniqueness against the standalone CLI or
Pipeline; the correction immediately after this section owns that broader
comparison.

These were the differentiators in the dated Assistant-only comparison. Recheck
them before current positioning.

- **Declared version span.** The Unity package metadata targets `2019.4`; the official package
  requires `6000.0.60f1` or newer. Studios pinned to 2019/2020/2022 LTS cannot
  run the captured official MCP package. This is a declared range comparison,
  not toolkit certification across every Editor in that range.
- **No Unity Cloud AI dependency for the interface itself.** The toolkit's
  server is a plain Node stdio process. The official bridge ships inside the
  Assistant package, and its asset-generation tools — two of the seven
  enabled-by-default tools — call Unity Cloud AI and consume organization AI
  points.
- **Deployment envelope.** The toolkit MCP server runs standalone
  (`node out/mcp/server.js`) with no VS Code host, and `game_command` supports
  `host=editorBatchmode`, launching a headless editor run for a command. The
  official bridge lives inside a running editor process; batch mode is
  supported only as a connection-approval convenience
  (**Auto-approve in Batch Mode**), not as a headless execution model.
- **Safety controls at the protocol boundary.** `UNITY_CURSOR_TOOLKIT_MCP_READ_ONLY=1`
  refuses mutating calls before any Unity traffic, `dryRun=true` returns the
  command that would run, and every tool advertises `readOnlyHint`,
  `destructiveHint` and `idempotentHint` annotations. The official MCP module
  has no dry-run, no read-only mode and no destructive annotations; its
  controls are per-tool enable/disable in Project Settings, first-connection
  client approval, and a validation-level dropdown scoped to
  `Unity_ManageScript`.
- **Remote and streamed operation.** `viewport_stream` serves an MJPEG viewport
  with input injection (`start`, `stop`, `status`, `input`) against a host and
  port. The official capture tools return single images from the local editor.
- **Structured project context.** `unity_context` over `.umetacontext`,
  `resolve_meta` for raw `.meta` reads, and the `unity://` resource set give
  agents addressable project state rather than tool calls alone.
- **Batching.** `batch_execute` runs a sequence with fail-stop semantics and
  propagates dry-run and destructive classification through the batch.
- **Agent workflow prompts.** Four MCP prompts encode read-only-first
  investigation and safe-edit planning.

### Unique to the official package

Record these honestly; they are the reasons a Unity 6 team might use the
official server alongside or instead of the toolkit.

- Arbitrary C# compile-and-execute (`Unity_RunCommand`).
- A complete script authoring and patching suite with capability negotiation.
- Generative asset creation backed by Unity Cloud AI.
- Package Manager query and mutation tools.
- Bundled ripgrep search over `Assets`.
- Profiler analysis breadth over an already-loaded capture.
- Multi-client support against one editor, with a per-client approval registry.
- Shader and audio-clip authoring tools.

## Standalone Unity CLI and Pipeline correction

The 2026-08-02 Assistant comparison remains valid for that specific package,
but it is no longer a complete comparison against Unity's official agent and
automation stack.

The standalone `unity` CLI now provides first-party commands for:

- Installing, listing, upgrading, and removing Editors and build modules.
- Resolving and opening projects with the version declared by the project.
- Creating, cloning, linking, sizing, and closing projects and templates.
- Running local batch builds, headless commands, and Edit/Play Mode tests with
  structured output and differentiated exit codes.
- Authentication, licensing, Unity Cloud identity, diagnostics, logs, cache,
  proxy support, and machine-readable JSON/NDJSON automation.
- Discovering connected Editors, listing their command schemas, executing
  commands, and starting an MCP server for agent clients.

The separate `com.unity.pipeline` package adds a broad Unity 6+ command catalog
covering assets/files, scenes, GameObjects/components, prefabs, scripts,
animation, materials/shaders, baking, search/selection, screenshots,
compilation, builds, tests, project settings, packages, Editor lifecycle,
performance, development Players, C# evaluation, and hot reload. Project code
can add typed commands with `[CliCommand]`.

This changes four earlier conclusions:

1. **Headless execution is no longer toolkit-only in the broad sense.** The
   toolkit still has a distinct remote/batch deployment envelope and legacy
   span, but official `unity build`, `unity run`, and `unity test` now cover
   common local batch workflows.
2. **First-party MCP is no longer only the Assistant relay.** `unity mcp`
   exposes Pipeline commands as MCP tools without routing through the Assistant
   package inventory captured above.
3. **Build/test basics are commoditized on Unity 6+.** Toolkit investment must
   target legacy compatibility, safety policy, streaming/progress, structured
   composition, project-specific workflows, remote operation, and gaps proven
   by a parity matrix.
4. **Proxy work must distinguish origins.** Assistant MCP, Pipeline MCP, and
   toolkit tools have different transports, schemas, version ranges, and safety
   properties. A single catalog needs origin metadata and an explicit policy
   for arbitrary C# evaluation and other broad mutations.

The planned differentiators remain the declared 2019.4+ version span, explicit
read-only/dry-run policy, remote viewport and virtualized shell, structured
project context, profiler-capture lifecycle, and composition across local,
remote, interactive, batch, and CI workflows.

## Assistant MCP deployment, account and package requirements

| Dimension | AI Assistant MCP | Unity Cursor Toolkit |
| --- | --- | --- |
| Editor range | Unity 6 (`6000.0.60f1`) and later | Unity `2019.4` and later |
| Unity-side install | `com.unity.ai.assistant`, 531 MB unpacked, pulls `com.unity.nuget.newtonsoft-json`, `com.unity.mathematics`, `com.unity.nuget.mono-cecil`, `com.unity.2d.sprite`, UIElements and UnityWebRequest modules | `com.rankupgames.unity-cursor-toolkit` 1.1.0, depends on `com.unity.modules.jsonserialize` and `com.unity.nuget.newtonsoft-json` |
| Client-side install | Relay binary auto-installed to `~/.unity/relay/`; clients launch it with `--mcp`; four prebuilt platform binaries only | VS Code / Cursor extension, or the compiled Node stdio server directly |
| Editor process required | Yes — the bridge runs in the editor and the relay discovers a live editor instance | Yes for editor-backed tools; `game_command host=editorBatchmode` launches a headless editor itself |
| Account requirements | Tool *registration* observed with no AI sign-in; asset-generation tools require Unity Cloud AI and consume organization AI points | None beyond a licensed Unity editor |
| Connection model | IPC (named pipe / Unix socket) between relay and editor; first direct connection needs manual approval in Project Settings; AI-gateway connections auto-approved; batch mode can auto-approve | stdio to the toolkit server; the toolkit server talks to the editor bridge |
| Targeting multiple editors | `--project-path` / `--instance-id`, or `UNITY_PROJECT_PATH` / `UNITY_INSTANCE_ID` | project root resolution plus `host` parameters on remote-capable tools |
| Default exposure | 7 of 54 tools enabled, including arbitrary code execution and credit-consuming generation | all 20 tools enabled, with read-only mode and dry-run available |

## Implications

For repositioning (TASK-6.6):

1. Lead with the version span. It is the one difference the official package
   cannot close for existing LTS projects.
2. Lead with the deployment envelope: standalone server, remote and legacy
   batch execution, remote viewport streaming, and one policy layer over both
   toolkit and first-party CLI/Pipeline commands. Do not claim generic local
   headless execution as unique now that `unity build/run/test` exist.
3. Lead with the safety model: read-only mode, dry-run, and per-tool
   destructive annotations, contrasted against a default-on
   compile-and-execute-C# tool.
4. Do not compare tool counts in either direction, and do not claim profiler
   superiority in the abstract — claim agent-driven capture and console-fused
   timelines.

For the proxy spike (TASK-6.4):

1. The relay is a separate process launched with `--mcp`, so proxying is a
   process-composition problem, not an in-editor integration one.
2. Wrapping must classify official tools by hand: the official surface carries
   no read-only or destructive metadata to inherit.
3. `Unity_RunCommand` is the hard case. It is enabled by default and can do
   anything the editor can, so a wrapper either blocks it, or the toolkit's
   read-only guarantee stops meaning anything for proxied sessions.
4. Any Assistant or Pipeline proxy is Unity 6 only, so it must be additive and
   must not weaken the 2019.4 path.
5. Evaluate Pipeline composition separately from Assistant relay composition.
   Prefer structured `unity` CLI JSON/NDJSON and documented exit codes over
   scraping human output or reaching into the local HTTP descriptor directly.
6. Treat `eval`/`eval_file` in Pipeline and `Unity_RunCommand` in Assistant as
   equivalent policy escape hatches: block or isolate them when advertising a
   read-only proxied session.

## Reproducing this capture

Official side:

1. `curl https://packages.unity.com/com.unity.ai.assistant` and read
   `dist-tags.latest`, then download and shasum-verify the tarball.
2. Scaffold an empty project outside this repository pinning that exact
   version and a Unity 6 editor.
3. Add an editor script that serializes
   `Unity.AI.MCP.Editor.ToolRegistry.McpToolRegistry.GetAllToolsForSettings()`.
4. Run the editor with `-batchmode -nographics -executeMethod … -quit`.

Toolkit side:

1. `npm ci --no-audit --no-fund && npm run compile` in `unity-cursor-toolkit/`.
2. Pipe `initialize`, `tools/list`, `resources/list`, `prompts/list` into
   `node out/mcp/server.js`.
3. Repeat the mutating call with `UNITY_CURSOR_TOOLKIT_MCP_READ_ONLY=1` to
   confirm the refusal path.

Full commands and environment details are in
`.agent/runs/TASK-6.1/artifacts/official-mcp-eval-setup.txt`.

CLI/Pipeline sources:

- https://docs.unity.com/en-us/unity-cli/unity-cli-reference
- https://docs.unity.com/en-us/unity-cli/release-notes
- https://docs.unity.com/en-us/unity-production-pipeline/local-tools-cli/unity-pipeline-package
- https://docs.unity3d.com/Packages/com.unity.pipeline@0.4/manual/index.html
