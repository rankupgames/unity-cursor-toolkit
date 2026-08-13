# Unity CLI and Pipeline assessment

Status: dated research snapshot and implementation input. Captured 2026-08-07
against the cited CLI, Pipeline package, Editor command-line, Build Automation,
UGS CLI, and Unity Version Control documentation; documentation status reviewed
2026-08-13. Recheck versions and availability before installation or product
claims. Canonical readiness status: `UNITY_7_READINESS.md`. This is the detailed source for the
CLI-related decisions in `UNITY_7_LANDSCAPE_ASSESSMENT.md`,
`OFFICIAL_MCP_OVERLAP.md`, and WS4/WS6/WS8.

## Decision summary

- Unity's new standalone `unity` CLI is available now. It is not a Unity 7-only
  feature and WS8 is no longer blocked on a future beta publication event.
- The CLI is an experimental, separately installed binary. The current release
  captured here is `1.0.0-beta.3`, released 2026-07-23.
- The CLI is not tied to one Editor. It installs, discovers, selects, opens,
  runs, tests, and builds with multiple Editor versions. Project commands can
  resolve the version declared in `ProjectSettings/ProjectVersion.txt`.
- Live Editor and development-Player control is a separate layer provided by
  `com.unity.pipeline`. The current package documentation resolves to
  `0.4.0-exp.1` and requires Unity Editor 6.0 or later.
- The traditional Editor command line remains useful and is version-specific:
  the exact `Unity`/`Unity.exe` binary and matching versioned manual still own
  `-batchmode`, `-executeMethod`, low-level import, graphics, profiler, and
  licensing flags.
- The legacy Hub CLI is deprecated beginning with Hub 3.18.0. New toolkit work
  should target the standalone `unity` CLI, not add more Hub CLI integration.
- `unity build` is a local Editor batch-mode build. Unity Build Automation is a
  separate cloud service controlled through its Dashboard, Editor package, and
  REST API.
- The toolkit should become a safe, version-spanning orchestration layer over
  explicit backends: its existing bridge for legacy Editors, Unity Pipeline for
  Unity 6+, and local Editor batch execution where a headless job is required.
  Backend selection must be capability-driven and visible, never a silent
  compatibility fallback.
- None of the planned CLI/Pipeline adapter work is a shipped backend until its
  WS8 evidence and compatibility gates pass.

## Command-line surface map

| Surface | Invocation | Primary role | Version coupling and status |
| --- | --- | --- | --- |
| Standalone Unity CLI | `unity ...` | Editor/module/project management, local builds/tests, licensing, connected Editors, MCP, diagnostics | Independent experimental binary; captured at `1.0.0-beta.3`; manages multiple Editor versions |
| Unity Pipeline package | `com.unity.pipeline`, driven by `unity command` | Authenticated local control of a running Editor or development Player | Requires Editor 6.0+; captured docs are `0.4.0-exp.1` |
| Direct Unity Editor CLI | Exact `Unity`/`Unity.exe` plus Editor flags | Batch mode, custom static methods, builds, tests, imports, diagnostics | Strictly coupled to the launched Editor version and platform |
| Unity Player arguments | Built application plus Player flags | Headless Player, display/GPU selection, logging, debugging | Coupled to the build's Editor version and target platform |
| Legacy Hub CLI | Hub executable plus `-- --headless` | Legacy Editor/module installation | Deprecated from Hub 3.18.0 |
| Unity Build Automation | Dashboard, Editor package, REST API | Cloud CI builds, scheduling, status/history, cancellation, artifacts | Separate service and support matrix; not the local `unity build` command |
| UGS CLI | `ugs ...` | Deploy and manage Unity Gaming Services resources | Standalone and Editor-independent |
| Unity Version Control CLI | `cm ...` | Repositories, workspaces, branches, merges, locks, reviews, administration | Standalone and Editor-independent |

## Version-selection rules

1. Treat `ProjectSettings/ProjectVersion.txt` as the default Editor authority
   for an existing project.
