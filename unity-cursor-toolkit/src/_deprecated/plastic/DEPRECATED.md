# Plastic SCM Integration (Deprecated)

These files were part of a WIP Plastic SCM / Unity Version Control timeline feature.
They are preserved here for future re-implementation.

## What needs to happen before re-enabling

1. Remove `@ts-nocheck` from `plasticCli.ts` and `timelineViewProvider.ts`
2. Implement the `IModule` lifecycle in `index.ts` (activate/deactivate)
3. Register the `PlasticTimelineViewProvider` webview in `package.json` contributes.views
4. Add Plastic SCM configuration entries to `package.json` contributes.configuration
5. Wire `PlasticModule` back into `extension.ts` module registration
6. Add runtime tests for the CLI parsers (`parseFind`, `parseSimple`, `parseXml`)
7. Test with an actual Plastic SCM workspace

## Files

- `index.ts` -- Module shell (empty activate/deactivate)
- `plasticCli.ts` -- CLI wrapper, changeset parsing, platform-specific binary lookup
- `plasticRest.ts` -- REST API scaffold (returns empty)
- `timelineViewProvider.ts` -- Webview panel with timeline visualization
