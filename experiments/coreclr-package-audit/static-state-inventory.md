# First-party package static-state inventory

Reviewed 2026-10-09. Scope: canonical first-party Editor and Runtime C#.
Vendored Unterm state and hook migration belong to RUG-519.
Constants, pure static methods, and computed properties hold no session state.
The table lists all first-party static fields and events. Grouped names share a lifetime.
A lock object is retained while the process runs. Replacing it can break synchronization.

| Owner | Static fields or event | Staleness harmful? | Reset or retention rule |
|---|---|---|---|
| HotReloadHandler | server, listenerThread, clientThreads, connectedClients, isServerRunning, isInitialized, stopRequested | Yes | StopServer closes every client/listener and joins tracked workers outside clientListLock, with a shared one-second deadline. It retains live worker references, logs incomplete cleanup, and blocks replacement startup on a failed join. Queues clear only after successful joins; stopped enqueue is rejected. |
| HotReloadHandler | messageQueue, queuedMessageCharacters, messageQueueOverflowed, messageQueueOverflowWarningLogged | Yes | StopServer clears under messageQueue lock. |
| HotReloadHandler | mainThreadActions, mainThreadActionsOverflowed, mainThreadActionsOverflowWarningLogged | Yes | StopServer clears under mainThreadActionsLock. |
| HotReloadHandler | shouldRequestRefresh, isRefreshInProgress, refreshCompilationPending, refreshCompilationStarted, refreshCompilationTimeoutAt | Yes | StopServer cancels pending refresh state. Do not stop the bridge at play transitions. |
| HotReloadHandler | instanceMutex | Yes | Stop and OnBeforeAssemblyReload release and close the existing process mutex. |
| HotReloadHandler | currentPort, lastSuccessfulPort, wasRunningBeforeReload, showDebugLogs | No | Preserve port and logging configuration. Process-scoped SessionState stores initial startup and active/stopped intent across code reload. Manual Stop remains stopped through reload and play; a fresh Editor starts automatically. |
| HotReloadHandler | clientListLock, mainThreadActionsLock, ALTERNATIVE_PORTS | No | Stable locks and fixed port selection list. |
| HotReloadHandler | isQuitting, reloadPrepared, lifecycleInitialized | Lifecycle guards | Asset-import workers skip bridge lifecycle initialization on Unity 2020.2+; they must not create a second listener. Native setup occurs once after code initialization on Unity 7. Reload preparation is idempotent and is cleared on initialization. Quitting is set before native cleanup and prevents later lifecycle callbacks from accessing Unity APIs. |
| MCPBridge | _handlers, _initialized, isQuitting | Yes | Managed Reset clears before reload. Initialize rebuilds after reload unless quitting. EnteredPlayMode and EnteredEditMode reset then rebuild. |
| ConsoleToCursor | entryBuffer, captureInitialized, isQuitting | Yes | InitializeCapture is idempotent. Shutdown detaches the callback before clearing under bufferLock and marks capture inactive, so late unload cannot repeat native teardown. Entered modes clear and rebind the callback: Unity 7 clears its log subscription on play exit. Resets do not log entries. |
| ConsoleToCursor | bufferLock, autoStreamEnabled | No | Stable lock and process streaming configuration. Keep the existing main-thread logMessageReceived contract. |
| ConsoleTranscriptRecorder | entries, sessionStartedAtUtc, entryCounter, trimmed | Yes | Existing Reset is called by ProfilerSessionRecorder.ResetSession under syncRoot. A new session cannot report previous transcript entries. |
| ConsoleTranscriptRecorder | syncRoot | No | Stable lock. |
| ProfilerSessionRecorder | recorders, frameTimings, latestTiming, activeCapacity, activeEnabled, recordingSuspended, initialized, isQuitting | Yes | Shutdown stops/disposes recorders, clears capacity and session data. Initialize resumes recording policy after reload. Existing play transitions stop recorders on exit and ResetSession on entry. ResetSession also clears latestTiming. |
| ProfilerSessionRecorder | sessionId, sessionStartedUtc, sessionStartedAtUtc | Yes | ResetSession assigns a new identity and start time, clears frames and transcript. |
| ProfilerSessionRecorder | profilerDriverManaged, profilerDriverOriginalEnabled, profilerDriverOriginalProfileEditor, profilerDriverOriginalDeepProfiling, profilerDriverOriginalMaxHistoryLength, profilerDriverHasProfileEditor, profilerDriverHasDeepProfiling, profilerDriverHasMaxHistoryLength | Yes while managed | Existing RestoreProfilerDriverState restores Unity settings before session shutdown. Keep the saved values until restoration succeeds. |
| ProfilerSessionRecorder | hierarchyColumnWarningLogged, profilerDriverWarningLogged | No | Process warning suppression. Retain across session resets. |
| ProfilerSessionRecorder | syncRoot | No | Stable lock. |
| EditorWindowViewportCapture | resourcesByKey, isQuitting | Yes | Existing DisposeCachedResources releases textures and render targets before reload and quitting. EnteredPlayMode and EnteredEditMode release these resources too. |
| ViewportStreamTool | sessions, running, isQuitting | Yes | Live session configuration remains across play transitions. Capture resources reset separately. Reset removes Tick and clears sessions before code reload and quitting. |
| ILPatcher | referenceAssemblies | Yes | Clear on beforeAssemblyReload and compilationFinished. Each subsequent patch rebuilds references. |
| ILPatcher | OnPatchCompleted | Yes for stale consumer delegates | Subscriber-owned event. Consumers explicitly unsubscribe on owner unload and subscribe on initialization; the consumer proof verifies exactly one current callback after each reload. Keep valid subscriptions across disabled-domain-reload play transitions; bulk clearing would break the shipped owner contract. |
| ILPatcher | cscPath, monoHostPath | No | Editor installation paths. Same Editor installation remains active across reloads. |
| DebugBridge | _cachedPort | No | Derived from immutable process arguments. |
| RuntimeCapabilities | IsMono | No | Derived from the loaded core library identity. The process runtime does not change on script reload. |
| AgentCommandRegistry | registrations | Yes for stale consumer delegates | Game-owned delegates. Register replaces a name and Unregister removes it. The consumer proof verifies owner unload removes its command and initialization registers the current version. Retain unrelated edit-mode registrations across disabled-domain-reload play transitions; consumers own their lifetime. |
| AgentCommandRunner | instance | Yes if destroyed | Existing OnDestroy clears the reference. GetOrCreate also uses Unity's destroyed-object null check. |
| AgentCommandRunner | nextRunNumber | No | Monotonic run-ID suffix. Retain to avoid reusing IDs while consumers poll. |
| TestRunnerAdapter | _api, _callbacks, _initialized, _progress, _observedHolder, _seenRegisteredActive | Yes | Unload saves the owned job then Detach unregisters callbacks, destroys the API object, removes update/quitting hooks and clears these fields. Initialize creates one new API/callback pair. Handler recreation rebinds the progress sink; native stopped-work proof cannot be inherited from the previous holder. |
| TestRunnerAdapter | _cancel, _isRunning, _getRunner, _holder, _probeSupported, _probeFailed | Yes | Detach clears reflected framework contracts and support state; Initialize rebinds the exact supported framework and clears probe failure. |
| TestRunnerAdapter | _job, _foreignActive | Yes if ownership is lost | Retain bounded correlated SessionState across reload and Play Mode so the same run can complete or be cancelled. Initialize checks saved project/PID ownership; source-compilation unload marks active owned work interrupted and requests native cancellation. Terminal snapshots remain readable by their runId; a later request cannot reuse that ID. |
| TestRunnerAdapter | _stateKey, _project, _version, _pid, _home, _editorDirectory | No | Exact process/project identity and privacy context are recomputed on Initialize. A live Editor does not change installation, PID or project. |
| TestRunnerAdapter | _lastHeartbeat | No | Monotonic process-time cursor; retained across jobs to bound activity to once per second. |
| TestRunnerAdapter | _quitting | Lifecycle guard | Quit sets this before Detach. Later unload/initialization callbacks cannot access a destroyed native Editor. |

