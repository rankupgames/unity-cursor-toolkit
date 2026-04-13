# Contributing to Unity Cursor Toolkit

Thank you for your interest in contributing. Please follow these guidelines.

## Dev Setup

```bash
git clone <repo-url>
cd unity-cursor-toolkit
npm install
npm run dev
```

## Branch Naming

- `feature/<name>` — New features
- `fix/<name>` — Bug fixes
- `chore/<name>` — Maintenance, docs, tooling

## PR Process

1. Fork the repository
2. Create a branch from `Version-*` or `main`
3. Implement your changes
4. Test locally (see Testing below)
5. Open a PR against the appropriate base branch

## Testing

- `npm run compile` must pass
- Test against a Unity project with the extension installed
- Verify hot reload, console panel, and connection behavior as relevant

## Unity Scripts

Changes to `unity-assets/` C# files must:

- Compile in Unity 2019+
- Wrap editor-only code in `#if UNITY_EDITOR` / `#endif`

## Code Style

- TypeScript strict mode
- Tabs for indentation
- Prefer `const` arrow functions over `function` declarations
