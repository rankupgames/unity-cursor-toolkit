Private RUG-556 optional TestRunnerApi proof. No production test-framework dependency is added.

The child assembly references UnityEditor.TestRunner and UnityEngine.TestRunner. Its package version define and matching define constraint exclude it when com.unity.test-framework is absent. It has no explicit NUnit reference. The main package facade finds only the loaded optional child and returns a typed unavailable result when it is absent.

Actual observations on 2026-10-08:

| Editor | Proof | Outcome |
| --- | --- | --- |
| 6000.3.9f1_7a9955a4f2fa / Mono | Standalone optional assembly, absent and present TF1.6.0 | Both compile cases passed; normal exit 0 and no owned processes |
| Same Editor | Full canonical package, absent and present TF1.6.0 | Both compile cases passed |
| Same Editor | Production TCP facade without framework | Capabilities unavailable and typed missing-framework refusal passed |
| Same Editor | Production TCP facade with framework | Seven checks passed: list7 leaves without execution, literal metacharacter name, AND filters with namespace descendants, Cartesian scope refusal, typed assertion failure with stack, skipped, inconclusive |
| Same Editor | Oversize result / owned cancellation | Failed: cancellation skipped the native completion callback; provider returned cancellation_unconfirmed. Normal Editor exit 0 and no owned processes |
| Same Editor | Reviewed internal holder stop observation | Final 17-check bridge proof passed, including oversize refusal, Play reload/heartbeats, confirmed owned cancellation, native timeout after actual start, and successful subsequent runs; normal exit 0 and zero owned processes |
| 7000.0.0a7_581996e1a8f7 / System.Private.CoreLib | Full canonical package, TF1.9.0 | Full 17-check native execution proof passed: same checks as Mono, including actual-start owned cancellation/timeout and successful subsequent runs; normal exit 0 and no owned processes |
| 6000.6.4f1 | Parent-owned production CLI adapter | EditMode pass, deliberate typed failure and PlayMode pass; evidence lives in experiments/unity-cli-baseline/captures/test-adapter-2026-10-08T07-35-45-621Z |
| Unity 2019 | Runtime proof | Blocked by Miguel; not run and no installed Editor |

Run only after the shared Editor resource slot is released:

    node experiments/test-runner-bridge/run-optional-compile-proof.js --editor "<reviewed Editor executable>" --case both
    node experiments/test-runner-bridge/run-bridge-proof.js --editor "<reviewed Editor executable>" --case present --keep-for-cli

For the reviewed Unity 7 compile/list proof, provide --editor-version 7000.0.0a7 --editor-revision 581996e1a8f7 --list-only. The runner verifies the actual executable revision and runtime. The framework version comes from that installed Editor's built-in package metadata. Resolved NUnit versions are recorded in sanitized Unity logs.

The public cancellation API alone cannot establish stopped work. Installed framework 1.6 source shows CancelRun replaces the task stack with Canceled mode; RunFinishedInvocationEvent has RunOnCancel=false. Its public CancelTestRun return value cannot establish stopped work: false also means already cancelling. IsRunning(guid) is internal in inspected framework 1.6,1.8,1.9. The adapter therefore binds exact source-reviewed internal contracts only for package 1.6.0,1.8.0 and1.9.0: TestRunnerApi.m_testJobDataHolder, holder.GetRunner(string), and IsRunning(string). Actual PackageInfo metadata and fixed signatures gate execution; unsupported versions refuse run before Execute. A positive registered+active observation must occur in the same initialization generation. Only a later Editor update can confirm that the exact GUID is absent from the same holder object. Reload resets that observation; holder replacement or reflection failure after execution leaves work unconfirmed. RunFinished does not release pending work because it precedes remaining cleanup tasks. This confirms scheduler unregister and owned execution stopped; it does not claim cancellation ran every NUnit teardown path. Error callbacks queue cancellation onto EditorApplication.update instead of mutating the framework enumerator inside TestFinished.

