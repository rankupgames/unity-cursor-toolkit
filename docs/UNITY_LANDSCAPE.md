# Unity landscape research

Last reviewed: 2026-10-08 (CLI baseline and classified inventory; older captures remain dated)

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

### 3.0 Installed CLI capture, 2026-10-08

The installed Windows x64 binary is pinned to `1.0.0-beta.12`, beta channel, SHA-256
`94047d1d84d66fc178cee541a9c3f69d2199edf15cdf37d3f308d7d9fb064a96`.
Unity's [release notes](https://docs.unity.com/en-us/unity-cli/release-notes) date this release to September 30, 2026.
It is eight days old on this capture date. The original installation date and its age check are not established.
No CLI, Editor, or package install or upgrade was performed for this capture.

[Baseline evidence](../experiments/unity-cli-baseline/captures/2026-10-08-cli-1.0.0-beta.12-windows-x64.json)
contains version/build identity, doctor, environment, installed Editors, sanitized authentication state,
root help, and help for editors, open, build, run, test, pipeline, command, list, status, and mcp.
[Capture script](../experiments/unity-cli-baseline/capture-baseline.js) refuses a different CLI version.
Account identifiers, credentials, OS-user/host identifiers, local roots, and doctor recent-log contents are omitted or redacted.
Capture scripts derive Editor roots from the installed inventory; they contain no machine-specific installation path.
This installed capture supersedes the August CLI contract below; historical package observations remain separate.

Installed Editors were `6000.3.9f1`, `6000.3.25f1`, `6000.6.4f1`, and `7000.0.0a7`.
The module inventory records Android as installed for `6000.3.9f1` and available, not installed,
for `6000.6.4f1`. Installed-module listing alone does not prove build preflight enforcement.

| Contract | Installed beta.12 evidence | Limit |
| --- | --- | --- |
| Formats | Root and requested command help advertise human, JSON, TSV, NDJSON, and github | Per-command progress/result framing must be proved |
| Piped default | Installed-Editor listing without a format produces TSV | Select an explicit format in automation |
| JSON | Version and usage failures use success/command/data/errors/warnings envelopes | Do not infer every command has identical data |
| NDJSON | Version emits one bare version object per line | It is not a terminal result envelope; long operations need separate proof |
| Usage failure | Invalid command and option exit 2 with INVALID_COMMAND_ARGS | Other error classes are not inferred from this case |
| Missing exact Editor | Empty fixture declares 6000.6.999f1; noninteractive open exits 6, naming that version | Does not prove launch/module selection for an installed version |
| Run/build/test timeout | All three installed help pages expose timeout in seconds | Timeout cleanup and leftover processes need execution proof |
| Test selection/reporting | Mode, filter, NUnit/JUnit, sharding, retries, failed/affected selection, coverage | No test discovery/list option is advertised by installed test help |
| Registered headless command | Run exposes command and parses following arguments against its schema | Requires a verified Pipeline package and registered handler |

The [missing-Editor evidence](../experiments/unity-cli-baseline/captures/2026-10-08-cli-1.0.0-beta.12-windows-x64-missing-editor.json)
records arguments, both streams, exit code, and the complete empty fixture inputs. The fixture was removed afterward.
It did not install the missing Editor or select a newer installed Editor.

