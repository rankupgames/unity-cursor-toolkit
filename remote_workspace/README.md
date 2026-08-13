# Unity VDD Shell Workspace

Status: experimental remote-rendering workspace. It is part of the Unity 7
readiness program because first-party semantic control does not replace a
rendered Editor-window and input plane. Unity 7 compatibility is not yet
validated. See [Unity 7 readiness](../docs/UNITY_7_READINESS.md) and
[WS7](../docs/tasks/WS7_REMOTE_SHELL.md).

Run `Unity Shell: Init Manifest` from VS Code/Cursor to create the local `unity-shell.json` manifest from the checked-in example. The real manifest is ignored because it contains machine-specific SSH targets and remote paths.

The MVP assumes a Windows host with a VDD monitor, FFmpeg, an exact-version
Unity Windows Player build, and the remote PowerShell sidecar copied to the
manifest's `remoteSidecarPath`. Do not substitute a newer Editor for the
project's declared version during proof runs.

For the Unity-without-editor Windows proof gate, also set:

- `remoteRepoPath`: absolute path to this repo on the Windows host.
- `unityEditorPath`: absolute path to the installed Unity editor, for example `C:\Program Files\Unity\Hub\Editor\6000.3.9f1\Editor\Unity.exe`.

Then run from the Mac side:

```bash
npm --prefix unity-cursor-toolkit run proof:windows-unity-without-editor:remote -- --manifest "$PWD/remote_workspace/unity-shell.json" --preflight-only
npm --prefix unity-cursor-toolkit run proof:windows-unity-without-editor:remote -- --manifest "$PWD/remote_workspace/unity-shell.json"
```

The preflight checks the Windows host tools and paths without starting the full proof. The full command SSHes into the Windows host, runs the real `proof:windows-unity-without-editor` runner there, and fetches the generated proof files back under `experiments/windows-unity-without-editor/results/` so the local audit can validate them.

If the proof folder is copied back manually instead, import and validate it with:

```bash
npm --prefix unity-cursor-toolkit run proof:windows-unity-without-editor:import -- --from "/path/to/copied/<date>-windows"
```
