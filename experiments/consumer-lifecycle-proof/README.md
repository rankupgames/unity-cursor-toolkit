# Consumer lifetime proof

This disposable proof protects terminal command result retention without retaining the command handler target. It runs a negative fixture with only the two-line handler release reverted, then the canonical package. Each run registers a captured instance handler, runs success/failure/cancel, unregisters its name, and tests a weak reference after terminal status remains readable. It does not inspect the handler field to declare success.

The fixed fixture then changes only its consumer assembly twice. Owner lifecycle callbacks unregister that consumer's command and patch callback, then register the replacement. A CoreCLR IL-patch refusal invokes the existing completion event; exactly one current callback must run. Registry identity, coordinator generation and assembly MVIDs distinguish retained package statics from ordinary reconstruction. Source reload alone does not establish selective retention: the evidence reports the observed path.

Run on Windows with the reviewed exact Editor:

```powershell
node experiments/consumer-lifecycle-proof/run-proof.js --editor $env:UCT_UNITY7_EDITOR --editor-version 7000.0.0a7 --editor-revision 581996e1a8f7
```

The runner checks executable metadata before creating TEMP fixtures. It uses shipped built-in modules and the local package, installs no registry packages, and changes only owned fixture code and play settings. Startup is bounded to 180 seconds and execution to 150 seconds. Normal shutdown requires the fixture quitting marker, exit code zero, and absence of processes whose command line names the exact fixture. Failure-only forced cleanup targets the owned Editor PID tree and is never recorded as normal shutdown.

Only structured observations are persisted under evidence. Raw Editor logs stay in TEMP. Successful fixtures are deleted after a fresh scoped process query; failed fixtures remain available for diagnosis.

Observed on Windows, Unity 7000.0.0a7_581996e1a8f7:

- The old-code fixture retained all three captured targets after Succeeded, Failed and Canceled status; their result snapshots remained readable.
- The fixed fixture collected all three targets while preserving the same terminal status and result behavior.
- Consumer v1, v2 and v3 each executed successfully. Each version produced exactly one main-PID patch callback; owner unloading removed its registration.
- Both final Editors exited with code zero, a quitting marker and no remaining owned processes.
- Both source reloads reconstructed static state. The second kept runtime/editor/coordinator MVIDs unchanged while replacing the consumer MVID, but registry identity and coordinator generation still changed. `selectiveRetentionObserved:false`; selective static retention is unproved.

The [successful observation](evidence/2026-10-08T08-46-00-868Z/observation.json) records those checks. Two earlier attempts ([first](evidence/2026-10-08T08-42-26-962Z/observation.json), [second](evidence/2026-10-08T08-44-19-967Z/observation.json)) ended with native exit code 3221226505 during shutdown. The proof coordinator saved SessionState from its unload callback after Unity's inspector state was destroyed. The first corrective edit missed LF source; the next asserted edit removed that save. Phase state is already saved before reload. Both attempts remain failed evidence and make no normal-shutdown claim.
