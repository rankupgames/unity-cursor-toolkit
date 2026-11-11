# Excalidraw writer

`excalidraw_writer.py` builds native Excalidraw JSON with Python 3.8 or newer. It uses only the standard library. Unity ignores this `Tools~` folder.

An adapter owns its data source, palette, labels and element identities. The writer owns layout and regeneration. It does not scan source code or require a database SDK.

## Library

```python
import json
from pathlib import Path
from excalidraw_writer import ExcalidrawWriter

output = Path('drawing.excalidraw')
previous = json.loads(output.read_text(encoding='utf-8')) if output.exists() else None
writer = ExcalidrawWriter(previous, generator='example', colors={'card': '#d0ebff'})
y = writer.frame('overview', 'Overview', 0)
writer.card('source', 'overview', 40, y, ['Source'], 'card')
writer.card('target', 'overview', 400, y, ['Target'], 'card')
writer.arrow('source-target', 'source', 'target', inferred=False)
writer.write(output)
```

Add `Tools~` to the adapter's import search path, or load the file with `importlib.util.spec_from_file_location`. Accept the installed package location as an argument. Resolve Git and registry packages through Unity's `PackageInfo.resolvedPath`. `Packages/<name>` is a logical Unity path and can differ from the physical location.

| API | Purpose |
|---|---|
| `ExcalidrawWriter(document=None, *, generator, colors=None)` | Start from a previous document or an empty document. |
| `element(identity, kind, frame, x, y, width, height, **extra)` | Add one element. The caller owns its stable identity. |
| `text(identity, frame, x, y, lines, size=16, group=())` | Add monospace text. |
| `card(identity, frame, x, y, lines, color)` | Add a box and text. `color` names a palette entry. Return width and height. |
| `shelf(frame, x, y, cards, limit=4200)` | Arrange `(identity, lines, color)` cards. Return the next row position. |
| `arrow(identity, source, target, inferred=False)` | Connect card identities after layout. Inferred arrows are dashed. |
| `frame(identity, name, top)` | Start a named frame. Return the first content position. |
| `document()` | Return the complete document without changing the builder or input. |
| `write(path)` | Validate and serialize the document before opening the output file. |

Keep the same generator marker, identities and palette when moving an adapter to this library. The geometry constants and JSON field order retain the extracted writer's layout.

## CLI

```sh
python3 excalidraw_writer.py --layout layout.json --output drawing.excalidraw
```

A layout contains a generator marker, optional colors, and named operations:

```json
{
  "generator": "example",
  "colors": {"card": "#d0ebff"},
  "operations": [
    {"op": "frame", "identity": "overview", "name": "Overview", "top": 0},
    {"op": "card", "identity": "source", "frame": "overview", "x": 40, "y": 90, "lines": ["Source"], "color": "card"}
  ]
}
```

Allowed operations are `element`, `text`, `card`, `shelf`, `arrow` and `frame`. Each operation uses the library method's named arguments. Malformed JSON, duplicate IDs or properties, missing card references, unknown frames, negative sizes and non-finite values fail before output replacement.

## Regeneration

- Generated elements carry `customData.generator` and their generated position in `customData.home`.
- Generated elements moved by hand keep their position. Their generated content refreshes.
- Manual elements, including notes, arrows and images, remain unchanged. Back references from generated elements to manual labels and arrows remain.
- Existing `appState`, `files` payloads and unknown top-level document fields remain unchanged.
- Deleted generated elements regenerate. This preserves the extracted behavior.
- The writer preserves embedded image payloads. The native Unity Excalidraw preview does not decode them.

## Regression checks

Run on the project's admitted worker:

```sh
python3 -B -m unittest discover -s Packages/com.rankupgames.unity-cursor-toolkit/Tools~/tests -v
```

The cases cover byte-stable reruns, moved cards, manual notes and bindings, embedded image payloads, deleted items, malformed inputs and CLI failure without output changes.
