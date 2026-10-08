# Local Unity compatibility checks

RUG-537 uses the generated capability matrix to select an exact Editor and platform. The local licensed runner tests package handler activation, TCP handshake, console delivery and the compiled standalone MCP server. Each run writes JSON and exits nonzero when a check, identity check or shutdown check fails. No workflow or production API is changed.

Run from the repository root after the required extension compile/validation:

    node unity-cursor-toolkit/scripts/run-unity-compatibility.js --list

Select one configured candidate and supply its existing Editor executable:

    node unity-cursor-toolkit/scripts/run-unity-compatibility.js --candidate unity-6000-windows-smoke --unity "<installed-Editor-executable>"

UNITY_CURSOR_TOOLKIT_UNITY_PATH can supply the executable. The --package-cache option supplies an existing project Library/PackageCache containing Newtonsoft 3.2.2; the default is the repository sample cache. The --output option sets the JSON destination. Nothing installs or upgrades an Editor, authenticates an account, or changes a user project. Existing Unity licensing must permit the selected batch-mode Editor. A missing entitlement, compilation failure, missing dependency or timeout cannot pass.

The runner currently supports Windows process and listener ownership checks. macOS candidates remain configured but this runner refuses their execution until equivalent process ownership checks are implemented. Unity 2019.4.40f1 remains a configured, unrun candidate. Unity 2019.4 execution remains blocked by the user's instruction. Unconfigured or unrun versions/platforms remain untested; a configured candidate is not a successful run.

## Isolation and checks

The runner creates a TEMP project and copies the current canonical package. Before its first import it changes exactly the LastPort and ShowDebugLogs preference-key literals to unique fixture keys, recording original and modified source hashes. It embeds the already cached Newtonsoft 3.2.2 package as an explicit fixture override of the declared 3.2.1 dependency, and uses the selected Editor's existing built-in modules. This does not verify the distributable dependency graph.

Activation means that the loaded UnityCursorToolkit.Editor assembly already contains the registered project_info handler. The fixture does not call the bridge initializer or manually register a handler. After this observation, it calls the existing private TryStartOnSpecificPort method with an OS-selected port. The runner verifies that the listener belongs to its exact launched Editor PID before sending traffic. Default ports may be excluded by host policy; this test does not prove default-install listener activation.

Handshake checks real ping/pong and project_info for the exact fixture, version, platform and runtime. Console checks an exact unique message through the real connection. MCP launches the compiled Node stdio server in read-only mode, initializes the actual protocol, lists project_info/read_console, checks matching project_info, and reads a second unique formatted LOG message. There are no synthetic bridge replies.

The fixture stops the server, deletes only its two preference keys while Editor APIs are active, and exits normally. The runner requires the same-PID quitting marker, exit code zero, MCP exit code zero, no remaining owned Editor/import-worker processes and no owned registry preference keys. Timeouts request normal exit first; bounded forced cleanup applies only to this runner's own child tree and makes the run fail. Failed TEMP fixtures remain available for diagnosis. Raw Editor logs stay in TEMP; committed JSON contains no home, installation or project paths, credentials or raw licensing output.

## Result and matrix import

The result records candidateId, band, requestedEditorVersion, observedEditorVersion, editorVersion, platform, architecture, PID, runtime, four named checks, isolation and shutdown evidence. A preflight refusal has outcome untested, launched false, checks untested and a typed error; an exact version is never invented as observed. A setup or executed-check failure has outcome failed. Passing reports require all four checks and confirmed owned shutdown.

Reports are under experiments/unity-compatibility/results by default. To add a reviewed passing observation to the existing capability input, explicitly run:

    node unity-cursor-toolkit/scripts/generate-capability-matrix.js --import-results "<passing-report.json>"

Import also requires the corrected ownedPreferenceQueryConfirmed check; older reports cannot import on their ownedPreferencesAbsent flag alone. Import refuses a mismatched candidate/version/platform, missing checks, malformed boolean values, inconsistent runtime data, missing isolation or unconfirmed shutdown. It records only isCoreCLR and hasDomainReload in the existing matrix shape. The four smoke results stay in the exact-run report. Repeated imports are idempotent and evidence ordering is deterministic.

    node unity-cursor-toolkit/scripts/generate-capability-matrix.js --check

A verified band cell is limited to its listed exact observations. It does not certify other Editors, platforms or all toolkit functions. This local runner is the licensed fallback for RUG-537; CI integration can be reviewed after the local proof, without changing the vendor attestation workflow.

## Recorded Windows runs

| Exact Editor | Four checks | Owned exit and cleanup | Result |
| --- | --- | --- | --- |
| 6000.3.9f1 | All pass | Editor/MCP exit 0, same-PID quitting, strict process query empty, real registry keys absent | [Final passing observation](../experiments/unity-compatibility/results/unity-6000-windows-smoke-2026-10-08T10-52-26-373Z.json) |
| 7000.0.0a7 | All pass | Editor/MCP exit 0, same-PID quitting, strict process query empty, real registry keys absent | [Final passing observation](../experiments/unity-compatibility/results/unity-7000-windows-local-2026-10-08T10-53-27-759Z.json) |

Only these two definitive observations were imported. Both use atomic IPC publication, the corrected literal registry path, strict process-query output and ESRCH-only PID absence. No forced cleanup occurred. Their owned TEMP fixtures were removed.

Two initial setup attempts failed before an Editor was spawned because the built-in module scan included .meta files. The initial report format did not yet distinguish requested versus observed version; its editorVersion is a request, not a runtime observation. The corrected scan requires directories.

The [earlier Unity 7 observation](../experiments/unity-compatibility/results/unity-7000-windows-local-2026-10-08T10-25-12-433Z.json) passed all four functional checks but exited 1 through the fixture's stop-request read failure. Its overall result remains failed. The generic catch did not record the precise exception. Ready/error messages and console/stop requests now publish by rename after writing.

Earlier successful-looking reports at 10:23, 10:30 and 10:32 used a JavaScript string that lost registry-path backslashes. They remain immutable and are superseded for cleanup proof. Their imports were removed. Correct read-only reassessments found no remaining fixture keys or owned processes but did not repair the historical results or permit import.

The [registry regression](../experiments/unity-compatibility/results/registry-query-regression-2026-10-08T10-44-40-077Z.json) restores only the original query helper in a disposable runner. With a real owned registry sentinel present, it falsely passed with count zero; the corrected helper refused with count one. After deleting that exact sentinel, the corrected helper passed with count zero. The existing runtime test suite exercises the same actual CLI boundary; no test-only production export is added.

A read-only historical cleanup reassessment is available with --verify-cleanup "<report.json>" --project "<owned-TEMP-fixture>". It verifies only the compatibility preference prefix, the exact saved PID and the supplied owned TEMP fixture scope. It does not start or stop an Editor, change preferences, alter the original observation or create importable compatibility evidence.

No default-port, other-platform or whole-band support claim follows from these runs.
