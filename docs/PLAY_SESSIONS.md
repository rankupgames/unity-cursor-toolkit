# Play session evidence

The Editor-only recorder is opt-in for the current Editor process. It survives a
domain reload. A new Editor launch starts disabled. It does not alter the game,
pause on errors, restore a world, or run scenarios itself.

## Standby and capture

Configure the standalone MCP server with `UNITY_CURSOR_TOOLKIT_PROJECT_PATH`.
After MCP initialization it watches the selected project's journal without arming
recording or polling the scene. Arm capture through the Editor tool:

```json
{"action":"configure","enabled":true,"captureOnError":true}
```

Call `session_monitor` with that object. Start Play normally. The recorder emits
`session_started`, `error_observed`, `snapshot_captured` and `session_ended` events.
The final world snapshot is taken before Play teardown and preserves profiler
and grouped console artifacts. Compilation/reload interruptions remain explicit.

MCP delivers `notifications/message` with logger `unity.play_session`. Clients
can also subscribe to `unity://sessions/events` for resource update notifications.
The client decides whether a notification wakes an agent. A protocol notification
does not guarantee that a model automatically starts triage.

Explicit `session_monitor` actions `watch` and `unwatch` control the external
journal subscription. These do not enable recording. For a Node24 terminal observer:

```bash
npm run unity:watch-sessions -- --project /path/to/UnityProject
```

## Read the evidence

- `status`: current opt-in state, session ID, budgets and storage failures.
- `events`: `afterSequence` and `limit`1–100; sequence gaps remain visible.
- `capture`: request one bounded snapshot with an optional short `reason`.
- `read`: captured `sessionId`; optional `snapshotId`, `offset` and `limit`1–200.

IDs come from the recorder. Reads never accept an arbitrary filesystem path.
Artifacts live in `Library/UnityCursorToolkit/PlaySessions`. Disable capture with
`configure` and `enabled:false`; existing evidence remains on disk.

## Snapshot meaning

Each object records its captured instance ID, scene handle, name, layer/tag, active
state, world/local transforms, parent ID, child count and actual sibling index.
Component rows retain their actual slot, type, instance ID and available enabled
state. Missing script slots, missing required components, unassigned references
and broken serialized object references are distinct. No serialized string or
configuration values are collected. An intentional unassigned field is not itself
a bug. Instance IDs and scene handles identify this captured Editor state; they
are not durable identities after objects are destroyed or a session restarts.

The threaded error callback cannot safely capture a Unity world or identify a
native Console occurrence. Snapshots are next-safe-tick observations with UTC,
frame and capture-delay metadata. Session-scoped native Console matches retain
row indices, zero-context matches, stack compatibility and reset/range limits.
They remain candidates. Stack types identify possible component instances; they
do not prove which object threw or which null field caused an exception. An
older contextual entry never supplies exact context for a newer contextless one.

## Limits

The recorder has no idle scene scan. It groups repeated errors and takes at most
8 snapshots per session, reserving one for the final world. Limits are10000objects,
50000components and references, and8MiB per snapshot; per-object limits are32components, and each component can include16references
from at most512serialized properties. Truncation is explicit. The journal is capped at4MiB and retained evidence at512MiB.
Budget exhaustion stops capture explicitly and deletes nothing. Truncated data
must not be described as the full world. Snapshot duration is included; captures
can allocate and interrupt a frame, so they are not zero-overhead performance proof.