2. Use exact Editor versions for CI and durable automation. Aliases such as
   `latest`, `lts`, `6`, or `6.5` are useful interactively but can move without
   a project change.
3. An installed build-support module belongs to one Editor installation. A
   module installed for `6000.3.9f1` does not prove the same module exists for
   `6000.5.2f1`.
4. Opening a project with a newer Editor is an upgrade operation, not ordinary
   launch behavior. The toolkit must not substitute a newer installed Editor
   when the declared version is missing.
5. `com.unity.pipeline` requires Unity 6.0+. Legacy projects continue through
   the toolkit's existing bridge and direct version-matched Editor execution.
6. Individual Pipeline commands can have narrower requirements. For example,
   UI Toolkit element capture is documented as requiring `6000.7+` even though
   the base package supports Unity 6.0+.
7. For direct Editor flags, use the manual for the exact Editor stream. Stable
   flag names exist across versions, but supported flags and behavior change.

## Standalone `unity` CLI capabilities

Unity says `unity --help` is authoritative for the installed beta. The web
reference can trail newly shipped commands and flags.

### Editors, modules, Hub, and releases

- `install`: install a specific Editor version or an alias such as `lts`,
  `latest`, a major stream, or the configured default; optionally install
  modules and child components in the same operation.
- `install-modules`: add one or more modules to an installed Editor.
- `uninstall`: remove an installed Editor version.
- `editors`: list releases, installed Editors, and running Editors; register a
  manually installed Editor, inspect its path and metadata, set a default, and
  upgrade an installed Editor within its supported stream.
- `editor`: manage one Editor installation, including module removal.
- `modules` and `releases`: inspect module catalogs and Unity release feeds.
- `install-path`: read or change the Editor installation directory.
- `hub`: install Unity Hub when its desktop UI is still required.
- `cache`: inspect or clean downloaded Editor/module content.

### Projects, templates, builds, execution, and tests

- `open`: open a project in a compatible Editor. `unity ./Project` is shorthand
  for `unity open ./Project`.
- `projects`: list, create, clone, register, open, pin, size, close, link, and
  unlink projects. Clone workflows cover GitHub, GitLab, and Unity Version
  Control with branch, commit, or changeset selection.
- `templates`: list, inspect, create, edit, delete, and relocate project
  templates.
- `build`: run a local project build in Editor batch mode with CI-oriented
  output and exit behavior. The current surface includes Editor selection,
  build target/output selection, Android signing, APK/AAB/Android Studio
  export, version codes, symbols, target SDK settings, Git-derived versioning,
  and dirty-worktree rejection unless explicitly allowed.
- `run`: run a project in batch mode, stream logs, return the Editor exit code,
  or launch a registered `[CliCommand]` headlessly with `--command`.
- `test`: run Edit Mode and Play Mode tests, filter the selection, choose the
  Editor version/path and architecture, write NUnit XML, enforce a timeout, and
  return operation-failed exit code `6` when tests fail.

### Accounts, licensing, and Unity Cloud identity

- `auth`: browser-based sign-in, status, and sign-out.
- `license`: list, inspect, activate, and return Personal, serial, floating, and
  offline licenses; inspect floating-license servers.
- `cloud`: inspect sign-in state and list/select Unity Cloud organizations and
  projects.

### Connected Editors and agents

- `pipeline`: install, upgrade, list versions of, and inspect the Unity Pipeline
  package in projects.
- `status`: show connected Editor state including port, project path, Editor
  version, and process id.
- `list`: query a connected Editor for every registered command, description,
  group, and parameter schema.
- `command` / `cmd`: list or execute commands on a selected connected Editor or
  development Player.
- `mcp`: start a stdio MCP server that exposes connected Editor commands as MCP
  tools; assisted configuration exists for supported agent clients.

### Automation and diagnostics

- Human, TSV, JSON, and streaming NDJSON output. Piped output defaults to TSV;
  automation should select a format explicitly.
- Differentiated exit codes: success, general failure, usage error,
  authentication/authorization failure, missing configuration, operation
  failure, Ctrl+C, and SIGTERM.
