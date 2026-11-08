# Unity search palette

[Paper design](https://app.paper.design/file/01M6VWGPYYW3N8FF45HW945674)

| Page | Contents |
| --- | --- |
| Page 1 | Tokens, search field, result rows, and interaction states |
| Reference | Feature brief and source boundaries |
| Final screens | Palette in the Unity Editor and result action menu |

The approved concept is implemented in
`Packages/com.rankupgames.unity-cursor-toolkit/Editor/Spotlight/`.

| Paper frame | Owner |
| --- | --- |
| Parts and Palette states | `SpotlightWindow.cs` |
| Palette in Editor and result actions | `SpotlightWindow.cs` |
| Result identity and actions | `SpotlightResult.cs` |
| Search sources and version boundary | `SpotlightSearch.cs` |

`SpotlightUnitySearch.cs` contains the public Unity Search API adapter for
Unity 2021.2 and later. The window and result actions have no Search API dependency.

Use Unity Editor IMGUI with custom style values from Paper, native Unity icons,
and the Unity Shortcuts manager. No CSS framework or additional package is needed.

The feature is original toolkit code under the package's MIT license.
Unity reference source is not an implementation source for redistribution.
