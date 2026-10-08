# First-party package static-state inventory

Reviewed 2026-10-08. Scope: canonical first-party Editor and Runtime C#.
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
| HotReloadHandler | isQuitting, reloadPrepared, lifecycleInitialized | Lifecycle guards | Native setup occurs once after code initialization on Unity 7. Reload preparation is idempotent and is cleared on initialization. Quitting is set before native cleanup and prevents later lifecycle callbacks from accessing Unity APIs. |
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
| ILPatcher | OnPatchCompleted | Potentially | Subscriber-owned event. No package subscriber exists. Removing consumer subscriptions without a re-registration contract would break the public API. CoreCLR consumer lifecycle remains unverified. |
| ILPatcher | cscPath, monoHostPath | No | Editor installation paths. Same Editor installation remains active across reloads. |
| DebugBridge | _cachedPort | No | Derived from immutable process arguments. |
| RuntimeCapabilities | IsMono | No | Derived from the loaded core library identity. The process runtime does not change on script reload. |
| AgentCommandRegistry | registrations | Potentially | Game-owned delegates. Existing Register replaces a name and Unregister removes it. Consumers must unregister stale handlers. Do not bulk-clear registrations at play transitions, because shipped callers can register in edit mode with domain reload disabled. CoreCLR code-unload reset/re-registration remains blocked on lifecycle evidence. |
| AgentCommandRunner | instance | Yes if destroyed | Existing OnDestroy clears the reference. GetOrCreate also uses Unity's destroyed-object null check. |
| AgentCommandRunner | nextRunNumber | No | Monotonic run-ID suffix. Retain to avoid reusing IDs while consumers poll. |

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
AssemblyReloadEvents remain only in the older-Editor branch for these six owners.
All six attribute owners are partial classes, as required by Unity compiler UAC0031.
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
the separate Unity 7 contrast smoke is still failing. The final Unity 6.3 sample
smoke passed the legacy reset/restart and game/viewport checks; it simulates the
reload callbacks. Consumer-owned ILPatcher/AgentCommandRegistry lifetimes and
actual Mono recompilation still need separate validation.
