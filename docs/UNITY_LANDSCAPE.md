# Unity landscape research

Last reviewed: 2026-08-26

This is dated research input, not a support claim. Nothing here certifies that the toolkit supports Unity 7, the
standalone CLI, or the Pipeline package.

Each section records what the cited sources said on a stated capture date. Recheck external facts before any
implementation, marketing, or support decision. Work that came out of this research is tracked at
https://github.com/rankupgames/unity-cursor-toolkit/issues.

## 1. Unity 6.6 to Unity 7 landscape

Captured 2026-07-23 from the cited announcements and upgrade guide. Extended 2026-08-07 with the standalone CLI and
Pipeline captures. Documentation status reviewed 2026-08-13.

### 1.1 Release and runtime capture

- **Unity 6.5** shipped June 2026 and was the current Supported release.
- **Unity 6.6+**: Fast Enter Play Mode becomes the default for new projects.
- **CoreCLR preview**: a captured upgrade source described experimental CoreCLR desktop-player work around the Unity
  6.7 train. Recheck the exact Editor channel and support policy before a proof run.
- **Unity 6.8 target**: the captured roadmap described a CoreCLR-only scripting runtime and mandatory Fast Enter Play
  Mode.
- **Hub CLI**: deprecated from Hub 3.18.0. The cited docs directed new automation to the standalone CLI. Unity Build
  Automation stayed a separate cloud service in that snapshot.

### 1.2 CoreCLR consequences listed in the captured upgrade guide

- No full domain reload. Statics survive play-mode transitions and recompiles.
- `AppDomain.CurrentDomain.DomainUnload` never fires. Use the `[AfterCodeReloadSerialization]` and
  `[BeforeCodeUnloading]` attributes.
- `AppDomain.CurrentDomain.GetAssemblies()` is deprecated. Replacement:
  `UnityEngine.Assemblies.CurrentAssemblies.GetLoadedAssemblies()`.
- Several `Assembly.Load` overloads, including `Assembly.Load(byte[])`, are incompatible with code reload.
  Replacement: `CurrentAssemblies.LoadFromPath()`.
- `Assembly.Location` returns an empty string. Replacement: `Assembly.GetLoadedAssemblyPath()` in
  UnityEngine.CoreModule on 6.8+.
- `UnityEditor.Scripting.ManagedDebugger` is unsupported. Replacement: `System.Diagnostics.Debugger`.
- Statics management uses `[AutoStaticsCleanup]`, or custom cleanup bound to the lifecycle events.

### 1.3 Unity 7 announcement snapshot

The captured announcement gave an early beta and release window and described these targets: a zero-rebuild upgrade
path from Unity 6 (no rebuilding, no new language, nothing broken); partial domain reload, where only changed
assemblies reload, giving near-instant play mode; a free official MCP that connects coding agents to Unity; continued
expansion of CLI and public APIs for validation, builds, deployment, and production-pipeline workflows; and Surface
Cache GI, AI-assisted graphics optimization, and Unity Vector for ads AI. Three official agent surfaces were captured
alongside it: the `com.unity.ai.assistant` MCP relay on 2026-08-02 (section 5), the standalone `unity` CLI on
2026-08-07 (section 3), and `com.unity.pipeline` `0.4.0-exp.1` on 2026-08-07 (section 4).

### 1.4 Open questions from the dated review

The toolkit still needs an Editor process to render Editor windows, and the dated CLI, Pipeline, and Assistant
inventories did not include a remote rendered-window and input shell; recheck that comparison before product
positioning. Editor architecture continuity may let the internal `GUIView.GrabPixels` and `SendEvent` path survive
into Unity 7, but that is an inference about an internal API and needs an exact-version smoke test. A CoreCLR Editor
can change startup and steady-state cost, so measure on the selected transition Editor. Licensing and EULA conclusions
are limited to the dated source review.

## 2. CoreCLR impact on this repo

Audit source: `Packages/com.rankupgames.unity-cursor-toolkit/`. Line numbers were re-verified against the working tree
on 2026-08-26. The same files also exist under `CursorUnityTool/Packages/…` as an embedded copy, with the same line
numbers unless noted.