Backend outcomes preserve their native meaning. The actual 6.3 bridge reports a lone inconclusive test as completed with inconclusive 1 (its native root result is Passed). The same fixture through the CLI exits 8/TESTS_FAILED, so the CLI adapter returns a typed failed result while retaining inconclusive 1. This is an observed backend difference, not a claim of identical terminal status. The corrected five-case 6.3 comparison passed for literal-name pass, assertion failure, skipped, inconclusive with this explicit difference, and PlayMode pass; evidence is experiments/unity-cli-baseline/captures/test-backend-parity-2026-10-08T08-24-40-511Z. The corrected CLI parser accepts native root Skipped:Ignored; it does not convert inconclusive process failure into success.

The public callbacks do not expose the native GUID. Require exclusive TestRunner use. Observed concurrent runs are refused. A second RunStarted during the owned job latches a conflict, requests cancellation only for the owned GUID, and leaves completion unconfirmed. An already-active foreign run before adapter initialization cannot be detected through these public callbacks. A completion callback can collect a normal result only when it contains all selected leaves and no unexpected leaves. It does not clear pending work; that requires the later exact-GUID holder observation.

Results are complete or return result_too_large; messages and stacks are not silently truncated. Discovery is bounded to30 s and10,000 leaves. Run deadlines default to10 min and are capped at10 min. Persisted owned state is capped at1 MiB. Ownership tokens are private, scoped to the project, Editor PID and operation, and survive only the same owned job's Play reload.

Historical failed raw logs included ownership tokens because the old transport logged full requests. Those saved artifacts were redacted and marked as such; they do not claim tokens were absent before sanitization. The parent removed raw request logging. Final 6.3 and 7 captures enabled debug logs, scanned raw logs before sanitization and recorded zero ownership-token values. Saved evidence also removes owned paths, repository paths, host/IP and session/credential lines. Only validated disposable TEMP paths are removed after scoped owned-process checks.

Evidence:
- results/absent-2026-10-08T06-55-44-135Z and present-2026-10-08T06-55-58-646Z: standalone compile.
- results/absent-2026-10-08T07-29-54-107Z and present-2026-10-08T07-30-11-939Z: full package compile.
- results/bridge-absent-2026-10-08T07-38-39-672Z: live absence.
- results/bridge-present-2026-10-08T07-44-20-292Z and07-53-48-415Z: seven successful checks and honest oversize cleanup failure.
- results/bridge-present-2026-10-08T07-58-15-643Z: Unity 7 partial-class compile failure.
- results/bridge-present-2026-10-08T07-59-23-494Z: corrected Unity 7 compile/capabilities/list success before holder integration.
- results/bridge-present-2026-10-08T08-09-27-212Z: full Mono 14-check success with exact owned GUID stop observation.
- results/bridge-present-2026-10-08T08-31-11-797Z: final Unity 7 full 17-check native execution success, normal exit 0/zero owned processes.
- results/bridge-present-2026-10-08T08-27-02-241Z: Unity 7 first nine native checks passed; recorder then waited for a start broadcast that occurred before facade rebind. The owned native observer records actual start. Cancellation gating now uses that observer, with polling retained for timeout.
- results/bridge-present-2026-10-08T08-19-44-038Z: final Mono 17-check pass, including native timeout after actual execution started and subsequent successful jobs after cancellation and timeout.
- results/bridge-present-2026-10-08T08-15-52-148Z: all previous checks plus next-run-after-cancel passed; added timeout recorder failed to observe progress without polling after reload. Native observer records actual test start. The recorder wait was corrected; this failed attempt is retained.

Primary API references: [assembly definition constraints](https://docs.unity3d.com/Manual/assembly-definition-file-format.html), [TestRunnerApi 1.1](https://docs.unity3d.com/Packages/com.unity.test-framework@1.1/api/UnityEditor.TestTools.TestRunner.Api.TestRunnerApi.html), [TestRunnerApi 1.8 cancellation](https://docs.unity3d.com/Packages/com.unity.test-framework@1.8/api/UnityEditor.TestTools.TestRunner.Api.TestRunnerApi.html).
