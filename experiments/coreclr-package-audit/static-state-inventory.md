# First-party package static-state inventory

Reviewed 2026-10-08. Scope: canonical first-party Editor and Runtime C#.
Vendored Unterm state and hook migration belong to RUG-519.
Constants, pure static methods, and computed properties hold no session state.
The table lists all first-party static fields and events. Grouped names share a lifetime.
A lock object is retained while the process runs. Replacing it can break synchronization.

| Owner | Static fields or event | Staleness harmful? | Reset or retention rule |
|---|---|---|---|
| HotReloadHandler | server, listenerThread, connectedClients, isServerRunning, isInitialized | Yes | Existing StopServer closes clients/listener, joins listener thread, and clears state. beforeAssemblyReload and quitting call the shutdown path. afterAssemblyReload restarts only a previously active bridge. Thread exit still needs CoreCLR observation. |
| HotReloadHandler | messageQueue, queuedMessageCharacters, messageQueueOverflowed, messageQueueOverflowWarningLogged | Yes | StopServer clears under messageQueue lock. |
| HotReloadHandler | mainThreadActions, mainThreadActionsOverflowed, mainThreadActionsOverflowWarningLogged | Yes | StopServer clears under mainThreadActionsLock. |
| HotReloadHandler | shouldRequestRefresh, isRefreshInProgress, refreshCompilationPending, refreshCompilationStarted, refreshCompilationTimeoutAt | Yes | StopServer cancels pending refresh state. Do not stop the bridge at play transitions. |
| HotReloadHandler | instanceMutex | Yes | Stop and OnBeforeAssemblyReload release and close the existing process mutex. |
| HotReloadHandler | currentPort, lastSuccessfulPort, wasRunningBeforeReload, showDebugLogs | No | Process configuration and restart intent. Preserve EditorPrefs and port state. |
| HotReloadHandler | clientListLock, mainThreadActionsLock, ALTERNATIVE_PORTS | No | Stable locks and fixed port selection list. |
| MCPBridge | _handlers, _initialized | Yes | Reset clears before reload. Initialize rebuilds after reload. EnteredPlayMode and EnteredEditMode reset then rebuild. |
| ConsoleToCursor | entryBuffer | Yes | ResetBuffer clears under bufferLock. InitializeCapture starts an empty capture. EnteredPlayMode and EnteredEditMode clear. Shutdown detaches the log callback before clearing. Resets do not log a new entry. |
| ConsoleToCursor | bufferLock, autoStreamEnabled | No | Stable lock and process streaming configuration. Keep the existing main-thread logMessageReceived contract. |
| ConsoleTranscriptRecorder | entries, sessionStartedAtUtc, entryCounter, trimmed | Yes | Existing Reset is called by ProfilerSessionRecorder.ResetSession under syncRoot. A new session cannot report previous transcript entries. |
| ConsoleTranscriptRecorder | syncRoot | No | Stable lock. |
| ProfilerSessionRecorder | recorders, frameTimings, latestTiming, activeCapacity, activeEnabled, recordingSuspended | Yes | Shutdown stops/disposes recorders, clears capacity and session data. Initialize resumes recording policy after reload. Existing play transitions stop recorders on exit and ResetSession on entry. ResetSession also clears latestTiming. |
| ProfilerSessionRecorder | sessionId, sessionStartedUtc, sessionStartedAtUtc | Yes | ResetSession assigns a new identity and start time, clears frames and transcript. |
| ProfilerSessionRecorder | profilerDriverManaged, profilerDriverOriginalEnabled, profilerDriverOriginalProfileEditor, profilerDriverOriginalDeepProfiling, profilerDriverOriginalMaxHistoryLength, profilerDriverHasProfileEditor, profilerDriverHasDeepProfiling, profilerDriverHasMaxHistoryLength | Yes while managed | Existing RestoreProfilerDriverState restores Unity settings before session shutdown. Keep the saved values until restoration succeeds. |
| ProfilerSessionRecorder | hierarchyColumnWarningLogged, profilerDriverWarningLogged | No | Process warning suppression. Retain across session resets. |
| ProfilerSessionRecorder | syncRoot | No | Stable lock. |
| EditorWindowViewportCapture | resourcesByKey | Yes | Existing DisposeCachedResources releases textures and render targets before reload and quitting. EnteredPlayMode and EnteredEditMode release these resources too. |
| ViewportStreamTool | sessions, running | Yes | Live session configuration remains across play transitions. Capture resources reset separately. Reset removes Tick and clears sessions before code reload and quitting. |
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

The changes retain AssemblyReloadEvents. RUG-517 requires an observed CoreCLR
reload sequence before selecting new hooks. No CoreCLR Editor run has occurred.
Simulating the existing callbacks proves reset behavior, not Unity 7 callback delivery.
RUG-518 remains incomplete until CoreCLR delivery and consumer-owned state are verified.