**`AppDomain.CurrentDomain.GetAssemblies()`** — first-party: `Editor/MCP/EditorValidationTool.cs:608`,
`Editor/MCP/EditorWindowViewportCapture.cs:432`, `Editor/MCP/MCPBridge.cs:44`,
`Editor/HotReload/ILPatcher.cs:266,428,523`. Vendored Unterm: `UntermExecuteCodeTools.cs:117`,
`UntermMcpServer.cs:861`, `UntermToolGroup.cs:102,119`.

**`Assembly.Load(byte[])`** — `Editor/HotReload/ILPatcher.cs:381` (`Assembly.Load(dllBytes)`), the IL patching path
the captured guide names as incompatible with code reload. Vendored: `UntermExecuteCodeTools.cs:75`.

**`Assembly.Location`** — `UntermExternalCodeEditor.cs:78`, vendored. Under the captured rules this returns an empty
string on 6.8+.

**`AssemblyReloadEvents`** — the API may survive, but the event model changes under partial reload, so verify
semantics and not only the compile result. First-party: `Editor/HotReloadHandler.cs:114` (embedded copy: `:94`),
`Editor/ProfilerSnapshot.cs:159,160,402`, `Editor/MCP/EditorWindowViewportCapture.cs:29`. Vendored:
`UntermWindow.cs:277,292`, `UntermAgentWindow.cs:194,266`, `UntermSignatureWorker.cs:36`,
`UntermCompletionWorker.cs:40`, `UntermCodeEditorWindow.cs:461,521`.

Vendored Unterm hits are not first-party code and need either a local audit or an upstream fix. Transition risks
recorded during the audit. The debugger attach path on port 56000 is Mono-specific, so the permitted CoreCLR debugger
options and attach behavior need proof before a replacement is chosen. Hot reload and IL patching depend on the
`Assembly.Load(byte[])` path the captured guide calls incompatible, so that path needs a gate or a replacement on the
exact selected Editor. MCP basics are covered by the official Assistant and Pipeline surfaces; sections 3 to 5 hold
that evidence.

## 3. Standalone Unity CLI

Captured 2026-08-07 against the cited CLI, Editor command-line, Build Automation, UGS CLI, and Unity Version Control
docs. Documentation status reviewed 2026-08-13. Captured release: `1.0.0-beta.3`, released 2026-07-23.

- The `unity` CLI is an experimental, separately installed binary. It is not a Unity 7-only feature, and it is
  separate from Hub and from the Editor.
- It is not tied to one Editor. It installs, discovers, selects, opens, runs, tests, and builds with multiple Editor
  versions. Project commands can resolve the version declared in `ProjectSettings/ProjectVersion.txt`.
- `unity build` is a local Editor batch-mode build. Unity Build Automation is a separate cloud service with its own
  Dashboard, Editor package, and REST API.
- `unity --help` is authoritative for the installed beta. The web reference can trail newly shipped commands and
  flags.

### 3.1 Command-line surface map

| Surface | Invocation | Primary role | Version coupling and status |
| --- | --- | --- | --- |
| Standalone Unity CLI | `unity ...` | Editor/module/project management, local builds and tests, licensing, connected Editors, MCP, diagnostics | Independent experimental binary; captured at `1.0.0-beta.3`; manages multiple Editor versions |
| Unity Pipeline package | `com.unity.pipeline`, driven by `unity command` | Authenticated local control of a running Editor or development Player | Requires Editor 6.0+; captured docs are `0.4.0-exp.1` |
| Direct Unity Editor CLI | Exact `Unity`/`Unity.exe` plus Editor flags | Batch mode, custom static methods, builds, tests, imports, diagnostics | Strictly coupled to the launched Editor version and platform |
| Unity Player arguments | Built application plus Player flags | Headless Player, display/GPU selection, logging, debugging | Coupled to the build's Editor version and target platform |
| Legacy Hub CLI | Hub executable plus `-- --headless` | Legacy Editor and module installation | Deprecated from Hub 3.18.0 |
| Unity Build Automation | Dashboard, Editor package, REST API | Cloud CI builds, scheduling, status and history, cancellation, artifacts | Separate service and support matrix; not the local `unity build` |
| UGS CLI | `ugs ...` | Deploy and manage Unity Gaming Services resources | Standalone and Editor-independent |
| Unity Version Control CLI | `cm ...` | Repositories, workspaces, branches, merges, locks, reviews, administration | Standalone and Editor-independent |

