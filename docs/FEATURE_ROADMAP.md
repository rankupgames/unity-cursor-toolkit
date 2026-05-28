# Feature Roadmap

This roadmap focuses on features that make Unity Cursor Toolkit more useful for human developers and safer for AI agents.

## MCP Readiness

- Ship the standalone stdio MCP server as the primary cross-client integration path.
- Keep tool schemas stable and additive; prefer aliases over breaking argument changes.
- Add richer structured outputs for project info, scene hierarchy, build reports, test results, and profiler snapshots.
- Add install snippets and client-specific setup docs for Cursor, Claude Code, VS Code, Zed, Windsurf, and other MCP clients.
- Expand resources and prompts so agents can discover context without calling mutating tools first.

## Unity Automation

- Runtime command registry: expose project-owned coroutine workflows through MCP without UI automation.
- Prefab tools: inspect overrides, instantiate prefabs, apply/revert changes, and support variants.
- Selection tools: get current selection, select by instance ID, frame selected objects, and ping assets.
- Test Runner tools: list tests, run EditMode/PlayMode tests, and return structured failures.
- Build report tools: trigger builds, read build summaries, compare size deltas, and surface warnings.
- Package Manager tools: list packages, inspect versions, and prepare dependency changes.
- Profiler tools: capture FPS, memory, GC allocations, and slow frame summaries.

## Safety And Trust

- Expand read-only mode to every new tool before exposing write behavior.
- Keep `dryRun: true` support on all mutating tools.
- Prefer Unity Undo-backed mutations on the C# side so user-visible edits can be reverted in the Editor.
- Label destructive operations with `destructiveHint` and mention exact target assets/objects in outputs.
- Add path validation and workspace containment anywhere tools touch disk.

## Near-Term Ranking

1. Unity Test Runner tools, because tests are the highest-signal feedback loop for agents.
2. Prefab and selection tools, because most scene-editing workflows need object targeting and reversibility.
3. Build reports, because they turn a high-cost operation into inspectable structured output.
4. Profiler snapshots, because performance debugging is valuable but needs more Unity-side implementation work.
