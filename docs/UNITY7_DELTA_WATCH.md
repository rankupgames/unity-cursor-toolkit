# Unity 7 delta watch

Last overlap review: 2026-10-08 UTC. Observed Editor: **7000.0.0a7 (581996e1a8f7), Windows x64**. Matrix freshness check: 2026-10-08, passed.

**Preparation only. Unity 7 and CoreCLR support are not shipped.** Exact-alpha fixture results do not certify other versions, platforms or all toolkit flows. Unity's [October update](https://discussions.unity.com/t/coreclr-scripting-and-net-update-october-2026/1738338) describes compatibility testing with C# 9/.NET Standard 2.1.

## Version boundary

| Surface | Published source checked on 2026-10-08 | Recorded live evidence |
| --- | --- | --- |
| Standalone CLI | [1.0.0-beta.13, October 7](https://discussions.unity.com/t/unity-cli-1-0-0-beta-13-is-rolling-out/1738551) | [beta.12, Windows](../experiments/unity-cli-baseline/captures/2026-10-08-cli-1.0.0-beta.12-windows-x64.json) |
| Pipeline | [Registry latest 0.8.0-exp.1, September 25](https://packages.unity.com/com.unity.pipeline); [announcement](https://discussions.unity.com/t/unity-pipeline-package-0-8-0-exp-1-is-available-now/1737832) | [0.8.0-exp.1 / CLI beta.12 / Editor 6000.3.9f1](../experiments/pipeline-composition-spike/DECISION.md) |
| Unity 7 | [7000.0.0a7 notes](https://unity.com/releases/editor/alpha/7000.0.0a7) | [Exact-build capability evidence](CAPABILITY_MATRIX.md) |

Beta.13 was not installed or exercised in this review. Pipeline [0.9.0 renames](https://discussions.unity.com/t/heads-up-upcoming-com-unity-pipeline-0-9-0-release-will-include-breaking-changes-to-command-names/1738559) are upcoming, not a verified published replacement.

## Active delta

| Preparation item | Observed version/date | Remaining gap |
| --- | --- | --- |
| Native CoreCLR lifecycle/resource ownership | 7000.0.0a7, Windows x64, 2026-10-08 | AssemblyLoadContext reload replaces AppDomain reload. Toolkit-owned workers, delegates and statics need native unload/init ownership. CLI recompilation does not implement that ownership. Pipeline 0.8's `[OnCodeReload]` runs after tagged method overrides bind on live component instances; it does not substitute native assembly-unload cleanup. |

Sources: Unity's [runtime update](https://discussions.unity.com/t/coreclr-scripting-and-net-update-october-2026/1738338), [migration guide](https://discussions.unity.com/t/path-to-coreclr-2026-upgrade-guide/1714279), and Pipeline's [reload contract](https://docs.unity3d.com/Packages/com.unity.pipeline@0.8/manual/code-reload.html#reload-callbacks--oncodereload). Reviewed 0.8.0-exp.1 `ReloadFile`/watcher callers and `CodeReloadRegistry.InvokeReloadCallbacks` confirm the distinction.

The [package proof](../experiments/coreclr-package-audit/results/unity7-package-lifecycle-2026-10-08T05-27-37-571Z/observation.json) observed `OnCodeUnloading`/`OnCodeInitializing`; the [consumer proof](../experiments/consumer-lifecycle-proof/README.md) observed static reconstruction, not selective retention. Recheck callback order, main-thread initialization, shutdown guards, worker joins and collection per beta. Use exact metadata/observations rather than older guide callback names.

## Excluded overlap and uncertainty

Editor discovery/status, project management, builds/tests, schemas, MCP, detached jobs and existing service reads are covered by [CLI](https://docs.unity.com/en-us/unity-cli/unity-cli-reference) and [Production Pipeline tools](https://docs.unity.com/en-us/unity-production-pipeline/local-tools-cli). Pipeline already provides [tagged/interpreter reload](https://docs.unity3d.com/Packages/com.unity.pipeline@0.8/manual/code-reload.html) and [Game View capture/input](https://discussions.unity.com/t/unity-pipeline-package-0-8-0-exp-1-is-available-now/1737832). Beta.13 documents dialog-blocked status and explicit upgrades. These are overlap, not active gaps.

Full-C# CoreCLR patch-backend equivalence and debugger coverage are **unverified**, not confirmed absent. The [pinned debugger failure](../experiments/coreclr-debug-probe/README.md) does not exclude every candidate. Unity's [future .NET 10/C# 14/MSBuild work](https://discussions.unity.com/t/coreclr-scripting-and-net-update-october-2026/1738338) and possible fleet/service gaps remain outside the active list.

## Repeatable refresh

Repeat on every material Unity 7 beta: runtime/lifecycle/API changes or changes relevant to an entry. Relevant CLI/Pipeline releases also trigger overlap review.

1. Record UTC date, exact Editor revision/platform, published and installed CLI versions, and Pipeline registry pin/date. Read primary notes and versioned docs. This review performs no installs or upgrades.
2. Re-run overlap against installed CLI version/help/manifest and the exact Pipeline catalog plus implementation callers. The [baseline recorder](../experiments/unity-cli-baseline/capture-baseline.js) refuses pins other than beta.12; review its guard/output before an approved newer capture. Never relabel evidence or infer absence from grep.
3. Under approved disposable-proof scope, rerun relevant lifecycle/consumer/command checks. Reclassify the [Pipeline risk inventory](../unity-cursor-toolkit/src/core/pipelinePolicy.json) when its pin/catalog changes. Resolve actual renamed commands; retain unsupported/untested states where evidence is missing.
4. Refresh the [capability matrix](CAPABILITY_MATRIX.md) from accepted observations: `node unity-cursor-toolkit/scripts/generate-capability-matrix.js --import-results <accepted-report.json>`, then `node unity-cursor-toolkit/scripts/generate-capability-matrix.js --check`. Review the generated diff and record date plus failed/skipped checks. Bands certify only recorded fixtures.
5. Delete covered entries. Each retained entry needs exact observed version/date, primary citation and behavior-based gap justification. Keep uncertain candidates outside the active list; update the review date and preparation wording.