### 3.2 Version-selection rules

1. Treat `ProjectSettings/ProjectVersion.txt` as the default Editor authority for an existing project.
2. Use exact Editor versions for CI and durable automation. Aliases such as `latest`, `lts`, `6`, or `6.5` are useful
   interactively, but can move without a project change.
3. An installed build-support module belongs to one Editor installation. A module installed for `6000.3.9f1` does not
   prove the same module exists for `6000.5.2f1`.
4. Opening a project with a newer Editor is an upgrade operation, not ordinary launch behavior. Do not substitute a
   newer installed Editor when the declared version is missing.
5. `com.unity.pipeline` requires Unity 6.0+. Legacy projects continue through the existing toolkit bridge and direct
   version-matched Editor execution.
6. Individual Pipeline commands can have narrower requirements. UI Toolkit element capture is documented as requiring
   `6000.7+` even though the base package supports Unity 6.0+.
7. For direct Editor flags, use the manual for the exact Editor stream. Stable flag names exist across versions, but
   supported flags and behavior change.

### 3.3 Capability map

**Editors and modules.** `install` (a version or an alias such as `lts`, `latest`, a major stream, or the configured
default, with modules and child components), `install-modules`, `uninstall`, `editor`, `editors` (list releases,
installed Editors, and running Editors; register a manual install, inspect path and metadata, set a default, upgrade
inside a stream), `modules`, `releases`, `install-path`, `cache`, and `hub`.

**Projects, builds, tests.** `open` (`unity ./Project` is shorthand), `templates`, and `projects` (list, create,
clone, register, open, pin, size, close, link, unlink; clone covers GitHub, GitLab, and Unity Version Control with
branch, commit, or changeset selection). `build` is a local batch-mode build with CI-oriented output and exit
behavior: Editor selection, build target and output, Android signing, APK/AAB/Android Studio export, version codes,
symbols, target SDK, Git-derived versioning, and dirty-worktree rejection unless explicitly allowed. `run` gives batch
mode, streamed logs, the Editor exit code, or a registered `[CliCommand]` headlessly with `--command`. `test` covers
Edit Mode and Play Mode with filters, Editor version, path, and architecture selection, NUnit XML, timeout, and
operation-failed exit code `6` on test failure.

**Accounts, licensing, connected Editors, agents.** `auth` (browser sign-in, status, sign-out), `license` (list,
inspect, activate, and return Personal, serial, floating, and offline licenses), `cloud` (sign-in state, organization
and project selection), `pipeline` (install, upgrade, list versions of, and inspect the Pipeline package), `status`
(connected Editor port, project path, Editor version, process id), `list` (registered commands with description,
group, and parameter schema), `command` / `cmd` (list or execute on a selected connected Editor or development
Player), and `mcp` (stdio MCP server exposing connected Editor commands as MCP tools, with assisted client
configuration).

**Automation and diagnostics.** Human, TSV, JSON, and streaming NDJSON output; piped output defaults to TSV, so
automation must select a format explicitly. Differentiated exit codes cover success, general failure, usage error,
authentication or authorization failure, missing configuration, operation failure, Ctrl+C, and SIGTERM.
Non-interactive execution, quiet and no-banner output, confirmations, project and organization defaults, proxy
configuration, watch modes, and environment variable equivalents are available. `shell` is a warm interactive process
with history, completion, session context, and an NDJSON request/response protocol for agents; `completion` covers
bash, zsh, fish, and PowerShell. `doctor`, `diagnose`, `logs`, and `env` give environment health, proxy diagnostics,
log reading and tailing, and resolved path and version inspection. `config`, `analytics`, `bug`, `language`, and
`changelog` cover settings, consent, bug reporting, localization, and release information; `upgrade`, rollback where
available, and `self-uninstall` manage CLI lifecycle. External commands are discovered through executables named
`unity-<name>`.