- Non-interactive execution, quiet/no-banner output, confirmations, project and
  organization defaults, proxy configuration, watch modes, and environment
  variable equivalents.
- `shell`: a warm interactive process with history, completion, project/org
  session context, and an NDJSON request/response protocol for agents.
- `completion`: shell completion for bash, zsh, fish, and PowerShell.
- `doctor`, `diagnose`, `logs`, and `env`: environment health, proxy diagnostics,
  log reading/tailing, and resolved path/version inspection.
- `config`, `analytics`, `bug`, `language`, and `changelog`: settings, consent,
  bug reporting, localization, and release information.
- `upgrade`, rollback support where available, and `self-uninstall` for CLI
  lifecycle management.
- External command discovery through executables named `unity-<name>`.

## Unity Pipeline capabilities

`com.unity.pipeline` runs an authenticated local HTTP API in a Unity Editor or
development Player. The CLI discovers an instance and turns registered
commands into terminal and MCP tools.

### Assets and files

- Create ScriptableObject/Object assets.
- Import external files.
- Move, copy, rename, delete, and find assets.
- Read or change importer settings and reimport.
- Create folders and read/write project text files.

### Scenes, GameObjects, components, and prefabs

- Create, open, save, list, and activate scenes.
- Inspect scene hierarchy and update scenes in Build Settings.
- Create, batch-create, find, transform, parent, activate, tag, layer, rename,
  and delete GameObjects.
- Add, remove, inspect, and modify serialized component properties.
- Create and instantiate prefabs, create variants, apply/revert overrides,
  unpack instances, and edit prefab contents.

### Scripts, animation, materials, and shaders

- Create and attach C# scripts; inspect and set serialized fields.
- Create AnimationClips and curves.
- Create and inspect Animator Controllers, parameters, layers, states, and
  transitions.
- Create Timelines, tracks, and clips.
- Inspect and change material shaders, properties, and keywords.
- List shaders and introspect shader properties.

### Baking, search, selection, and capture

- Start, poll, cancel, configure, and clear lighting bakes.
- Start, poll, cancel, configure, and clear NavMesh and occlusion bakes.
- Bake AI Navigation `NavMeshSurface` components.
- Read or set Editor selection and run Unity Search queries.
- Capture Game view, Scene view, and supported UI Toolkit elements.

### Compilation, builds, and tests

- Start a Player build and poll its structured build report.
- Switch build target, poll the switch, and list available targets.
- Read/write build settings and list Unity 6 Build Profile assets.
- Force script recompilation and poll completion.
- List tests, run filtered tests, poll results, and cancel a run.

### Project settings and packages

- Read and change Audio, Graphics, legacy Input, Physics, Player, Quality,
  Tags/Layers, and Time settings.
- List and search UPM packages.
- Add, remove, resolve, and poll package operations.

### Editor and development-Player lifecycle

- Enter, pause, and exit Play Mode; inspect and focus the Editor.
- Execute or list Editor menu items.
- Capture screenshots and read/clear console logs.
- Read render, memory, and frame performance statistics.
- Set and inspect the authoring-root sandbox.
- Connect to a development Player to inspect status, quit, set target frame
  rate/time scale, simulate Input System key/pointer events, write/read logs,
  evaluate C#, and apply hot-reload files.
- Add project-specific typed commands with `[CliCommand]` and `[CliArg]`.

## Pipeline transport and safety

- Editor and Player servers bind to IPv4 loopback (`127.0.0.1`) and localhost,
  never a routable interface.
- Editor production ports are `7800`-`7849`; development Player production
  ports are `7900`-`7949`.
- Every request requires a startup-generated bearer token. The descriptor file
  containing discovery state and the token is user-restricted under the
  project's ignored `Library/Pipeline/` path.
- Requests with an `Origin` header are rejected to prevent browser-origin
  access to the local service.
- Mutating authoring commands use `confirm`/`dry_run`, Undo grouping, and an
  authoring-root path sandbox where applicable.
