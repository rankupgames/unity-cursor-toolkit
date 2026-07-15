# 2026-06-10 Viewport Proof Image-Only False Pass

## Summary

The installed Cursor Scene/Game proof passed on 2026-06-10 because both panels produced live frame hashes, but Miguel's screenshot review caught two product failures that the proof did not cover: the Game View frame was vertically inverted on the macOS editor-window readback path, and the webview could still feel like a passive image because input delivery was not part of the pass condition.

## What Happened

- The proof required `host:"editor"`, `captureMode:"editorWindow"`, live frame sequence, valid dimensions, byte count, and SHA-256 frame hashes.
- That proved pixels were arriving from Unity, but it did not prove the panel was correctly oriented or interactive.
- The screenshot at `experiments/installed-cursor-smoke/screenshots/2026-06-10-cursor372-clean-scene-game.png` showed the gap clearly enough to stop treating the prior proof as complete.

## Root Causes

- `EditorWindowViewportCapture` flipped Windows readbacks, but not the Game View readback path seen on this macOS Unity 6000.3.9f1 run.
- `ViewportStreamTool.Input` fast-pathed `EditorWindow.SendEvent` only for Scene View. Game View input could fall through to project adapters or Input System fallbacks before the actual Unity GameView window.
- `unity-cursor-toolkit/src/viewport/index.ts` ignored input results and the automated proof did not send or verify any input event.

## Fixes Applied

- Made editor-window input first-class for every `captureMode:"editorWindow"` session, including Game View.
- Made Game View readback orientation view-aware so bottom-origin GameView buffers are flipped before JPEG encoding.
- Added Game View pointer-lock request on click and surfaced viewport input failures in the panel status.
- Added automated `inputProof` for Scene View (`sceneDrag`) and Game View (`pointerDown+pointerUp`) and require both to route through the `editorWindow` layer before proof pass.
- Updated the Unity-without-editor audit to reject hash-only proof artifacts.

## Verification

- `npm run validate` passed on 2026-06-10.
- `npm run audit:unity-without-editor` passed as partial on 2026-06-10 with 12 pass, 1 pending Windows gate, 0 fail.
- New interactive installed-Cursor proof passed:
  - Smoke: `experiments/installed-cursor-smoke/results/2026-06-10-interactive-smoke.json`
  - Proof: `experiments/installed-cursor-smoke/results/2026-06-10-interactive-proof.json`
  - Host-screen screenshot after proof: `experiments/installed-cursor-smoke/screenshots/2026-06-10-interactive-proof.png`
- Proof details:
  - Scene View frame `1108x720`, sequence `6`, SHA-256 `0bfd3a615cf988227dd96791817401fc964c64427ae21555c2674350294aa0b9`, input `sceneDrag`, layer `editorWindow`.
  - Game View frame `1279x704`, sequence `6`, SHA-256 `643b15d58380f93c2d91f5b31fa1967abc5f64c528115a4809c41383d877c832`, input `pointerDown+pointerUp`, layer `editorWindow`.

## Cleanup

The proof-owned isolated Cursor process and hidden Unity editor were terminated after verification. The stale `CursorUnityTool/Temp/UnityLockfile` left by the proof editor was removed. `Library/` was not wiped.

## Remaining Gate

The Windows installed-host proof remains pending and must use the strengthened input-aware proof before the Unity-without-editor series can be considered fully complete.