### 3.4 Traditional Editor CLI capabilities that stay relevant

The exact `Unity`/`Unity.exe` binary and its matching versioned manual still own project creation, opening, and
template cloning; `-batchmode`, `-nographics`, and controlled quit behavior; `-executeMethod` for project-defined
static Editor methods; build target and profile selection or custom `BuildPipeline` code; Edit Mode, Play Mode, and
Player tests with filters and NUnit output; code coverage; `.unitypackage` import and export and Package Manager
behavior; deterministic asset importing and import overrides; Unity Accelerator and Cache Server configuration; logs,
stack traces, job-worker counts, API updating, and VCS session settings; graphics API and GPU selection plus
debugging, shader validation, Metal, and Profiler behavior; license activation, return, and manual install; and full
Library rebuild recovery.

### 3.5 Other first-party automation surfaces

**Build Automation** is cloud CI, not another spelling of `unity build`: its REST API triggers configured builds,
inspects attempt status and history, cancels attempts, and retrieves results; builds can also run from repository
changes or schedules, and the Unity 6 Editor package integrates cloud targets with Build Profiles. **UGS CLI** (`ugs`)
manages environments and service configuration for Access, CCD, Cloud Code, Cloud Save, Economy, Game Server Hosting,
Leaderboards, Lobby, Matchmaker, Player Authentication, Remote Config, Scheduler, Schema Registry, and Triggers; it is
a service-deployment surface, not Editor control. **Unity Version Control CLI** (`cm`) owns repository and workspace
creation, add, checkin, checkout, branch, merge, diff, labels, shelvesets, locks, reviews, replication, users and
ACLs, triggers, history, queries, archives, and administration.

### 3.6 WIA Prime Forces reference snapshot

Dated integration evidence from one machine, not a toolkit invariant. Observed 2026-08-07: WIA declares Unity
`6000.3.9f1` (revision `7a9955a4f2fa`); the installed `6000.3.9f1` and `6000.5.2f1` Editors carry different module
sets, which proves modules must be checked per exact Editor; the standalone `unity` CLI is not on `PATH`;
`com.unity.pipeline` is not in WIA's manifest or lockfile; and WIA already has custom batch entry points for compile
validation, Android and iOS builds, variants, build profiles, signing inputs, game-data validation and export,
Addressables, and Odin IL2CPP AOT work. WIA's test runner defaults to a hardcoded macOS Editor path and can generate
missing SpacetimeDB bindings from cloned source; it must resolve the declared Editor through the CLI or configuration
and fail closed on a missing generated-binding artifact before it is a canonical example.

## 4. Unity Pipeline package

Captured 2026-08-07. `com.unity.pipeline` at `0.4.0-exp.1` in the captured docs. It requires Unity Editor 6.0 or later
and runs an authenticated local HTTP API inside a Unity Editor or a development Player. The CLI discovers an instance
and turns registered commands into terminal and MCP tools.

### 4.1 Capability map

**Assets and files.** Create ScriptableObject and Object assets; import external files; move, copy, rename, delete,
and find assets; read or change importer settings and reimport; create folders; read and write project text files.

**Scenes, GameObjects, components, prefabs.** Create, open, save, list, and activate scenes; inspect the scene
hierarchy; update scenes in Build Settings; create, batch-create, find, transform, parent, activate, tag, layer,
rename, and delete GameObjects; add, remove, inspect, and modify serialized component properties; create and
instantiate prefabs, create variants, apply or revert overrides, unpack instances, and edit prefab contents.

**Scripts, animation, materials, shaders.** Create and attach C# scripts and inspect or set serialized fields; create
AnimationClips and curves; create and inspect Animator Controllers, parameters, layers, states, and transitions;
create Timelines, tracks, and clips; inspect and change material shaders, properties, and keywords; list and
introspect shaders.