ProfilerSnapshotSettings.Current reads Unity's serialized ScriptableSingleton.
EditorValidationController keeps its compile-request state in SessionState,
rather than static fields. Its existing ResetRequestState owns that persisted state.
The remaining first-party classes contain constants or stateless methods only.

## Evidence and limits

[Unity's current upgrade guide](https://discussions.unity.com/t/path-to-coreclr-2026-upgrade-guide/1714279)
documents explicit static cleanup and the safer assembly enumeration API.
[CurrentAssemblies.GetLoadedAssemblies](https://docs.unity3d.com/6000.5/Documentation/ScriptReference/Assemblies.CurrentAssemblies.GetLoadedAssemblies.html)
returns IReadOnlyList of Assembly. The helper retains AppDomain enumeration on older Editors.
The issue's 6000.8 assumption does not identify the current CoreCLR release.
[Unity's October update](https://discussions.unity.com/t/coreclr-scripting-and-net-update-october-2026/1738338)
identifies Unity 7.0 alpha as the CoreCLR Editor.

Unity 7 uses the observed OnCodeUnloading and OnCodeInitializing attributes;
AssemblyReloadEvents remain only in the older-Editor branch for the six original
lifecycle owners and the optional TestRunnerAdapter. All seven attribute owners
are partial classes, as required by Unity compiler UAC0031.
Generated lifecycle registration forces static constructors before native objects
are ready, so their Unity 7 constructors contain no native initialization.
EditorApplication.quitting performs native cleanup before teardown; later unload
callbacks skip that work or perform only managed resets.

The [production observation](results/unity7-package-lifecycle-2026-10-08T05-27-37-571Z/observation.json)
passed on 7000.0.0a7, revision 581996e1a8f7, Windows x64/CoreCLR.
Two source-only recompiles kept the package binary MVID and TCP port, with new
handlers, empty prior console/timing state, and destroyed cached capture objects.
Play entry/exit retained the viewport session and delivered further frames,
restarted profiler recorders, and rebound one console callback.
Manual Stop remained stopped through a third recompile and another play cycle.
A deliberately stalled fixture worker produced visible incomplete cleanup,
remained tracked, and blocked replacement; normal shutdown later had no workers.
The [old console behavior](results/unity7-console-reset-baseline-2026-10-08T05-29-37-263Z/observation.json)
failed on play exit with zero marker callbacks after only the rebind was reverted.

The alpha recreated coordinator static state even though its source and the
package binary were unchanged. This proves the selected observed reload flow,
not selective-assembly retention. Frame delivery does not prove correct pixels;
the initial Unity 7 fixture used the removed Built-in Render Pipeline. The
[URP smoke](results/unity7-urp-smoke-2026-10-08T05-58-37-071Z/observation.json)
now passes with visible contrast using the installed Editor template and URP
17.7.0, without capture-code changes. The final Unity 6.3 sample
smoke passed the legacy reset/restart and game/viewport checks; that earlier smoke simulated reload callbacks.

The [actual Mono recompilation proof](results/unity6-package-lifecycle-2026-10-08T06-51-17-382Z/observation.json) now passes on 6000.3.9f1/mscorlib. It observes two real asset-import workers, three source recompiles, stable package MVID/port, handler and session resets, play transitions, persistent manual Stop, closed-port checks, failed-join refusal, and normal exit with stopped workers.
The [old-code failure](results/unity6-package-lifecycle-2026-10-08T06-48-05-022Z/observation.json) records a different child Unity process listening on the bridge port after the owning Editor stopped. Skipping bridge initialization in asset-import workers removes this failure. The guard uses the API present in [Unity's 2020.2 source](https://github.com/Unity-Technologies/UnityCsReference/blob/2020.2/Modules/AssetDatabase/Editor/ScriptBindings/AssetDatabase.bindings.cs), behind the matching version define.
The [Unity 7 regression proof](results/unity7-package-lifecycle-2026-10-08T06-53-39-341Z/observation.json) also passes with the guard. These proofs still use a selected free port because the host excludes the default range. The [consumer lifetime proof](../consumer-lifecycle-proof/evidence/2026-10-08T08-46-00-868Z/observation.json) also passes on the exact Unity 7 Editor: owner unload removes command and patch delegates, and each replacement version receives exactly one current callback. Its old-code control retains terminal handler targets; the fixed runner releases those targets while keeping their results readable. Selective-assembly static retention remains unverified; both observed source reloads reconstructed static state.

## RUG-518 acceptance evidence

The inventory covers first-party package fields/events, including the optional TestRunnerAdapter; locks, process configuration and deliberately retained owned runs have explicit retention rules above. Both package copies contain the same reset/lifecycle implementation. Vendored Unterm ownership remains the separate RUG-519 scope.

The [existing sample owner test](../../CursorUnityTool/Assets/Editor/UnityCursorToolkitInternalSmoke.cs), ValidateRuntimeAndStateReset, seeds retained state and invokes the entered-mode callbacks to check a rebuilt handler table and an empty console buffer, then checks profiler identity/timing reset. The linked [legacy smoke result](results/2026-10-08-6000.3.9f1-lifecycle-smoke.json) passes those simulated owner checks. ProductionLifecycleProbe.CheckReset additionally asserts a new handler instance, no prior console marker, exactly one current console callback and a new profiler session; its reload checks require an empty timing queue. The linked actual Mono and CoreCLR observations each contain three network verifications and four session-reset verifications across source reload and disabled-domain-reload play entry/exit, then normal exit with stopped workers.

Consumer delegates use explicit owner unregister/unsubscribe rather than a package-wide purge. This preserves the proved unrelated registration across Play Mode. Compilation callbacks suspend/resume profiler capture; reload and entered play/edit hooks define new current sessions. Saved profiler snapshots remain addressable by ID and are not current-session state.

Unity 2019.4.40f1 remains configured but unrun; no legacy runtime proof is claimed. Selective-assembly retention is an evidence limit, not an additional RUG-518 acceptance condition.
