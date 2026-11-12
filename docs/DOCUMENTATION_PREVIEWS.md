# Documentation previews

The package can show Markdown, Obsidian Canvas and Excalidraw files in the Unity Inspector. The code is in `Packages/com.rankupgames.unity-cursor-toolkit/Editor/Documentation/`.

| File | Result |
|---|---|
| `.md` | Formatted Markdown in the Inspector. Links, wiki links and image embeds resolve. |
| `.canvas` | Imported as a drawing asset. The Inspector shows the canvas. |
| `.excalidraw` | Imported as a drawing asset. The Inspector shows the canvas. |

## Enable

The feature is off by default. To enable it, add `UCT_DOCUMENTATION` to **Project Settings > Player > Scripting Define Symbols** for the Editor build target. To disable it, remove the symbol. The `UnityCursorToolkit.Documentation.Editor` assembly compiles only when the symbol is set.

When the feature is on, the package replaces the Inspector for all `TextAsset` objects. Files that are not `.md`, and multiple selections, use the native Unity TextAsset Inspector.

## Dependencies

- `com.unity.nuget.newtonsoft-json`. The package already declares it. The assembly references `Newtonsoft.Json.dll` as a precompiled reference, because that package has no assembly definition to reference.
- No other packages, services or background polling.

## Unity and compiler scope

- The code targets C# 7.3 and the Unity 2019.4 API surface. Compilation on each supported Unity version still requires native validation.
- Unity 2020.2 and newer use `UnityEditor.AssetImporters`. Older versions use `UnityEditor.Experimental.AssetImporters`.
- Unity 2020.1 and newer record the icon dependency with `DependsOnArtifact`. Older versions use `DependsOnSourceAsset`.
- The native TextAsset Inspector is the internal type `UnityEditor.TextAssetInspector`. If a Unity version does not have it, non-Markdown text assets show an error message. Remove `UCT_DOCUMENTATION` to get the native Inspector back.

## Paths

Files must be in `Assets/` or in `Packages/<name>/`. Git and registry package reads use `PackageInfo.resolvedPath`. Source reads reject symbolic links below the selected root. Links resolve inside the same root:

- A relative link resolves from the folder of the file. `..` is permitted only while the path stays inside the root.
- Rooted paths, drive paths, UNC paths, paths that start with `/` or `\`, and paths that contain `:` cause an error.
- Wiki links search only the root of the current file.
- Canvas file nodes search the canvas folder, then each parent folder up to the root.

An immutable package, for example a registry package, is read-only. You can preview its files, but you cannot edit them.

## Updates

- The Markdown view rebuilds when the project changes. Changes to linked Markdown files and images show after the next import.
- Canvas and Excalidraw importers record source and icon dependencies. Changes to linked files trigger reimports.
- Canvas imports track checked candidates. Unity 2020.1 and newer also register missing candidates as artifact dependencies, so adding a missing or nearer linked file triggers a reimport. On Unity 2019.4, manually reimport after adding a previously missing file.
- The importer versions are Excalidraw 4 and Canvas 2. The stricter parsers cause a reimport of existing drawings.

## Fallbacks and limits

- WebP images in a canvas show a placeholder. The package has no WebP decoder.
- Excalidraw embedded images are not supported. An image element causes an import error.
- Excalidraw rotation, roughness and embeddables are not drawn.
- The `compressed-json` Excalidraw format is not supported.
- If the Inspector scroll view cannot be found, a diagnostic explains that automatic height and window culling are unavailable. Reopen the Inspector to retry.
- Invalid JSON, wrong value types, non-finite numbers, duplicate element IDs, negative sizes and invalid colors cause an import error with the file path. The importer does not skip bad data.

## Move from a project copy

If a project has its own copy of these files, remove that copy in the same change that installs or updates the package and enables the feature. GUID conflicts can occur even when the assembly is disabled. The package files keep the original `.meta` GUIDs, so existing asset references stay valid. Two copies with the same GUIDs cause GUID conflicts.

| File | GUID |
|---|---|
| `ExcalidrawCanvas.cs` | `415deffc86a5c497b885e6ae06b27db2` |
| `ExcalidrawDrawing.cs` | `487b2bbb9935741388c226c76bd75bd6` |
| `ExcalidrawIcon.png` | `13a8b3acf3e834703bd1ca8e9f1bdec1` |
| `ExcalidrawImporter.cs` | `259805e835df04904bb3138c8785f785` |
| `ExcalidrawImporterEditor.cs` | `3974659ae2c33408ca1c63ffe8d7f7cb` |
| `InspectorHost.cs` | `3239041e120144349f7b5c09f7e18a5e` |
| `MarkdownInspector.cs` | `d5c2b38715a78430296daa90a94c0e81` |
| `MarkdownParser.cs` | `31a620d14968247cdbf06798f81c2ecd` |
| `MarkdownTextAssetEditor.cs` | `4cb85c658037444d8a61794a15913035` |
| `ObsidianCanvasImporter.cs` | `8f7178e0b0704e089221a536add2757e` |

Remove the project copy, update the package pin and add `UCT_DOCUMENTATION` in the same change. Let Unity resolve the package after the duplicate files are removed.

## Validation

Use the existing Jenkins admission route for builds and tests. The optional `UnityCursorToolkit.Documentation.Editor.Tests` assembly uses the existing Unity Test Framework when installed. It is excluded unless `UCT_DOCUMENTATION` is enabled. It covers parser errors, bounds, path traversal and source lookup from the installed package.

Check both module states in an isolated project:

1. With `UCT_DOCUMENTATION` absent, compile and confirm native `.txt`/`.json` Inspectors and no Toolkit `.canvas`/`.excalidraw` importers.
2. Enable `UCT_DOCUMENTATION`, compile and run the documentation EditMode tests.
3. Import native `.excalidraw` and `.canvas` fixtures from `Assets` and an installed package. Inspect `AssetImporter.GetAtPath` and the imported object. A `DefaultImporter` header in a `.meta` file alone does not identify the importer that executed.
4. Change linked Markdown and image files, then add a previously missing linked file. Confirm reimport and view refresh.
5. Check pan, pointer zoom, fit, clipping, text, lines and image placeholders. Confirm `.txt`, `.json` and multiple selections still delegate to Unity's native Inspector.
6. Repeat on the oldest supported Unity version and the consumer's Unity version. Source/API review does not replace compilation or visual proof.

The Python writer has separate usage and preservation checks in [`Tools~/README.md`](../Packages/com.rankupgames.unity-cursor-toolkit/Tools~/README.md).