**Baking, search, selection, capture.** Start, poll, cancel, configure, and clear lighting, NavMesh, and occlusion
bakes; bake AI Navigation `NavMeshSurface` components; read or set the Editor selection; run Unity Search queries;
capture Game view, Scene view, and supported UI Toolkit elements.

**Compilation, builds, tests, settings, packages.** Start a Player build and poll its structured build report; switch
build target, poll the switch, and list targets; read and write build settings and list Unity 6 Build Profile assets;
force recompilation and poll completion; list, run, poll, and cancel filtered tests; read and change Audio, Graphics,
legacy Input, Physics, Player, Quality, Tags and Layers, and Time settings; list, search, add, remove, resolve, and
poll UPM packages.

**Editor and development-Player lifecycle.** Enter, pause, and exit Play Mode; inspect and focus the Editor; execute
or list Editor menu items; capture screenshots; read or clear console logs; read render, memory, and frame performance
statistics; set and inspect the authoring-root sandbox; connect to a development Player to inspect status, quit, set
target frame rate and time scale, simulate Input System key and pointer events, write and read logs, evaluate C#, and
apply hot-reload files. Project code can add typed commands with `[CliCommand]` and `[CliArg]`.

### 4.2 Transport and safety

Editor and Player servers bind to IPv4 loopback (`127.0.0.1`) and localhost, never a routable interface. Editor
production ports are `7800`-`7849`; development Player production ports are `7900`-`7949`. Every request needs a
startup-generated bearer token, and the descriptor file that holds the discovery state and the token is
user-restricted under the project's ignored `Library/Pipeline/` path. Requests that carry an `Origin` header are
rejected, which prevents browser-origin access. Mutating authoring commands use `confirm` and `dry_run`, Undo
grouping, and an authoring-root path sandbox where applicable. This is still a privileged interface: C# evaluation,
package mutation, asset deletion, project-setting changes, and build execution can perform broad mutations, so
read-only mode, destructive metadata, an audit trail, and an explicit confirmation model stay necessary when a client
proxies or wraps Pipeline commands.

## 5. Assistant MCP overlap

Assistant MCP capture completed 2026-08-02. Standalone CLI and Pipeline implications added 2026-08-07. Documentation
status reviewed 2026-08-13.

Both inventories are observed, not read off marketing pages. Raw captures live in `.agent/runs/TASK-6.1/artifacts/`.
This section compares the AI Assistant MCP (`com.unity.ai.assistant`) with Unity Cursor Toolkit. The standalone
`unity` CLI and `com.unity.pipeline` are a different product and transport; sections 3 and 4 own those.

### 5.1 Captured versions

| Side | Identity | Version | Minimum editor |
| --- | --- | --- | --- |
| Official | `com.unity.ai.assistant` from `https://packages.unity.com` | `2.17.0-pre.1` (registry `latest` on 2026-08-02, tarball shasum `284c75a8…`) | `6000.0.60f1` |
| Official | MCP relay binary, installed to `~/.unity/relay/` by the editor | ships inside the package | same |
| Official | Standalone Unity CLI | `1.0.0-beta.3` (released 2026-07-23) | Independent binary; manages multiple Editor versions |
| Official | `com.unity.pipeline` | `0.4.0-exp.1` documentation captured 2026-08-07 | Unity 6.0+ |
| Toolkit | `unity-cursor-toolkit` VS Code / Cursor extension | `0.6.1052826` | VS Code engine `^1.60.0` |
| Toolkit | `com.rankupgames.unity-cursor-toolkit` Unity package | `1.1.0` | `2019.4` |

The toolkit version and inventory belong to the dated capture; the extension source keeps a base package version while
release CI can assign a different distribution version, so check release artifacts separately. Capture editor: Unity
`6000.5.2f1` on macOS arm64, isolated empty project, `-batchmode -nographics`. The official inventory was read from
the package's own public registry API (`McpToolRegistry.GetAllToolsForSettings()`), so it reflects what the bridge
would advertise, including per-tool enabled state.

### 5.2 Observed inventories