The current [CLI reference](https://docs.unity.com/en-us/unity-cli/unity-cli-reference#exit-codes)
documents 0 success, 1 general error, 2 usage, 3 authentication/authorization, 4 missing configuration,
6 incomplete/failed operation, 7 unavailable service or Editor connection, 8 completed tests with failures,
130 interruption, and 143 termination. Baseline diagnostics observe 0 and 2; the missing-Editor proof observes 6.
The old blanket test-failure code 6 below is not a current contract. The execution proof below observes test failure 8 and native Ctrl+C 130.

The [exact-version fixture source](../experiments/unity-cli-baseline/fixture/Assets/Editor/CliProof.cs)
and [proof runner](../experiments/unity-cli-baseline/capture-proof.js) add no production backend.
The runner creates a separate project declaring one exact installed version; it does not upgrade the sample project.
Unity `6000.6.4f1 (12bfff696524)` used its shipped Test Framework `1.8.0` and NUnit `2.1.0` through local file references.
The existing cached Test Framework `1.6.0` failed to compile on this Editor because AssemblyFlags was ambiguous.
That failure is retained; no package source was patched. A separate `6000.3.9f1` empty fixture batch run also passed.

All execution captures use the prefix
`experiments/unity-cli-baseline/captures/2026-10-08-cli-1.0.0-beta.12-editor-6000.6.4f1-windows-x64-`.
Each JSON contains the actual arguments, stdout, stderr, Editor log where present, duration, project-version check,
and the exact owned-project leftover-process query result. No case left an owned Editor running.
Unity added revision metadata on first import; the declared Editor version remained unchanged.
NUnit XML is retained verbatim beside each completed test capture. Raw logs can contain harmless analyzer or licensing-validation warnings;
the recorded exit and result are reported separately from those messages.

| Case suffix | Observed result | Coverage or gap |
| --- | --- | --- |
| run.json | Exit 0; CLI_PROOF_RUNTIME 6000.6.4f1 | Exact installed-Editor batch execution covered |
| edit-pass.json / .xml | Exit 0; one passing filtered EditMode test | Mode, filter, XML covered |
| edit-fail.json / .xml | Exit 8, TESTS_FAILED; one failed test | Completed test failure differs from incomplete operation |
| play-pass.json / .xml | Exit 0; one passing PlayMode test | PlayMode covered |
| play-progress.json / .xml | Exit 0; 30 progress log markers over a 39.75-second invocation | Marker 0 arrived at 7.962 s; marker 29 at 36.977 s; stderr carries logs |
| test-timeout.json | Exit 6, TEST_TIMED_OUT; 10-second setting, 11.782-second invocation; no XML | Timeout and owned-Editor cleanup covered |
| test-cancel.json | Native PTY Ctrl+C; child CLI exit 130 after 16.076 s; no XML, no owned Editor | Cancellation and cleanup covered; the interrupted parent shell exited 1 |
| test-list.json | Exit 2, INVALID_COMMAND_ARGS for list | Native CLI discovery missing in this installed contract; no second launcher added |
| build.json | Exit 0; nonsigning Windows development build | Basic build covered; default none versioning allowed the dirty tree |
| build-dirty-versioned.json | Exit 6 naming uncommitted changes | Dirty guard covered with semantic versioning |
| build-versioned.json | Exit 0 with semantic versioning and allow-dirty-build | Explicit guard override covered |
| missing-module.json | Exit 6; Editor reports unsupported Android target | Per-Editor inventory proves Android exists only on 6000.3.9f1; CLI error does not name the missing module, so resolution acceptance is partial |
| registered-command.json | Exit 6 naming absent com.unity.pipeline | Registered CliCommand execution blocked; no install or imitation |
| run-timeout.json / build-timeout.json | Exit 6 after about 17 s with 15-second settings | Owned Editor cleanup covered; deliberate partial Temp file retained by the fixture |
| run-reserved-flag.json / build-reserved-flag.json | Exit 6 for forwarded quit/nographics flags | CLI-managed reserved flags must not be repeated |

The build method honors the forwarded buildTarget and buildOutput arguments. A custom method remains responsible for its build options.
The Android refusal comes from BuildPipeline, not a proven CLI module preflight. The real sample's declared Editor remains `6000.3.9f1`;
CLI-driven real-project launch/resolution is not established by the isolated fixture.
Shared pre-existing build outputs remain present after failed cases. A presence flag does not mean a failed case created a Player.

Installed output behavior needs per-command handling. Test JSON returned valid result envelopes and report paths on stdout while logs streamed to stderr.
The long PlayMode NDJSON run emitted no stdout result frames; its logs streamed to stderr, with NUnit XML and exit 0 carrying the result. Build JSON emitted progress records,
Editor text, then a formatted JSON result on stdout, so the complete stream was not one JSON document.
Version JSON/NDJSON worked as recorded above. Automation must not use those version examples as a universal parser contract.
Partial Player output under a real interrupted build and project-specific command parity remain unproved.
These results do not justify replacing the existing toolkit batch launcher or adding a second test launcher.

### Adapter failure matrix

The extension's diagnostic backend uses the recorded `1.0.0-beta.12` pin.
It invokes version and doctor through a shell-free Node
adapter. CLI presence and version are independent of toolkit bridge health.
Only a complete JSON envelope is accepted; the mixed build framing above fails
closed. Native codes and raw exit/signal values remain in the typed result.

| Condition | Local code / source | Recovery and proof |
|---|---|---|
| Binary absent or explicit path invalid | cli_not_found; no CLI process | Set the native executable path; fixture covers config, env, PATH and missing override |
| Windows shell wrapper | unsupported_binary; no CLI process | Select unity.exe; no shell fallback |
| Different version | version_mismatch; found/expected retained | Select the pinned binary; diagnostic warning, no automatic upgrade |
| Invalid arguments | invalid_arguments / INVALID_COMMAND_ARGS, exit 2 | Use the pinned help; captured test-list and baseline failures |
| Exact Editor absent | missing_editor / COMMAND_FAILED, exit 6 | Install the declared version and required modules; captured 6000.6.999f1 message, no substitution |
| Compiler failure | operation_failed / COMMAND_FAILED, exit 6 | Inspect the Editor log; captured framework ambiguity remains generic |
| Failing tests | tests_failed / TESTS_FAILED, exit 8 | Inspect the NUnit results; captured deliberate failure |
| CLI test timeout | timed_out / TEST_TIMED_OUT, exit 6 | Inspect incomplete results before retrying; captured timeout |
| Native Ctrl+C | cancelled; exit 130 | Captured native PTY interruption; no claim that Node kill reproduces Ctrl+C |
| Caller timeout / abort | timed_out / cancelled; raw exit retained | Owned Node process-tree test confirms parent/child exit and unrelated sentinel survival on Windows |
| Cleanup not confirmed | cleanup_failed; terminationReason retained | Inspect the owned process before retrying; simulated helper refusal is distinct from completed cleanup |
| Malformed, truncated, mixed or oversized stdout | invalid_output; excerpt at most 500 characters | Do not extract a nested or trailing success; recorded mixed build/module output and framing fault tests |
| Local read-only refusal | policy_refused; no CLI process | Diagnostic allowlist rejects the operation before spawn |
| Spawn failure | spawn_failed | Check executable permissions and environment; controlled failure test |
| Non-specific CLI failure | operation_failed; native code and exit retained | Inspect source diagnostics; no invented native subtype |
| Undocumented exit code | unknown_exit; native code, exit and streams retained | Inspect the pinned CLI output; recorded generic envelope with an injected unknown numeric exit protects this boundary |
| Missing module / build failure | invalid_output for current mixed capture; no module-specific native code | Android absence is demonstrated in the Editor log/inventory, not a CLI module preflight; specific classification pending |
| Authentication, ambiguous installed Editors, locked project | Capture and specific classification pending | Do not infer these from generic COMMAND_FAILED; RUG-549 acceptance remains partial |

Streams are bounded to 1,048,576 characters each. Windows cancellation invokes
`taskkill /PID <owned CLI PID> /T /F` directly and waits for utility success
and child close. It does not use image filters or discover user Editors.
Node's Windows `child.kill` is abrupt termination and differs from native
Ctrl+C. POSIX uses a separate owned process group with TERM then KILL.
[Node process semantics](https://nodejs.org/api/child_process.html#subprocesskillsignal),
[process groups](https://nodejs.org/api/child_process.html#optionsdetached), and
[Windows taskkill](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/taskkill)
define these boundaries. Utility failure or a missed close deadline fails closed.
Partial artifacts are not deleted by the adapter.

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


### Current eligibility and isolated install, 2026-10-08

The current explicit pin is `com.unity.pipeline@0.8.0-exp.1`. The anonymous
[official registry](https://packages.unity.com/com.unity.pipeline) published it at
`2026-09-25T18:42:14.022Z`. The final pre-install query completed at
`2026-10-08T05:55:07.222Z`, with HTTP Date `Thu, 08 Oct 2026 05:55:07 GMT`.
The smaller of the local and server ages was 12.47 days, above the seven-day gate.
CLI `pipeline list-versions` reports available versions but does not report publication timestamps.
The gate queries current registry versions and dates each time, requires an explicit pin, and refuses
missing metadata, a recent publication or an unsupported declared Editor before the install writer.
Its [implementation](../unity-cursor-toolkit/src/core/pipelineEligibility.ts) reuses the declared-project version reader.

The package registry minimum is `6000.0`, consistent with the
[Unity 6 prerequisite](https://docs.unity.com/en-us/unity-cli/unity-pipeline/unity-pipeline-package).
Individual commands can require a later Editor: Pipeline 0.8
[UI Toolkit capture documentation](https://docs.unity3d.com/Packages/com.unity.pipeline@0.8/manual/commands/capture.html)
requires `6000.7+` for `capture_editor_element` and `capture_runtime_element`.
Neither command appeared in the observed 6000.3.9f1 catalog. Package eligibility does not approve those commands.

The [isolated proof](../experiments/pipeline-install-proof/results/2026-10-08T05-54-49-306Z-cli-1.0.0-beta.12-pipeline-0.8.0-exp.1-editor-6000.3.9f1-windows-x64.json)
used CLI `1.0.0-beta.12` and Editor `6000.3.9f1_7a9955a4f2fa` in a new TEMP project.
Its baseline manifest and lock contained no dependencies. The only manifest change was the exact Pipeline pin.
The lock added Pipeline 0.8.0-exp.1, Mono.Cecil 1.11.6 and Newtonsoft.Json 3.2.2 from the registry;
Test Framework 1.6.0, NUnit 2.0.5 and eight Unity modules came from the selected Editor.
The artifact records all 13 before/after lock entries, including every dependency edge.
The resolver selected Newtonsoft.Json 3.2.2 over the package's 3.0.2 requirement,
Test Framework 1.6.0 over 1.1.33, and NUnit 2.0.5 over 2.0.3; these are observed resolution results.

The explicit install took 0.846 seconds. The owned fixture then requested package resolution through
[Client.Resolve](https://docs.unity3d.com/6000.3/Documentation/ScriptReference/PackageManager.Client.Resolve.html),
because a hidden Editor did not observe the external manifest edit on the first attempt.
The final cached run reported package resolution in 6.91 seconds, domain reload profiling at 3357 ms,
script compilation at 2374 ms, and readiness 17.753 seconds after the install started, with no compiler errors.
Live `pipeline list`, `status`, `list` (160 registered commands), and `command editor_status` succeeded.
Global discovery was filtered in memory to the exact owned project before persistence.
The fixture's normal quit marker, Unity quitting callback and process exit were all observed.
The Editor exit code is unknown because this recorder uses `Start-Process`.

Run `npm run compile` in `unity-cursor-toolkit/`, then
`node experiments/pipeline-install-proof/capture-proof.js` from the repository root.
The [runner](../experiments/pipeline-install-proof/capture-proof.js) resolves the installed Editor from CLI inventory;
`UNITY_CLI_BINARY` can select the CLI executable. It uses a fresh gate immediately before the package writer,
retains timestamped attempts, and removes credentials, user identities and machine paths from recorded output.
The authored [fixture](../experiments/pipeline-install-proof/fixture/Assets/Editor/PipelineInstallProof.cs)
is the only project source copied into TEMP. No sample, toolkit package or user project was changed.
This proves one isolated install and read path. It does not establish command safety, MCP composition,
development-Player behavior or newer Editor compatibility.

### Current transport and composition proof, 2026-10-08

The proof-only [composition experiment](../experiments/pipeline-composition-spike/DECISION.md) compares direct CLI and stdio MCP with CLI 1.0.0-beta.12, Pipeline 0.8.0-exp.1, and two exact 6000.3.9f1_7a9955a4f2fa disposable Windows Editors. The [completed capture](../experiments/pipeline-composition-spike/results/2026-10-08T06-32-23-165Z-windows-x64.json) records a fresh eligibility gate before the second explicit-pin install, distinct seeded target results, transport refusals, authoring checks, and both normal shutdowns. The second resolved pin and 13-package lock were inspected after shutdown.

Both servers had loopback listeners. Requests through a routable host interface failed with ECONNRESET; missing/wrong credentials returned 401, valid in-memory credentials returned 200, and foreign/null Origins returned 403. The Library descriptor had inheritance disabled and one current-user FullControl grant. Library/ is declared ignored in these non-Git fixtures; Git ignore behavior is not claimed. Source permits Origin: null through a separate browser opt-in, so the observed rejection describes the tested default only. Credential values, host interface addresses, account identifiers, and machine paths are omitted.

The [source-reviewed matrix](../experiments/pipeline-composition-spike/command-risk-matrix.json) covers the whole 160-command package catalog: 49 read-only, 62 mutating, 30 destructive, and 19 policy-escape. It records relative source paths, symbols, lines, and reasons. Arbitrary eval/menu/package-source paths, imported caller C#, and reflected custom getters/setters remain outside the read-only prototype. Some labels are conservative source inferences; no exploit was executed. The refusal-only bake_navmesh_surfaces implementation is classified for this exact version, not its advertised name.

The authoring checks observed the confined root before calls. Deletion dry-run preserved asset bytes; deletion without confirmation refused; outside-root text writes refused; a batch dry-run left scene bytes and hierarchy unchanged. Standalone object creation, scene creation, and menu execution lack dry-run parameters. Scene/menu commands were not executed; the approved two-object creation was removed by one Undo.

Direct CLI returned complete JSON/native errors and real NDJSON progress frames at 40% and 100%. The tested stdio MCP delay returned JSON text but no progress notifications. CLI missing-file and native timeout failures both used COMMAND_FAILED/exit 6. MCP returned isError for the missing file; its bounded local deadline later received a successful reply. MCP cancellation suppressed the reply, while the deliberately noncooperative delay continued. These observations do not establish behavior for SDK commands that check cooperative cancellation.

The private decision is to use a narrow direct CLI backend in a later integration and decline unrestricted MCP catalog relay. Success and failure tags differ ('command read_text_file' versus 'unity command read_text_file'); a future parser must preserve the captured contract. This proof adds no production provider, public schema, or UI, and keeps the installed CLI pin despite an upstream update advertisement.

A [failed readiness refinement](../experiments/pipeline-composition-spike/results/2026-10-08T06-35-57-475Z-windows-x64.json) is retained. Only one Editor launched and quit normally; an old log was briefly visible before Unity replaced it. The reproducer now removes its exact owned log before launch and filters current-launch events. That recorder correction was syntax-checked without another Editor run.

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

Both inventories were observed on the historical capture dates, not inferred from marketing pages.
The recorded raw-capture location was `.agent/runs/TASK-6.1/artifacts/`; those artifacts are unavailable in this checkout.
The historical inventory below cannot be independently replayed from these missing files and is not a current registration claim.
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

### 5.10 Classified composition inventory, 2026-10-08

Each origin has its own identity and transport. These rows classify capabilities, not tool counts.
Assistant registration has not been recaptured in this checkout. Pipeline 0.8 registration was observed in the isolated install above; command safety and composition remain separate proofs.

| Origin | Source identity/date | Minimum Editor | Transport and execution |
| --- | --- | --- | --- |
| toolkit | Package 1.1.0; current source reviewed 2026-10-08 | Declared 2019.4; exact-version proof remains separate | Node stdio to toolkit TCP bridge; live Editor; explicit editorBatchmode game command path |
| Assistant MCP | 2.17.0-pre.1 capture 2026-08-02; versioned docs checked 2026-10-08 | Captured 6000.0.60f1 | Relay stdio with local IPC to a live Editor; batchmode capture does not make commands headless |
| CLI | Installed 1.0.0-beta.12 capture 2026-10-08 | Independent binary; launched Editor must match project | Local process; build/run/test batchmode; command/list/status/mcp target Pipeline |
| Pipeline | 0.8.0-exp.1 isolated install and 160-command catalog, 2026-10-08 | Package minimum 6000.0; exact 6000.3.9f1 proved; commands can be narrower | Live Editor authenticated loopback HTTP observed; Player and CLI MCP remain unproved |

| Capability and origin | Risk class | Composition status |
| --- | --- | --- |
| Project/console reads: toolkit project_info/read_console; Assistant Unity_GetProjectData/Unity_GetConsoleLogs; Pipeline status/console reads | Read-only | Overlap; fresh official schemas and registration still required |
| Scene/object reads: toolkit getHierarchy/find/getProperties; Assistant and Pipeline scene/object queries | Read-only | Overlap; classify actions rather than entire multi-action tools |
| Scene/object/material changes: all three Editor surfaces | Mutating | Overlap; preserve each origin's confirmation and dry-run semantics |
| Asset deletion: toolkit manage_asset delete; Assistant asset management; Pipeline delete asset | Destructive | Overlap; never present as read-only through a proxy |
| Play mode and menu execution: toolkit, Assistant, Pipeline | Mutating | Overlap; project code can execute, so read-only status is separate |
| Build/test execution: toolkit build_trigger/editor_validation; CLI build/test; Pipeline build/test | Mutating | Overlap in workflow intent; process, result, discovery, and cancel parity unproved |
| Standalone Editor/module management: CLI | Mutating; uninstall destructive | Distinct local lifecycle surface; does not establish safe project upgrade behavior |
| Generic code evaluation: Assistant Unity_RunCommand; Pipeline eval/eval_file | Policy escape | Arbitrary C# can exceed narrower tool policy; block or isolate for read-only composition |
| Registered headless command: CLI run command; toolkit game_command editorBatchmode | Mutating | Similar deployment intent, different registration contract; no automatic substitution |
| Profiler capture lifecycle and console-fused sessions: toolkit profiler_snapshot | Read-only reads; mutating save; destructive clear | Distinct from dated Assistant loaded-capture analysis; broader Pipeline comparison unproved |
| Asset graph/meta queries: toolkit unity_context query/read/summary and resolve_meta | Read-only | Distinct graph contract in dated comparison; current official equivalent unproved |
| Viewport stream and input: toolkit viewport_stream | Read-only status; mutating session/input | Candidate distinction from historical single captures; no current uniqueness claim |
| Batch execution: toolkit batch_execute | Inherits mutating/destructive children | Propagate child classifications and origin; official batching parity unproved |

Toolkit classifications come from [toolMetadata.ts](../unity-cursor-toolkit/src/mcp/toolMetadata.ts).
Official rows use the [versioned Assistant overview](https://docs.unity3d.com/Packages/com.unity.ai.assistant@2.17/manual/integration/unity-mcp-overview.html),
[Pipeline 0.4 documentation](https://docs.unity3d.com/Packages/com.unity.pipeline@0.4/manual/index.html),
and installed CLI help in the linked baseline capture. Package documentation is not an observed enabled-tool inventory.
No composition proxy or backend fallback was added. Current safety metadata and MCP execution proofs remain prerequisites for composition spikes.

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