- This remains a privileged interface. C# evaluation, package mutation, asset
  deletion, project-setting changes, and build execution can perform broad
  mutations. The toolkit's read-only mode, destructive metadata, audit trail,
  and explicit confirmation model remain differentiators worth applying when
  proxying or wrapping Pipeline commands.

## Traditional Editor CLI capabilities that remain relevant

- Create or open projects and clone from templates.
- Run `-batchmode`, `-nographics`, and controlled quit behavior.
- Execute project-defined static Editor methods with `-executeMethod`.
- Select build targets/profiles or call custom `BuildPipeline` code.
- Run Edit Mode, Play Mode, and Player tests with filters and NUnit output.
- Enable code coverage.
- Import/export `.unitypackage` files and configure Package Manager behavior.
- Verify deterministic asset importing and control asset import overrides.
- Configure Unity Accelerator/Cache Server behavior.
- Control logs, stack traces, job-worker counts, API updating, and VCS session
  settings.
- Select graphics APIs/GPUs and configure debugging, shader validation, Metal,
  and Profiler behavior.
- Activate, return, or manually install licenses.
- Perform recovery operations such as a full Library rebuild.

The toolkit should retain direct Editor CLI support for legacy versions and for
project-specific `-executeMethod` entry points that have not been registered as
Pipeline `[CliCommand]` commands.

## Other first-party automation surfaces

### Build Automation

Unity Build Automation is cloud CI, not an alternate spelling of `unity build`.
Its REST API can trigger a configured build, inspect attempt status and build
history, cancel attempts, and retrieve related results. Automatic builds can
also run from repository changes or schedules. The Unity 6 Build Automation
Editor package integrates cloud targets with Build Profiles.

### UGS CLI

The separate `ugs` CLI manages environments and service configuration for
Access, CCD, Cloud Code, Cloud Save, Economy, Game Server Hosting, Leaderboards,
Lobby, Matchmaker, Player Authentication, Remote Config, Scheduler, Schema
Registry, and Triggers. It is a service-deployment surface, not Editor control.

### Unity Version Control CLI

The separate `cm` CLI owns repository/workspace creation, add/checkin/checkout,
branch/merge/diff, labels, shelvesets, locks, reviews, replication, users/ACLs,
triggers, history, queries, archives, and administration.

## Toolkit product implications

### What is newly commoditized

- Multi-version Editor installation, discovery, module management, project
  opening, local batch builds, tests, licensing, and diagnostics now have a
  first-party terminal surface.
- On Unity 6+, Pipeline now covers broad asset/scene/object/prefab/script/
  animation/material/baking/project-setting/package/build/test operations.
- Unity now provides its own stdio MCP adapter over Pipeline commands, separate
  from the AI Assistant MCP assessed in `OFFICIAL_MCP_OVERLAP.md`.

### What the toolkit should keep leading with

- One stable interface across Unity 2019.4 through current Unity 6/7 streams.
- Explicit safety policy: read-only mode, dry-run, destructive annotations,
  auditability, and controlled proxy exposure.
- Remote and headless deployment, viewport streaming, and virtualized shell.
- Structured `.umetacontext`, project resources, profiler-capture lifecycle,
  console-fused timelines, and version-aware workflows.
- Composition: unify the standalone Unity CLI, Pipeline, AI Assistant MCP,
  legacy toolkit bridge, remote hosts, and CI into one capability-advertised
  agent interface.

### Proposed integration architecture

1. Add a TypeScript `UnityCliAdapter` that invokes `unity` without a shell,
   passes argument arrays, consumes explicit JSON/NDJSON, captures stderr, and
   maps documented exit codes to typed results.
2. Resolve projects and Editors through project metadata and CLI discovery.
   Do not embed OS-specific Unity installation paths in durable code.
3. Add a `UnityPipelineAdapter` that discovers connected Editors by project,
   lists schemas, invokes commands, and refuses commands not admitted by the
   toolkit policy layer.
4. Keep the legacy TCP bridge as an explicit backend for pre-Unity-6 projects
   and unique toolkit operations. Report the selected backend in status and
   every operation result.