The official server registered 54 tools, of which 7 are enabled by default. The toolkit server advertised 20 tools, 6
resources, and 4 prompts, all enabled. These numbers are not comparable and are capture facts only, not positioning
material: the official surface splits one capability across many narrow tools (14 separate `Unity_Profiler_*` tools),
while the toolkit dispatches on an `action` parameter inside a smaller number of tools.

Official tools by group; full names and schemas are in `official-mcp-tool-inventory.json`. Scripting and shaders: ten
tools, including `Unity_ManageScript`, `Unity_ApplyTextEdits`, `Unity_ValidateScript`, `Unity_ManageShader`, and
`Unity_RunCommand`. Scene and objects: `Unity_ManageScene`, `Unity_ManageGameObject`. Assets: `Unity_ManageAsset`,
`Unity_ImportExternalModel`, `Unity_FindProjectAssets`, `Unity_AudioClip_Edit`, nine `Unity_AssetGeneration_*`.
Editor: `Unity_ManageEditor`, `Unity_ManageMenuItem`, `Unity_GetProjectData`, `Unity_GetUserGuidelines`, two
`Unity_PackageManager_*`. Capture: `Unity_Camera_Capture`, two `Unity_SceneView_*`. Console: `Unity_GetConsoleLogs`,
`Unity_ReadConsole`. Files and search: `Unity_Grep` (bundled ripgrep over `Assets`), `Unity_ListResources`,
`Unity_ReadResource`, `Unity_FindInFile`. Profiler analysis: 14 `Unity_Profiler_*`. Enabled by default:
`Unity_RunCommand`, `Unity_GetConsoleLogs`, `Unity_Camera_Capture`, `Unity_SceneView_Capture2DScene`,
`Unity_SceneView_CaptureMultiAngleSceneView`, `Unity_AssetGeneration_GenerateAsset`,
`Unity_AssetGeneration_GetModels`; everything else, including all scene, GameObject, asset-management, and profiler
tools, is registered but off until a user enables it in Project Settings.

Toolkit tools: `manage_scene`, `manage_gameobject`, `manage_component`, `manage_asset`, `manage_material`,
`play_mode`, `editor_lifecycle`, `execute_menu_item`, `screenshot`, `project_info`, `editor_validation`,
`game_command`, `profiler_snapshot`, `build_trigger`, `batch_execute`, `unity_context`, `viewport_stream`,
`read_console`, `clear_console`, `resolve_meta`. Plus resources `unity://project/info`, `unity://scene/hierarchy`,
`unity://console/recent`, `unity://console/errors`, `unity://tools/catalog`, `unity://context/summary`, and four
workflow prompts.

### 5.3 Commoditized: the official package covers this

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

### 5.4 Parity in name, different in shape

**Profiler.** The official surface has the broader analysis vocabulary: 14 tools for counter summaries, frame-range
top-time, GC allocation breakdowns, and sample drill-down. They all read `ProfilerDriver` state, meaning a capture
already loaded in the editor's Profiler window; nothing official starts, stops, saves, or loads a capture, and every
profiler tool is disabled by default. The toolkit's `profiler_snapshot` owns the capture lifecycle instead (`current`,
`saveSession`, `listSessions`, `readSession`, `clearSessions`, `discoverCounters`) and fuses the capture with a
compact whole-console transcript (`readConsoleTranscript`). The honest claim is agent-driven capture and console-fused
timelines, not deeper profiler analysis.

**Script editing.** The official package ships a full editing suite plus `Unity_RunCommand`, which compiles and
executes arbitrary C# in the editor. The toolkit has no equivalent and should not grow one casually: an unrestricted
code-execution tool is exactly the surface the toolkit's safety rails exist to constrain, and `Unity_RunCommand` is
enabled by default upstream, bypassing any per-tool policy a proxy would apply to narrower mutating tools.

**Project search.** The official package bundles ripgrep behind `Unity_Grep` plus resource read tools. The toolkit's
`unity_context` answers a different question: it queries a tracked asset, meta, and object graph at
`.umetacontext/index.json` by GUID, class id, scene, prefab, and dependency edges, instead of searching file text.

### 5.5 Unique to the toolkit in the dated Assistant-only comparison

