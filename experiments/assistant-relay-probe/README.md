# Assistant relay composition experiment

Private RUG-535 evidence. Nothing here registers a shipping tool, changes the extension, or changes the Unity package mirror.

The reviewed pin is Assistant 2.20.0-pre.1, published 2026-09-23T13:36:53.179Z, requiring Unity 6000.0.60f1. Its archive SHA256 is e19d67ccc57145fbeecd3f3958babe9c1578cd0023e8830b391178ee49456a3e. Embedded relay version is 1.0.12-build.99. The runner verifies fresh registry metadata, HTTP Date, seven-day age, archive bytes, and actual Editor ProductVersion 6000.3.9f1_7a9955a4f2fa before launch.

The [official registry](https://packages.unity.com/com.unity.ai.assistant) says pre.2 fixes a fatal CoreCLR BadImageFormatException when opening projects. Pre.2 is too recent for the age gate. This experiment uses Mono 6000.3.9f1 and does not prove CoreCLR Assistant support.

The supplied LICENSE.md binds the package to [Unity terms](https://unity.com/legal/editor-terms-of-service/software), checked 2026-10-08. This is an internal disposable local proof. It invokes no paid AI, chat, generation, or agent session. No relay binary or third-party source is distributed by this experiment.

The synchronous InitializeOnLoad ServerInstaller runs before the deferred RelayService startup. A bootstrap-only path assignment cannot ensure isolation. Before first import, the runner makes exactly four configuration substitutions in the disposable extracted package: MCPConstants.relayBaseDirectoryName, mcpBaseDirectoryName, prefProjectSettings, and RelayPersistenceService.k_KeyPrefix. Required absolute owned paths and unique preference prefixes are validated. Original and modified source hashes plus exact substitutions are recorded. Relay and selected tool implementation hashes must remain unchanged.

The unmodified relay binary discovers connections at os.homedir()/.unity/mcp/connections and does not use the C# UNITY_MCP_STATUS_DIR override. The owned discovery preflight confirms that [Bun's Windows USERPROFILE support](https://bun.com/reference/node/os/homedir) selects an owned fake connection file. The corrected fixture sets USERPROFILE only for the --mcp child, and aligns C# discovery paths under that disposable home. Editor licensing environment remains unchanged. These substitutions do not prove default-install behavior.

The experimental wrapper exposes exactly2 of the8 enabled MCP tools; the Editor registry contains54 total tools. The experimental provider registers through createStandaloneMcpRuntime(true).router.register. Committed tool-policy.json classifies every exposed relay tool: ReadConsole/Get reads, ReadConsole/Clear mutates, and RunCommand escapes policy through arbitrary C#. Unknown tools, actions, and differently cased argument keys fail closed before the child transport write. RunCommand is refused even with dryRun:true. Only console Get is forwarded. Results carry assistantRelay origin and the captured package version.

The policy evidence protects seven refusal variants, one allowed read, child startup failure, readiness timeout, early exit, empty catalog, and unexpected exit after readiness. The duplicate Action:Get/action:Clear negative control forwarded once before the exact-key guard; the current policy test refuses it with zero upstream calls. The minimum-version gate rejects 2019.4 before child construction. An installed 2019.4 Editor was not tested; shipped legacy paths have no changes.

Run from the repository root with Node and an already compiled standalone server:

- node experiments/assistant-relay-probe/run-assistant-probe.js --policy-tests --output <policy-result.json>
- node experiments/assistant-relay-probe/run-assistant-probe.js --discovery-preflight --archive <verified-package.tgz>
- node experiments/assistant-relay-probe/run-assistant-probe.js --editor <Unity.exe> --revision 6000.3.9f1 --archive <verified-package.tgz> --policy-evidence <policy-result.json>

Each Editor run owns a fresh validated TEMP fixture. Readiness requires the actual Editor PID/version/Mono identity, bridge IsRunning, and a matching connection PID/project. A stop file requests normal exit. Package StopAsync first sends IPC shutdown, then can use its own process-tree fallback; its completion alone is not exit proof. Editor normal exit, child exit, and zero owned Unity/relay processes are required before deleting only owned preferences and the fixture. Cleanup failure makes the result fail. Sanitization recurses before JSON serialization and removes licensing/credential lines, host names, user paths, and local interface addresses.

Current evidence:

- assistant-relay-2026-10-08T06-22-05-773Z: harness setup failed before Assistant import because a builtin checksum sidecar was included as a package. Fixed to enumerate directories only. No compatibility conclusion.
- assistant-relay-2026-10-08T06-25-10-927Z: actual Editor compiled and started Assistant, captured 54 registered tools, but MCP tools/list returned empty because discovery paths differed. Rejected as relay_empty_catalog. No tool calls sent. Editor and MCP child exited0; zero owned processes and preference cleanup observed.
- discovery-preflight-2026-10-08T06-32-29-571Z: unmodified MCP child selected the unique owned discovery file under the overridden home. No Editor or Unity endpoint existed. Child exited0.
- policy-proof-2026-10-08.json: current owner-boundary policy and five typed child failure cases passed.

The corrected assistant-relay-2026-10-08T06-36-43-227Z proof passed: 54 registered tools, 8 enabled relay tools, and 5 selected console reads through the existing server. RunCommand refusals added zero child requests and created no sentinel. Editor startup was 57,513ms, MCP child startup477ms; reads35,5,4,4,4ms. The Editor and MCP child exited0, quitting was recorded, and the final owned-process query was empty. A late Pipeline cleanup overlapped initial startup briefly; these timings are observations rather than an isolated benchmark.\n\nDecision: continue only opt-in composition design with explicit policy, pinned origin and fail-closed lifecycle. Do not ship a default relay path from this experiment. Default installation, full catalog classification, CoreCLR compatibility, and paid AI invocation remain outside this proof.
\nPrototype limit: RelayClient stdout framing, stderr capture, and retained message history are unbounded. Shipping work must bound these buffers and reject oversized protocol messages. This experiment does not claim a production-ready transport.\n