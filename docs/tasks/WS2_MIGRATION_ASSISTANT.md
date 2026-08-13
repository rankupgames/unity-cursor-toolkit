# WS2 — CoreCLR Migration Assistant

Status: **Planned; blocked by WS1 tasks 1 and 2 (P0)**

Last reviewed: 2026-08-13

Support impact: no migration tool is shipped until the scanner and negative
tests pass.

Goal: scan any user's Unity project for 6.8/CoreCLR-breaking patterns, report each site with the documented replacement, and let agents fix them via MCP. The "install because of the transition" feature. Time-boxed relevance 2026-2028.

Depends on: WS1 task 1 (inventory seeds the rule set), WS1 task 2 (version gate).

Rule sources: Path to CoreCLR upgrade guide — statics no longer reset, `DomainUnload` never fires, deprecated `AppDomain.CurrentDomain.GetAssemblies()`, banned `Assembly.Load` overloads, empty `Assembly.Location`, `ManagedDebugger` removal; replacements `[AutoStaticsCleanup]`, `[BeforeCodeUnloading]`/`[AfterCodeReloadSerialization]`, `CurrentAssemblies.GetLoadedAssemblies()`, `CurrentAssemblies.LoadFromPath()`, `Assembly.GetLoadedAssemblyPath()`, `System.Diagnostics.Debugger`.

## Tasks

- [ ] 1. **Rule set as data.** `coreclr-migration-rules.json`: id, match pattern, severity (breaks / behavior-change / deprecated), explanation, documented replacement, docs URL. Committed config, not hardcoded in logic. (Half day.)
- [ ] 2. **Regex scanner v1 (extension side).** TypeScript scanner over `Assets/` + `Packages/` C# files applying the rule set; structured findings (file, line, rule id, snippet). Skip generated/Library. New module `unity-cursor-toolkit/src/migration/`. (1 day.)
- [ ] 3. **Extension command + report.** "Unity Toolkit: CoreCLR Migration Scan" -> markdown report (grouped by severity, per-site replacement guidance) opened in the editor + saved under the project. (Half day.)
- [ ] 4. **MCP tool.** `coreclr_migration` with `action: "scan" | "report" | "rules"`; findings as structured JSON so agents can iterate site-by-site. Respect read-only mode (scan is read-only anyway). Register in `src/mcp/server.ts` + `toolMetadata.ts`, and standalone server. (Half day.)
- [ ] 5. **Statics inventory (Unity side).** C# reflection pass listing static fields in user assemblies with no reset/cleanup attribute — the "will carry state after 6.8" list. Exposed through the existing bridge as part of the scan payload. (1 day.)
- [ ] 6. **Semantic pass v2 (optional, later).** Roslyn-based analysis for cases regex can't judge (e.g. which `Assembly.Load` overload). Only if v1 false-positive rate is annoying. (2 days; defer.)
- [ ] 7. **Agent workflow docs.** Section in `docs/AI_AGENTS.md`: scan -> prioritize -> fix loop with dry-run guidance; prompt template. (Half day.)
- [ ] 8. **Marketing.** README + marketplace description: "CoreCLR migration assistant built in — get ready for Unity 6.8/7." (Half day, with WS4 repositioning pass.)

## Done when

Scanning this repo's own `CursorUnityTool` project reproduces the known WS1 inventory findings via both the command and the MCP tool, with correct replacement guidance per site.