5. Compose MCP tool catalogs with origin metadata (`toolkit`, `pipeline`,
   `assistant`) and stable aliases. Never expose duplicate unqualified names or
   weaken existing public toolkit schemas.
6. Convert project-specific automation to shared non-exiting services, then
   expose thin wrappers for both traditional `-executeMethod` and Pipeline
   `[CliCommand]`. A command that calls `EditorApplication.Exit` is unsuitable
   for invocation in a user-facing connected Editor.
7. Preserve local builds/tests as local operations. Add cloud Build Automation
   only through an explicit separate adapter and typed API contract.

## Setup and adoption plan

### Phase 0: install and baseline the standalone CLI

No Unity project mutation is required for this phase.

```bash
brew install --cask unity-cli

unity --version
unity doctor
unity editors -i --format json
unity auth status
unity env --format json
```

- Record the exact CLI version and installation method.
- For CI, pin or freeze the verified CLI release rather than following the
  beta channel implicitly.
- Treat `unity --help` and each subcommand's `--help` as the installed-version
  contract.
- Test CLI output and exit-code parsing before adding a toolkit adapter.

### Phase 1: prove Editor selection and local jobs

```bash
unity open ./PathToProject
unity test --help
unity build --help
unity run --help
```

- Confirm `open` selects the version from `ProjectVersion.txt`.
- Confirm missing exact Editors/modules fail closed in non-interactive mode.
- Run one filtered Edit Mode test with an NUnit output path.
- Run one non-signing development build on an installed target module.
- Capture human, JSON, and NDJSON behavior plus all exit codes encountered.

### Phase 2: isolated Pipeline package spike

The Pipeline install mutates a project's package manifest and lockfile. Perform
it in an explicit spike project or reviewed branch, pin the package version,
and verify its registry publication timestamp satisfies the repository's
seven-day package age gate before installation.

```bash
unity auth login
unity pipeline list-versions
unity pipeline install --package-version 0.4.0-exp.1
unity pipeline list
unity status
unity list
unity command editor_status
```

- Review package-manifest and lockfile changes.
- Verify recompilation and domain-reload behavior.
- Exercise read-only discovery, console, test-listing, and build-target listing.
- Exercise one mutation with `dry_run` before confirmation and prove Undo.
- Start `unity mcp`, list tools from an MCP client, and prove project targeting
  when multiple Editors are open.
- Verify the server remains loopback-only and token-authenticated.

### Phase 3: toolkit integration

- Implement the CLI adapter and typed exit-code model.
- Add CLI presence/version/status to the toolkit doctor/status surface.
- Reuse `unity test` for the Unity 6+ local/batch path after parity proof; keep
  the existing bridge path for legacy Editors and toolkit-specific streaming.
- Reuse `unity build` where its surface covers the requested build; retain
  project-defined build services for custom Addressables/data/codegen flows.
- Add Pipeline catalog discovery and policy classification.
- Decide whether `unity mcp` is composed as a child process or Pipeline commands
  are invoked directly through the CLI adapter. Record the security tradeoff.
- Add compatibility tests across one legacy Editor, 2022 LTS, the current Unity
  6 project version, and the next Unity 6/7 preview stream.

### Phase 4: product and CI rollout

- Publish a backend/capability matrix rather than a feature-count comparison.
- Add structured diagnostics that state CLI version, project Editor version,
  installed target modules, Pipeline version, connected instance, and selected
  backend without exposing tokens or credentials.
- Add clean-checkout tests for CLI absence, wrong version, missing Editor,
  missing target module, authentication failure, Pipeline absence, multiple
  running Editors, test failure, build failure, interruption, and timeout.
- Keep official CLI/Pipeline support additive until the compatibility matrix
  proves it can replace a specific toolkit path.

## WIA Prime Forces reference snapshot

This is dated integration evidence, not a toolkit invariant.

Observed on 2026-08-07:

