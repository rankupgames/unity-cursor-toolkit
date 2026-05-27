# AI Agent Guide

Unity Cursor Toolkit is designed to give agents direct Unity Editor context without requiring users to paste console logs, scene state, or `.meta` files manually.

## What Agents Can Do

- Read recent Unity console output with `read_console`.
- Capture current console/profiler context with `profiler_snapshot`.
- Inspect project state with `project_info`.
- Inspect active scene hierarchy with `manage_scene` and `action: "getHierarchy"`.
- Resolve Unity `.meta` files with `resolve_meta`.
- Control play mode, capture screenshots, execute menu items, manage assets, edit GameObjects/components, and trigger builds when allowed.

## Safe Default Workflow

1. Call `project_info`.
2. Call `read_console` with `level: "error"` and then without a level filter.
3. Call `profiler_snapshot` with `action: "current"` when investigating performance, hitches, GC allocations, or frame timing.
4. Call `manage_scene` with `action: "getHierarchy"` before any scene edit.
5. Use `dryRun: true` for the first mutating call.
6. Execute the real mutating call only after the user has approved the intended change.

## Safety Controls

- Set `UNITY_CURSOR_TOOLKIT_MCP_READ_ONLY=1` to block mutating MCP tool calls.
- Pass `dryRun: true` to mutating Unity tools to return the normalized command without sending it to Unity.
- `resolve_meta` rejects absolute paths and traversal outside the Unity project root.
- Tools include MCP annotations such as `readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint` so clients can expose safer approval UX.
- `profiler_snapshot` read actions are allowed in read-only mode. Saving or clearing retained profiler sessions is treated as mutating.

## Dependency Changes

- Prefer `npm ci` for local installs.
- Use npm 11.14.1 or newer with `--min-release-age=7` for dependency updates.
- Keep audit remediations lockfile-scoped when possible, and do not update packages newer than 7 days without an explicit documented security hotfix approval.

## Agent Prompts

The standalone MCP server exposes prompts for common Unity workflows:

- `diagnose_unity_errors`
- `inspect_active_scene`
- `prepare_build`
- `safe_scene_edit_plan`

These prompts are intentionally conservative: inspect first, summarize state, then use dry runs before mutation.

## Useful Feature Ideas

- Prefab workflow tools: unpack/apply variants, inspect overrides, and instantiate prefabs safely.
- Unity Test Runner tools: list tests, run EditMode/PlayMode tests, and return structured failures.
- Build report tools: parse build output, surface warnings/errors, and compare artifact sizes.
- Package Manager tools: list packages, inspect versions, and propose dependency changes with dry-run output.