These points compare the toolkit with the captured Assistant package only. They do not by themselves establish
uniqueness against the standalone CLI or Pipeline; section 5.7 owns that broader comparison.

**Declared version span.** The Unity package metadata targets `2019.4`; the official package requires `6000.0.60f1` or
newer, so studios pinned to 2019, 2020, or 2022 LTS cannot run the captured official package. This is a declared range
comparison, not toolkit certification across every Editor in that range.

**No Unity Cloud AI dependency for the interface itself.** The toolkit server is a plain Node stdio process. The
official bridge ships inside the Assistant package, and its asset-generation tools — two of the seven
enabled-by-default tools — call Unity Cloud AI and consume organization AI points.

**Deployment envelope.** The toolkit MCP server runs standalone (`node out/mcp/server.js`) with no VS Code host, and
`game_command host=editorBatchmode` launches a headless editor run for a command. The official bridge lives inside a
running editor process; batch mode is only a connection-approval convenience, not an execution model.

**Safety controls at the protocol boundary.** `UNITY_CURSOR_TOOLKIT_MCP_READ_ONLY=1` refuses mutating calls before any
Unity traffic, `dryRun=true` returns the command that would run, and every tool advertises `readOnlyHint`,
`destructiveHint`, and `idempotentHint` annotations. The official module has no dry-run, no read-only mode, and no
destructive annotations; its controls are per-tool enable and disable in Project Settings, first-connection client
approval, and a validation-level dropdown scoped to `Unity_ManageScript`.

**Remote operation, project context, batching.** `viewport_stream` serves an MJPEG viewport with input injection
(`start`, `stop`, `status`, `input`) against a host and port, while the official capture tools return single images
from the local editor. `unity_context` over `.umetacontext`, `resolve_meta` for raw `.meta` reads, and the `unity://`
resource set give agents addressable project state. `batch_execute` runs a sequence with fail-stop semantics and
propagates dry-run and destructive classification, and four MCP prompts encode read-only-first investigation and
safe-edit planning.

### 5.6 Unique to the official package

Arbitrary C# compile-and-execute (`Unity_RunCommand`); a complete script authoring and patching suite with capability
negotiation; generative asset creation backed by Unity Cloud AI; Package Manager query and mutation tools; bundled
ripgrep search over `Assets`; profiler analysis breadth over an already-loaded capture; multi-client support against
one editor with a per-client approval registry; and shader and audio-clip authoring tools.

### 5.7 Standalone CLI and Pipeline correction

The 2026-08-02 Assistant comparison stays valid for that package, but it is not a complete comparison against Unity's
official agent and automation stack. The CLI and Pipeline captures change four earlier conclusions. Headless execution
is no longer toolkit-only in the broad sense: the toolkit keeps a distinct remote and batch deployment envelope and a
legacy span, but official `unity build`, `unity run`, and `unity test` now cover common local batch workflows.
First-party MCP is no longer only the Assistant relay, because `unity mcp` exposes Pipeline commands as MCP tools
without routing through the Assistant inventory. Build and test basics are commoditized on Unity 6+. And proxy work
must distinguish origins: Assistant MCP, Pipeline MCP, and toolkit tools have different transports, schemas, version
ranges, and safety properties, so a single catalog needs origin metadata and an explicit policy for arbitrary C#
evaluation and other broad mutations. Treat `eval` and `eval_file` in Pipeline and `Unity_RunCommand` in Assistant as
equivalent policy escape hatches: block or isolate them when advertising a read-only proxied session. Two notes for
proxy work: the relay is a separate process launched with `--mcp`, so proxying is a process-composition problem, not
an in-editor integration one, and wrapping must classify official tools by hand because the official surface carries
no read-only or destructive metadata to inherit. Prefer structured `unity` CLI JSON and NDJSON output plus documented
exit codes over scraping human output or reaching into the local HTTP descriptor directly.

### 5.8 Assistant MCP deployment, account, and package requirements

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

### 5.9 Reproducing this capture