- WIA declares Unity `6000.3.9f1` with revision `7a9955a4f2fa`.
- Editors `6000.3.9f1` and `6000.5.2f1` are installed on the inspected Mac.
- The WIA Editor installation has Android, iOS, and Windows playback/build
  support directories. The separate `6000.5.2f1` installation has a different
  module set, proving modules must be checked per exact Editor.
- The standalone `unity` CLI is not on `PATH`.
- `com.unity.pipeline` is not present in WIA's package manifest or lockfile.
- WIA already has custom batch entry points for compile validation, Android/iOS
  builds, variants, build profiles, signing inputs, game-data validation/export,
  Addressables, and Odin IL2CPP AOT work.
- WIA's current test runner defaults to a hardcoded macOS Editor path and can
  generate missing SpacetimeDB bindings from sibling or freshly cloned source.
  That runner must be made machine-agnostic and artifact-driven before it is a
  canonical example: resolve the declared Editor through the CLI/configuration
  and fail closed when the required generated-binding artifact is missing.

Recommended WIA proof order:

1. Install and baseline the standalone CLI without changing the project.
2. Prove exact `6000.3.9f1` selection and module discovery.
3. Prove a filtered Edit Mode test and compile-validation job.
4. Repair the existing test wrapper's Editor resolution and binding bootstrap.
5. Add pinned Pipeline in a reviewed spike branch and expose non-exiting WIA
   commands over shared build services.
6. Connect `unity mcp` to an agent client only after the tool catalog and
   mutation policy have been reviewed.

## Workstream corrections

- WS4 must compare and compose three official surfaces, not only AI Assistant
  MCP: AI Assistant MCP, standalone Unity CLI MCP, and Pipeline commands.
- WS6 should start with a parity spike against `unity test`. Do not build a
  second Unity 6 test launcher until the required legacy, streaming, filtering,
  or safety gaps are measured.
- WS8 changes from "wait for Unity 7" to active CLI/Pipeline adoption. The
  remaining watch item is the Unity 7-specific delta, not CLI availability.
- WS7 remains differentiated: Pipeline provides semantic control and still
  does not replace a remote rendered Editor-window shell.

## Sources

- Unity CLI overview: https://docs.unity.com/en-us/unity-cli
- Unity CLI use/install guide: https://docs.unity.com/en-us/unity-cli/use-unity-cli
- Unity CLI reference: https://docs.unity.com/en-us/unity-cli/unity-cli-reference
- Unity CLI release notes: https://docs.unity.com/en-us/unity-cli/release-notes
- Hub CLI overview and deprecation: https://docs.unity.com/en-us/hub/cli-overview
- Hub CLI reference: https://docs.unity.com/en-us/hub/hub-cli-reference
- Unity Pipeline setup: https://docs.unity.com/en-us/unity-production-pipeline/local-tools-cli/unity-pipeline-package
- Unity Pipeline command index: https://docs.unity3d.com/Packages/com.unity.pipeline@0.4/manual/index.html
- Unity Pipeline connectivity: https://docs.unity3d.com/Packages/com.unity.pipeline@0.4/manual/connectivity.html
- Unity Pipeline mutation safety: https://docs.unity3d.com/Packages/com.unity.pipeline@0.4/manual/safety-and-mutations.html
- Unity 6.3 Editor CLI: https://docs.unity3d.com/6000.3/Documentation/Manual/EditorCommandLineArguments.html
- Unity 6.3 Test Framework CLI: https://docs.unity3d.com/6000.3/Documentation/Manual/test-framework/reference-command-line.html
- Unity 6.3 Player CLI: https://docs.unity3d.com/6000.3/Documentation/Manual/PlayerCommandLineArguments.html
- Unity Build Automation: https://docs.unity.com/en-us/build-automation
- Build Automation API: https://docs.unity.com/en-us/build-automation/build-automation-api
- Build Automation API-triggered jobs: https://docs.unity.com/en-us/build-automation/run-builds/run-builds-automatically
- UGS CLI: https://docs.unity.com/en-us/services/ugs-cli-introduction
- Unity Version Control CLI: https://docs.unity.com/en-us/unity-version-control/uvcs-cli/version-control-cli
