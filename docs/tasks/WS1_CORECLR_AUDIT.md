# WS1 — CoreCLR Package Audit + Fixes

Status: **Ready to start (P0)**

Last reviewed: 2026-08-13

Support impact: preparation only; CoreCLR and Unity 7 are not yet validated.

Goal: the Unity package (and vendored Unterm) runs clean on Unity 6.8 CoreCLR, day one. Highest urgency, lowest effort.

Known breaking sites (from 2026-07 grep audit):

- `AppDomain.CurrentDomain.GetAssemblies()` — `Editor/MCP/EditorValidationTool.cs:608`, `Editor/MCP/EditorWindowViewportCapture.cs:312`, `Editor/MCP/MCPBridge.cs:44`, `Editor/HotReload/ILPatcher.cs:266,428,523`
- `Assembly.Load(byte[])` — `Editor/HotReload/ILPatcher.cs:381`
- `AssemblyReloadEvents` semantics under partial reload — `Editor/HotReloadHandler.cs:114`, `Editor/ProfilerSnapshot.cs:159-160,402`, `Editor/MCP/EditorWindowViewportCapture.cs:27`
- Vendored Unterm — `UntermExecuteCodeTools.cs`, `UntermMcpServer.cs`, `UntermToolGroup.cs`, `UntermExternalCodeEditor.cs`

Both package copies must stay in sync: `Packages/com.rankupgames.unity-cursor-toolkit` and `CursorUnityTool/Packages/com.rankupgames.unity-cursor-toolkit`.

## Tasks

- [ ] 1. **Re-run and freeze the inventory.** Grep the full breaking-API list (`DomainUnload`, `AppDomain.`, `Assembly.Load`, `Assembly.Location`, `ManagedDebugger`, `AssemblyReloadEvents`) across both package copies incl. ThirdParty; save the site list to `experiments/coreclr-package-audit/results/inventory.md`. (Half day; also seeds the WS2 rule set.)
- [ ] 2. **Add version/capability gate.** Version define (`UNITY_6000_8_OR_NEWER` via `versionDefines` in the asmdef) plus a small `RuntimeCapabilities` helper (isCoreCLR, hasDomainReload). Expose through the connection handshake so the extension side can gate features too. (Half day. Unblocks WS2/WS3/WS4/WS5.)
- [ ] 3. **Assembly enumeration wrapper.** One helper (`AssemblyEnumerator.GetLoaded()`) that uses `UnityEngine.Assemblies.CurrentAssemblies.GetLoadedAssemblies()` on 6.8+ and `AppDomain` otherwise; replace the 6 first-party call sites. (Half day.)
- [ ] 4. **Gate the IL patcher.** On CoreCLR, disable `Assembly.Load(byte[])` patching path with a clear capability error ("native reload active; IL patching not required on 6.8+") — fail loud, not silent. Extension status bar reflects the mode. (Half day.)
- [ ] 5. **Reload-lifecycle audit.** Verify what `AssemblyReloadEvents` fires under 6.8 partial reload; migrate `HotReloadHandler`/`ProfilerSnapshot`/`EditorWindowViewportCapture` cleanup to the surviving hooks (`[BeforeCodeUnloading]` on 6.8+ behind the version gate). (1 day; needs task 8's editor install.)
- [ ] 6. **Statics correctness pass.** Inventory package statics (connection state, ring buffers, caches) for no-domain-reload survival; add explicit reset bound to reload/play-mode hooks where staleness matters. (1 day.)
- [ ] 7. **Unterm vendor fixes.** Patch the 4 vendored files with the same wrapper/gates; upstream the diff to the Unity-Unterm repo so the next vendor refresh doesn't regress. (Half day.)
- [ ] 8. **Smoke test on an eligible CoreCLR Editor.** Select an available CoreCLR preview or release, record its exact version and platform, then run connect/console/MCP/play-mode/screenshot flows. Save pass/fail evidence in `experiments/coreclr-package-audit/results/`. (1 day including install.)
- [ ] 9. **Release gate.** Sync both package copies, CHANGELOG, and Third Party Notices if Unterm changed. Advertise only the exact Editor and platform matrix that passed the readiness gates. (Half day.)

## Done when

Package connects and passes the task-8 smoke matrix on the recorded CoreCLR
Editor with zero unsupported-API warnings, and the recorded legacy matrix is
unchanged.