Official side: `curl https://packages.unity.com/com.unity.ai.assistant` and read `dist-tags.latest`, then download and
shasum-verify the tarball; scaffold an empty project outside this repository, pinning that exact version and a Unity 6
editor; add an editor script that serializes
`Unity.AI.MCP.Editor.ToolRegistry.McpToolRegistry.GetAllToolsForSettings()`; run the editor with `-batchmode
-nographics -executeMethod … -quit`.

Toolkit side: run `npm ci --no-audit --no-fund && npm run compile` in `unity-cursor-toolkit/`; pipe `initialize`,
`tools/list`, `resources/list`, and `prompts/list` into `node out/mcp/server.js`; repeat the mutating call with
`UNITY_CURSOR_TOOLKIT_MCP_READ_ONLY=1` to confirm the refusal path. Full commands and environment details are in
`.agent/runs/TASK-6.1/artifacts/official-mcp-eval-setup.txt`.

CLI and Pipeline baseline below. A Pipeline install mutates a project's package manifest and lockfile, so do it in an
explicit spike project or a reviewed branch, pin the package version, and verify that its registry publication
timestamp satisfies the repository's seven-day package age gate before installation. Refresh section 5 whenever the
official package ships a new minor version.

```bash
brew install --cask unity-cli
unity --version && unity doctor
unity editors -i --format json
unity auth status && unity env --format json
unity auth login
unity pipeline list-versions
unity pipeline install --package-version 0.4.0-exp.1
unity pipeline list && unity status && unity list
unity command editor_status
```

## 6. Sources

**Unity 7 and CoreCLR**
- https://unity.com/news/unity-7-roadmap-revealed-at-unite-seoul
- https://www.gamedeveloper.com/programming/unity-unveils-unity-7-roadmap-with-update-path-that-won-t-break-your-build
- https://discussions.unity.com/t/path-to-coreclr-2026-upgrade-guide/1714279
- https://discussions.unity.com/t/coreclr-scripting-and-serialization-update-june-2026/1723299
- https://discussions.unity.com/t/unity-6-5-is-now-available/1723176
- https://docs.unity3d.com/6000.7/Documentation/Manual/scripting-backends-coreclr.html
- https://www.creativebloq.com/3d/video-game-design/unity-7s-most-surprising-advance-isnt-a-feature-upgrade

**Official MCP**
- https://docs.unity3d.com/Packages/com.unity.ai.assistant@2.7/manual/integration/unity-mcp-overview.html
- https://unity.com/blog/unity-ai-mcp-how-to-get-started

**Standalone Unity CLI and Hub CLI**
- https://docs.unity.com/en-us/unity-cli
- https://docs.unity.com/en-us/unity-cli/use-unity-cli
- https://docs.unity.com/en-us/unity-cli/unity-cli-reference
- https://docs.unity.com/en-us/unity-cli/release-notes
- https://docs.unity.com/en-us/hub/cli-overview
- https://docs.unity.com/en-us/hub/hub-cli-reference

**Unity Pipeline**
- https://docs.unity.com/en-us/unity-production-pipeline/local-tools-cli/unity-pipeline-package
- https://docs.unity3d.com/Packages/com.unity.pipeline@0.4/manual/index.html
- https://docs.unity3d.com/Packages/com.unity.pipeline@0.4/manual/connectivity.html
- https://docs.unity3d.com/Packages/com.unity.pipeline@0.4/manual/safety-and-mutations.html

**Editor, Player, and other first-party surfaces**
- https://docs.unity3d.com/6000.3/Documentation/Manual/EditorCommandLineArguments.html
- https://docs.unity3d.com/6000.3/Documentation/Manual/test-framework/reference-command-line.html
- https://docs.unity3d.com/6000.3/Documentation/Manual/PlayerCommandLineArguments.html
- https://docs.unity.com/en-us/build-automation
- https://docs.unity.com/en-us/build-automation/build-automation-api
- https://docs.unity.com/en-us/build-automation/run-builds/run-builds-automatically
- https://docs.unity.com/en-us/services/ugs-cli-introduction
- https://docs.unity.com/en-us/unity-version-control/uvcs-cli/version-control-cli
