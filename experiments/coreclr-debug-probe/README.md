Private RUG-526 CoreCLR debugger experiment
==========================================

This directory ships no CoreCLR debugger, adapter, command, or configuration. A successful experiment grants no permission to ship one. It tests arithmetic source code in an agent-owned empty Unity project, without the toolkit package, graphics, or a render pipeline.

The license and support gate was checked on 2026-10-08 before attachment:

- [Pinned netcoredbg MIT license](https://github.com/Samsung/netcoredbg/blob/9744e1f051866215611b8440c638042aa2aa2f72/LICENSE): "in the Software without restriction". The license permits private use and requires retention of copyright and permission notices. The downloaded archive contains no license file; retain the pinned notice beside it. This experiment does not redistribute the binary. Source third-party notices were also inspected and retained locally; the Windows binary includes Roslyn and dbgshim components.
- [Unity's October 5 CoreCLR update](https://discussions.unity.com/t/coreclr-scripting-and-net-update-october-2026/1738338): "we do not recommend this for production use". It identifies the Unity 7 alpha as the first CoreCLR Editor and invites compatibility testing. This is an alpha compatibility experiment.
- [Unity's CoreCLR upgrade guide](https://discussions.unity.com/t/path-to-coreclr-2026-upgrade-guide/1714279): "use the System.Diagnostics.Debugger API instead". UnityEditor.Scripting.ManagedDebugger is unsupported under CoreCLR. Neither this guide nor the current update promises support for netcoredbg; this experiment must establish its compatibility.
- [netcoredbg's primary README](https://github.com/Samsung/netcoredbg/tree/9744e1f051866215611b8440c638042aa2aa2f72) documents CoreCLR, DAP, Windows x64, PID attachment, and the vscode interpreter. Its [pinned DAP implementation](https://github.com/Samsung/netcoredbg/blob/9744e1f051866215611b8440c638042aa2aa2f72/src/protocols/vscodeprotocol.cpp) confirms processId attachment and terminateDebuggee:false detachment. This is technical scope evidence, not a Unity support commitment.

Use netcoredbg release 3.2.0-1092, published 2026-06-25, source commit 9744e1f051866215611b8440c638042aa2aa2f72. Download only [the official win64 archive](https://github.com/Samsung/netcoredbg/releases/download/3.2.0-1092/netcoredbg-win64.zip). The [official release API](https://api.github.com/repos/Samsung/netcoredbg/releases/tags/3.2.0-1092) records 3,524,161 bytes and SHA-256 3c410a45fa502415203a94fcb88654af65bf8e3dac158a5527a722e7a6b9274a. Verify before extraction or execution. The inspected binary reports version 3.2.0-1 (9744e1f, Release), build date June 24 2026, Windows x64; the asset tag and binary version use different build suffixes.

Pass an existing verified download directory containing netcoredbg-win64.zip, LICENSE, and unpacked/netcoredbg/netcoredbg.exe. No download or machine path is built into the runner:

    node experiments/coreclr-debug-probe/run-debug-probe.js --unity <Unity.exe> --version 7000.0.0a7 --debugger-root <verified-directory>

The eligible installation is Unity 7000.0.0a7, revision 581996e1a8f7, already installed through Unity Launcher. The first machine runs Windows 10 Enterprise 10.0.19045, x64, Intel i7-9700K. The installed windowsstandalonesupport contains win64_player_development_coreclr. Actual target core library, runtime version, Unity version, process architecture, and optimization mode are recorded before attachment; a mismatch stops that attempt.

The runner creates an empty manifest and ProjectVersion file in a disposable project. It compiles the Editor and player sources in one assembly; Editor source is wrapped with UNITY_EDITOR. Commands are saved in observation.json with stable path placeholders:

    Unity.exe -batchmode -nographics -debugCodeOptimization -projectPath <disposable-project> -executeMethod UCTDebugProbe.EditorProbe.Run -logFile <editor.log>
    Unity.exe -batchmode -nographics -debugCodeOptimization -buildTarget Win64 -projectPath <disposable-project> -executeMethod UCTDebugProbe.EditorProbe.BuildPlayer -logFile <build.log>
    <disposable-project>/Build/Probe.exe -batchmode -nographics -logFile <player.log>
    netcoredbg.exe --interpreter=vscode --engineLogging=<engine.log>

The player build explicitly selects NamedBuildTarget.Standalone, ScriptingImplementation.CoreCLR, .NET Standard, StandaloneWindows64, and Development|AllowDebugging. Installed UnityEditor.xml confirms these APIs and states that script debugging requires a Development build. The Editor verifies CompilationPipeline.codeOptimization==Debug; the documented -debugCodeOptimization flag applies to this session. No user Editor preferences are changed.

The debugger uses DAP over standard input/output, with no TCP port. It receives initialize, attach with the owned target PID, setBreakpoints, configurationDone, stackTrace, scopes, variables, next, stepIn, stepOut, continue, and disconnect with terminateDebuggee:false. Primitive values seed=7, value=10, and input=20 distinguish real locals inspection from successful protocol responses. Breakpoint and step locations must match the fixture methods. After detach the target must report Debugger.IsAttached=false, a later heartbeat, and arithmetic result 25.

Only UCT_DEBUG_EVIDENCE and UCT_DEBUG_BUILD_RESULT are added to the target environment. Existing DOTNET/COMPlus diagnostic enablement variables are recorded individually, without copying the whole inherited environment. No diagnostic or JIT override is silently added.

Startup and player build each have a 180-second deadline. DAP requests have a 10-second deadline, attach 30 seconds. The target exits normally after a stop file or 90 seconds; paused targets must first be detached/resumed. Failure cleanup sends detach, closes debugger input, then requests normal EditorApplication.Exit/Application.Quit. If a process remains live, the runner preserves its disposable project and reports it; it never closes a user project or claims successful cleanup.

Results are local under results/unity7-netcoredbg-<UTC timestamp>/: observation.json, Editor/player DAP JSONL, engine output, build result, and sanitized Unity logs. Each acceptance behavior records pass/fail separately. The recommendation is stop until both eligible targets demonstrate all required behaviors and normal cleanup. A pass is feasibility evidence for this exact alpha and debugger release only.

Recorded outcome, 2026-10-08
----------------------------

Stop the dependent shipping work for this candidate pair. The corrected run is results/unity7-netcoredbg-2026-10-08T06-00-43-631Z. Editor PID 28192 and player PID 39832 both confirmed System.Private.CoreLib 10.0.0.0, runtime 10.0.10, and x64. The Editor reported Debug optimization. Build PID 43812 succeeded with zero errors, CoreCLR, StandaloneWindows64, Development|AllowDebugging. API selection used NET_Standard; the installed enum readback string is its legacy alias NET_Standard_2_0, retained verbatim in build.json.

On both targets, initialize and the attach request returned success, the requested source breakpoint remained pending, and configurationDone failed with 0x80004005. The [pinned native debugger source](https://github.com/Samsung/netcoredbg/blob/9744e1f051866215611b8440c638042aa2aa2f72/src/debugger/manageddebugger.cpp) explains the timing: RunIfReady defers native AttachToProcess until ConfigurationDone. The earlier attach response therefore does not prove a completed attachment. This trace does not identify which native startup call failed or assign the failure to Unity or netcoredbg.

Breakpoint hit, step over, step in, step out, locals inspection, and verified managed detach all failed to obtain evidence on both targets. disconnect with terminateDebuggee:false returned success and both debugger processes exited 0, but both target exit codes were 3221226324 (0xC0000354), not normal shutdown. No fixture arithmetic result, post-detach heartbeat, or frame/local values were observed. Zero owned Editor/import-worker/player/debugger processes remained and the disposable project was removed. No forced termination was used.

The initial results/unity7-netcoredbg-2026-10-08T05-59-08-370Z run failed before attachment because the empty fixture had no JsonUtility module and a build DTO used the wrong error-count type. The fixture was corrected to managed JSON output and the obsolete DTO removed. This initial setup failure is not debugger compatibility evidence.

The real stdio protocol preflight passed initialize, initialized, disconnect(false), and debugger exit 0 without attaching to a target. No more attachment runs were attempted after the Editor/player native failure. Further work needs a separately reviewed diagnosis or a supported candidate combination. This issue ships no CoreCLR debugging and grants no permission to ship it.
