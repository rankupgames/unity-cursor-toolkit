# CoreCLR package API inventory

Frozen: 2026-10-07, package source at [`f1a4c2ab5d972ac6288a572ac1c907671e1c3bb7`](https://github.com/rankupgames/unity-cursor-toolkit/commit/f1a4c2ab5d972ac6288a572ac1c907671e1c3bb7) after PR #84 integration. Source task: [GitHub #26](https://github.com/rankupgames/unity-cursor-toolkit/issues/26).

Reference Editor: **6000.3.9f1**, revision **7a9955a4f2fa**, from `CursorUnityTool/ProjectSettings/ProjectVersion.txt`.
The frozen baseline is a source audit; no CoreCLR Editor was run at that freeze. Follow-up runtime observations are recorded below and do not establish general Unity 7 toolkit support.

## Scope and counts

The audit covers all C# source files under these two package roots, including `Editor/ThirdParty/Unity-Unterm`:

- Root: `Packages/com.rankupgames.unity-cursor-toolkit/`
- Sample: `CursorUnityTool/Packages/com.rankupgames.unity-cursor-toolkit/`

Each row below identifies a file relative to both roots. The two line columns identify each copy independently.
Both package copies are byte-identical at this freeze. Counts include subscriptions and unsubscriptions as separate sites.
The scan includes source in inactive preprocessor branches. It does not inspect compiled DLLs or user assemblies.

| Copy | Owner | Exact-term raw matches | Additional assembly location reads | Comment matches | Executable sites | Files with executable sites |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Root | First-party | 12 | 1 | 0 | 13 | 6 |
| Root | Vendored Unterm | 16 | 2 | 2 | 16 | 8 |
| Sample | First-party | 12 | 1 | 0 | 13 | 6 |
| Sample | Vendored Unterm | 16 | 2 | 2 | 16 | 8 |
| Both | Total | 56 | 6 | 4 | 58 | 28 |

Exact grep terms: `DomainUnload`, `AppDomain.`, `Assembly.Load`, `Assembly.Location`, `ManagedDebugger`, `AssemblyReloadEvents`.
Both copies have zero matches for `DomainUnload` and `ManagedDebugger`.
The additional reads use `asm.Location` or `ns.Location`, which the exact `Assembly.Location` term cannot match.

## Risk and replacement keys

- **Deprecated**: Unity discourages the API because reload can leave assemblies unloading. This does not imply removal from .NET. [Enumeration reference][enumeration]
- **Breaks**: the upgrade guide identifies incompatible assembly-loading overloads. The risk concerns the future CoreCLR Editor, not the reference Mono Editor. [Upgrade guide][upgrade]
- **Behavior change**: assembly paths or reload lifecycle assumptions change. Reload-event risks are an inference from the new lifecycle, pending event-order observation. [Upgrade guide][upgrade]

The replacement column uses these documented keys:

| Key | Documented replacement | Evidence and limits |
| --- | --- | --- |
| E | `UnityEngine.Assemblies.CurrentAssemblies.GetLoadedAssemblies()` | Unity 6000.5 documents the Unity-managed assembly list. [Reference][enumeration] |
| B | `UnityEngine.Assemblies.CurrentAssemblies.LoadFromBytes(byte[])` | Unity 6000.5 documents loading bytes with reload support and duplicate assembly-name restrictions. [Reference][bytes] |
| P | `Assembly.GetLoadedAssemblyPath()` | Unity 6000.5 documents this `UnityEngine` extension in `UnityEngine.CoreModule`. Its result can be null. [Reference][path] |
| L | `[BeforeCodeUnloading]` lifecycle callback | The upgrade guide documents this cleanup hook. It does not promise identical `AssemblyReloadEvents` timing. Observe the selected Editor before migrating. [Guide][upgrade] |

The replacement keys describe APIs, not completed fixes. Every site below records its applicable key.
For IL patching and dynamic execution, a replacement load API alone does not prove feature compatibility.
The planned runtime gates and capability errors remain separate work in [#29](https://github.com/rankupgames/unity-cursor-toolkit/issues/29) and [#32](https://github.com/rankupgames/unity-cursor-toolkit/issues/32).

## First-party sites

13 sites in 6 files per copy.

| File relative to package root | Root line | Sample line | Matched API or expression | Risk class | Replacement | Owner behavior |
| --- | ---: | ---: | --- | --- | --- | --- |
| `Editor/HotReload/ILPatcher.cs` | 266 | 266 | `AppDomain.CurrentDomain.GetAssemblies()` | Deprecated | E | Build compiler references. |
| `Editor/HotReload/ILPatcher.cs` | 270 | 270 | `asm.Location` (`Assembly.Location`) | Behavior change | P | An empty path silently removes a compiler reference. |
| `Editor/HotReload/ILPatcher.cs` | 381 | 381 | `Assembly.Load(dllBytes)` (`byte[]`) | Breaks | B | Load IL patches. Runtime gating still required. |
| `Editor/HotReload/ILPatcher.cs` | 428 | 428 | `AppDomain.CurrentDomain.GetAssemblies()` | Deprecated | E | Find the original patched type. |
| `Editor/HotReload/ILPatcher.cs` | 523 | 523 | `AppDomain.CurrentDomain.GetAssemblies()` | Deprecated | E | Invoke static hot-reload callbacks. |
| `Editor/HotReloadHandler.cs` | 114 | 114 | `AssemblyReloadEvents.beforeAssemblyReload +=` | Behavior change | L | Stop the bridge server and release its mutex. |
| `Editor/MCP/EditorValidationTool.cs` | 608 | 608 | `AppDomain.CurrentDomain.GetAssemblies()` | Deprecated | E | Find editor validation types. |
| `Editor/MCP/EditorWindowViewportCapture.cs` | 29 | 29 | `AssemblyReloadEvents.beforeAssemblyReload +=` | Behavior change | L | Dispose cached capture textures and render targets. |
| `Editor/MCP/EditorWindowViewportCapture.cs` | 432 | 432 | `AppDomain.CurrentDomain.GetAssemblies()` | Deprecated | E | Resolve a custom editor window type. |
| `Editor/MCP/MCPBridge.cs` | 44 | 44 | `AppDomain.CurrentDomain.GetAssemblies()` | Deprecated | E | Discover MCP handlers. |
| `Editor/ProfilerSnapshot.cs` | 159 | 159 | `AssemblyReloadEvents.beforeAssemblyReload -=` | Behavior change | L | Remove a prior shutdown subscription. |
| `Editor/ProfilerSnapshot.cs` | 160 | 160 | `AssemblyReloadEvents.beforeAssemblyReload +=` | Behavior change | L | Stop recorders and restore profiler state. |
| `Editor/ProfilerSnapshot.cs` | 402 | 402 | `AssemblyReloadEvents.beforeAssemblyReload -=` | Behavior change | L | Remove the shutdown subscription during cleanup. |

## Vendored Unterm sites

16 executable sites in 8 files per copy. All listed files are under `Editor/ThirdParty/Unity-Unterm/` in both package roots.
PR #84 removed the external editor registration's assembly location read; it now resolves the containing package manifest from the assembly definition.

| File relative to package root | Root line | Sample line | Matched API or expression | Risk class | Replacement | Owner behavior |
| --- | ---: | ---: | --- | --- | --- | --- |
| `Editor/ThirdParty/Unity-Unterm/UntermAgentWindow.cs` | 194 | 194 | `AssemblyReloadEvents.beforeAssemblyReload +=` | Behavior change | L | Preserve the native agent view across reload. |
| `Editor/ThirdParty/Unity-Unterm/UntermAgentWindow.cs` | 266 | 266 | `AssemblyReloadEvents.beforeAssemblyReload -=` | Behavior change | L | Remove the view preservation subscription. |
| `Editor/ThirdParty/Unity-Unterm/UntermCodeEditorWindow.cs` | 461 | 461 | `AssemblyReloadEvents.beforeAssemblyReload +=` | Behavior change | L | Preserve native editor views and edits across reload. |
| `Editor/ThirdParty/Unity-Unterm/UntermCodeEditorWindow.cs` | 521 | 521 | `AssemblyReloadEvents.beforeAssemblyReload -=` | Behavior change | L | Remove the view preservation subscription. |
| `Editor/ThirdParty/Unity-Unterm/UntermCompletionWorker.cs` | 40 | 40 | `AssemblyReloadEvents.beforeAssemblyReload +=` | Behavior change | L | Stop the completion thread and dispose its signal. |
| `Editor/ThirdParty/Unity-Unterm/UntermExecuteCodeTools.cs` | 75 | 75 | `System.Reflection.Assembly.Load(ms.ToArray())` (`byte[]`) | Breaks | B | Load compiled snippets. Runtime gating still required. |
| `Editor/ThirdParty/Unity-Unterm/UntermExecuteCodeTools.cs` | 105 | 105 | `ty.Assembly.Location` | Behavior change | P | An empty path fails metadata creation and omits a reference after logging. |
| `Editor/ThirdParty/Unity-Unterm/UntermExecuteCodeTools.cs` | 117 | 117 | `AppDomain.CurrentDomain.GetAssemblies()` | Deprecated | E | Find the `netstandard` assembly. |
| `Editor/ThirdParty/Unity-Unterm/UntermExecuteCodeTools.cs` | 119 | 119 | `ns.Location` (`Assembly.Location`) | Behavior change | P | The empty-path guard skips the `netstandard` reference. |
| `Editor/ThirdParty/Unity-Unterm/UntermExecuteCodeTools.cs` | 120 | 120 | `ns.Location` (`Assembly.Location`) | Behavior change | P | Read the `netstandard` metadata path after the guard. |
| `Editor/ThirdParty/Unity-Unterm/UntermMcpServer.cs` | 861 | 861 | `AppDomain.CurrentDomain.GetAssemblies()` | Deprecated | E | Resolve component types for MCP tools. |
| `Editor/ThirdParty/Unity-Unterm/UntermSignatureWorker.cs` | 36 | 36 | `AssemblyReloadEvents.beforeAssemblyReload +=` | Behavior change | L | Stop the signature thread and dispose its signal. |
| `Editor/ThirdParty/Unity-Unterm/UntermToolGroup.cs` | 102 | 102 | `AppDomain.CurrentDomain.GetAssemblies()` | Deprecated | E | Resolve component types. |
| `Editor/ThirdParty/Unity-Unterm/UntermToolGroup.cs` | 119 | 119 | `AppDomain.CurrentDomain.GetAssemblies()` | Deprecated | E | Resolve arbitrary types. |
| `Editor/ThirdParty/Unity-Unterm/UntermWindow.cs` | 277 | 277 | `AssemblyReloadEvents.beforeAssemblyReload +=` | Behavior change | L | Preserve native terminal state across reload. |
| `Editor/ThirdParty/Unity-Unterm/UntermWindow.cs` | 292 | 292 | `AssemblyReloadEvents.beforeAssemblyReload -=` | Behavior change | L | Remove the terminal preservation subscription. |

## Raw matches excluded from executable counts

| File relative to package root | Root line | Sample line | Match | Reason |
| --- | ---: | ---: | --- | --- |
| `Editor/ThirdParty/Unity-Unterm/UntermExecuteCodeTools.cs` | 19 | 19 | `Assembly.Load` | XML comment describing the call at line 75. No separate execution site. |
| `Editor/ThirdParty/Unity-Unterm/UntermExternalCodeEditor.cs` | 72 | 72 | `Assembly.Location` | Comment describing the eliminated assembly path read. No execution site. |
| `Editor/ProfilerSnapshot.cs` | 30 | 30 | `FilePathAttribute.Location.ProjectFolder` | Supplemental `.Location` match refers to a Unity attribute enum, not an assembly path. |

## Repeat the scan

Run these commands from the repository root. They require ripgrep and include ignored C# source.
The first command prints the exact-term matches with repository paths and line numbers.

```sh
LC_ALL=C rg -n --no-heading --color never --hidden --no-ignore -g '*.cs' -F \
  -e 'DomainUnload' -e 'AppDomain.' -e 'Assembly.Load' \
  -e 'Assembly.Location' -e 'ManagedDebugger' -e 'AssemblyReloadEvents' \
  Packages/com.rankupgames.unity-cursor-toolkit \
  CursorUnityTool/Packages/com.rankupgames.unity-cursor-toolkit | LC_ALL=C sort
```

Run the supplemental command to find assembly-instance property reads that the exact terms miss.

```sh
LC_ALL=C rg -n --no-heading --color never --hidden --no-ignore -g '*.cs' \
  -e '\.Location\b' \
  Packages/com.rankupgames.unity-cursor-toolkit \
  CursorUnityTool/Packages/com.rankupgames.unity-cursor-toolkit | LC_ALL=C sort
```

Read each matching method and its callers before classifying a site.
Exclude comments and non-assembly properties from executable counts, as shown above.
Record each new site with both copy paths, line numbers, API, risk class, and cited replacement.
Recheck the official sources and API availability for the selected Editor.
Update the freeze date, reference Editor, tables, and counts together.
Do not infer runtime support from matching package copies or documented API availability.

Freeze verification: the exact-term command returned 56 lines, including four comment matches. The supplemental command returned 12 lines, including two comment matches and two non-assembly enum matches.
The tables match all 58 executable sites across both copies. `diff -rq` returned no package differences after the sample sync.

## Source references checked on 2026-10-07

- [Unity upgrade guide][upgrade], official living article first published 2026-03-26. It mixes older 6.8 targets with a newer Unity 7 alpha note.
- [Unity 6000.5 enumeration reference][enumeration].
- [Unity 6000.5 byte-loading reference][bytes]. For file loading, see [the path-loading reference][load-path].
- [Unity 6000.5 loaded assembly path reference][path]. The guide's older 6.8 availability statement differs from this versioned documentation.
- [Unity 6000.7 CoreCLR manual][coreclr]. It describes an experimental desktop Player backend and a Mono Editor.

Versioned API documentation is evidence of the documented interface, not proof that the toolkit compiles against it.
No runtime gate is selected by this inventory. Confirm availability and lifecycle behavior on the actual transition Editor before implementation.

[upgrade]: https://discussions.unity.com/t/path-to-coreclr-2026-upgrade-guide/1714279
[enumeration]: https://docs.unity3d.com/6000.5/Documentation/ScriptReference/Assemblies.CurrentAssemblies.GetLoadedAssemblies.html
[bytes]: https://docs.unity3d.com/6000.5/Documentation/ScriptReference/Assemblies.CurrentAssemblies.LoadFromBytes.html
[load-path]: https://docs.unity3d.com/6000.5/Documentation/ScriptReference/Assemblies.CurrentAssemblies.LoadFromPath.html
[path]: https://docs.unity.com/en-us/engine/6000.5/script-reference/unityengine/assemblyextension/getloadedassemblypath
[coreclr]: https://docs.unity.com/en-us/engine/6000.7/manual/programming-environment/scripting-backends/coreclr

## Follow-up lifecycle sites, 2026-10-08

The table above preserves the original frozen source inventory. Current canonical
sites after RUG-517/518 are below; sample synchronization is validated separately.
Unity 7 uses the exact observed Unity.Scripting.LifecycleManagement attributes.
The guide\'s earlier BeforeCodeUnloading name is absent in the installed 7000.0.0a7
metadata. Older Editors keep AssemblyReloadEvents behind the opposite guard.

| Owner file | Older-Editor before/after lines | Unity 7 unload/initialize attribute lines |
| --- | --- | --- |
| Editor/HotReloadHandler.cs | 136 / 137 | 505 / 535 |
| Editor/ConsoleToCursor.cs | 80 / 81 | 102 / 86 |
| Editor/ProfilerSnapshot.cs | 175?176, 429 / 151 | 418 / 156 |
| Editor/MCP/MCPBridge.cs | 37 / 38 | 45 / 72 |
| Editor/MCP/EditorWindowViewportCapture.cs | 42 / none | 420 / 36 |
| Editor/MCP/ViewportStreamTool.cs | 42 / none | 55 / 36 |

The standalone [ordered observation](unity7-lifecycle-2026-10-08T04-57-52-040Z/observation.json)
and [production package observation](unity7-package-lifecycle-2026-10-08T05-27-37-571Z/observation.json)
record the actual callback sequence and guarded cleanup on Windows x64.
The production probe changes only a separate Assets handler; its package MVID
remains unchanged over two recompiles. Recreated coordinator static state is
recorded, not treated as proof of selective assembly retention. Normal shutdown,
manual Stop, console/profiler reset and capture disposal passed. Viewport frame
delivery passed; correct pixel content remains outside this proof.
