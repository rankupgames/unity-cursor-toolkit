#!/usr/bin/env python3
"""Provider-neutral Excalidraw layout and regeneration. Python 3.8+, standard library only.

Library: ExcalidrawWriter(existing_document, generator='your-generator', colors=palette).
CLI: excalidraw_writer.py --layout layout.json --output drawing.excalidraw
The layout contains generator, colors and operations (frame, text, card, shelf, arrow,
or element). Each operation supplies method arguments as named JSON fields.
"""
import argparse
import copy
import json
import math
from pathlib import Path
import zlib

CHAR, LINE, PAD, GAP = 9.7, 20, 12, 28


def _finite(value):
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError('The document contains a non-finite number. No output was changed.')
    if isinstance(value, dict):
        for item in value.values():
            _finite(item)
    elif isinstance(value, (list, tuple)):
        for item in value:
            _finite(item)


def _number(value, name):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or (isinstance(value, float) and not math.isfinite(value)):
        raise ValueError(f'{name} must be a finite number.')
    return value


def _identity(value):
    if not isinstance(value, str) or not value.strip():
        raise ValueError('An element identity must be a non-empty string.')


def _unique_object(pairs):
    result = {}
    for name, value in pairs:
        if name in result:
            raise ValueError(f'Duplicate JSON property: {name}. No output was changed.')
        result[name] = value
    return result


def _read_json(path):
    return json.loads(path.read_text(encoding='utf-8'), object_pairs_hook=_unique_object)


def _validate_document(document):
    if not isinstance(document, dict) or document.get('type') != 'excalidraw':
        raise ValueError('The file is not an Excalidraw document. No output was changed.')
    elements = document.get('elements')
    if not isinstance(elements, list):
        raise ValueError('The document elements must be an array.')
    identities = set()
    for item in elements:
        if not isinstance(item, dict):
            raise ValueError('Each element must be an object.')
        _identity(item.get('id'))
        if item['id'] in identities:
            raise ValueError(f'Duplicate element identity: {item["id"]}. No output was changed.')
        identities.add(item['id'])
        _identity(item.get('type'))
        if item.get('frameId') is not None:
            _identity(item['frameId'])
        if 'isDeleted' in item and not isinstance(item['isDeleted'], bool):
            raise ValueError(f'{item["id"]}.isDeleted must be a boolean.')
        for field in ('x', 'y', 'width', 'height'):
            _number(item.get(field), f'{item["id"]}.{field}')
        if item['width'] < 0 or item['height'] < 0:
            raise ValueError(f'{item["id"]}: sizes must not be negative.')
        if item.get('customData') is not None and not isinstance(item['customData'], dict):
            raise ValueError(f'{item["id"]}.customData must be an object or null.')
        bound = item.get('boundElements')
        if bound is not None and (not isinstance(bound, list) or any(
                not isinstance(ref, dict) or not isinstance(ref.get('id'), str) for ref in bound)):
            raise ValueError(f'{item["id"]}.boundElements must be an array of references or null.')
    for field in ('appState', 'files'):
        if field in document and not isinstance(document[field], dict):
            raise ValueError(f'{field} must be an object.')
    _finite(document)


class ExcalidrawWriter:
    """Own only elements marked with generator; preserve all other document data.

    Supply the same generator and identities on every run. Deleted generated elements
    regenerate. Manually moved generated elements retain their position. Manual elements,
    bindings to them, files, appState and unknown top-level fields survive regeneration.
    """

    def __init__(self, document=None, *, generator, colors=None):
        _identity(generator)
        self.generator = generator
        if colors is not None and (not isinstance(colors, dict) or any(
                not isinstance(name, str) or not isinstance(value, str) for name, value in colors.items())):
            raise ValueError('Colors must be an object mapping names to color strings.')
        self.colors = dict(colors) if colors is not None else {}
        self.previous = copy.deepcopy(document) if document is not None else {}
        if document is not None:
            _validate_document(self.previous)
        self.old = {item['id']: item for item in self.previous.get('elements', [])}
        for item in self.old.values():
            data = item.get('customData') or {}
            if data.get('generator') == generator and data.get('home') is not None:
                home = data['home']
                if not isinstance(home, list) or len(home) != 2:
                    raise ValueError(f'{item["id"]}: home must be a pair of coordinates.')
                for coordinate in home:
                    _number(coordinate, 'home coordinate')
        self.kept = [item for item in self.old.values()
                     if (item.get('customData') or {}).get('generator') != generator]
        self.kept_ids = {item['id'] for item in self.kept}
        self.frames, self.order, self.boxes, self.pending, self.moved = {None: []}, [], {}, [], set()
        self.identities = set(self.kept_ids)

    def element(self, identity, kind, frame, x, y, width, height, **extra):
        _identity(identity)
        if identity in self.identities:
            raise ValueError(f'Duplicate element identity: {identity}. No output was changed.')
        if not isinstance(kind, str) or not kind:
            raise ValueError('An element type must be a non-empty string.')
        if frame is not None:
            _identity(frame)
        for name, value in (('x', x), ('y', y), ('width', width), ('height', height)):
            _number(value, name)
        if width < 0 or height < 0:
            raise ValueError('Element sizes must not be negative.')
        if {'id', 'type', 'x', 'y', 'width', 'height', 'frameId', 'customData'} & extra.keys():
            raise ValueError('Extra fields must not replace element identity, geometry or ownership.')
        _finite(extra)
        self.identities.add(identity)
        seed = zlib.crc32(identity.encode())
        home = [round(x), round(y)]
        before = self.old.get(identity)
        if before and not before.get('isDeleted') and (before.get('customData') or {}).get('home') not in (None, [before['x'], before['y']]):
            x, y = before['x'], before['y']
            self.moved.add(identity)
        bound = [ref for ref in (before or {}).get('boundElements') or [] if ref.get('id') in self.kept_ids] or None
        item = {'id': identity, 'type': kind, 'x': round(x), 'y': round(y), 'width': round(width), 'height': round(height),
                'angle': 0, 'strokeColor': '#1e1e1e', 'backgroundColor': 'transparent', 'fillStyle': 'solid',
                'strokeWidth': 1, 'strokeStyle': 'solid', 'roughness': 0, 'opacity': 100, 'groupIds': [],
                'frameId': frame, 'roundness': None, 'seed': seed, 'version': 1, 'versionNonce': seed, 'isDeleted': False,
                'boundElements': bound, 'updated': 1, 'link': None, 'locked': False,
                'customData': {'generator': self.generator, 'home': home}, **extra}
        self.frames.setdefault(frame, []).append(item)
        return item

    def text(self, identity, frame, x, y, lines, size=16, group=()):
        self._lines(lines)
        _number(size, 'font size')
        if size <= 0:
            raise ValueError('Font size must be positive.')
        content = '\n'.join(lines)
        return self.element(identity, 'text', frame, x, y, max(map(len, lines)) * CHAR * size / 16, len(lines) * LINE * size / 16,
                            text=content, originalText=content, fontSize=size, fontFamily=3, textAlign='left', verticalAlign='top',
                            containerId=None, lineHeight=1.25, autoResize=True, groupIds=list(group))

    @staticmethod
    def _lines(lines):
        if not isinstance(lines, (list, tuple)) or not lines or any(not isinstance(line, str) for line in lines):
            raise ValueError('Text lines must be a non-empty array of strings.')

    def card(self, identity, frame, x, y, lines, color):
        _identity(identity)
        self._lines(lines)
        if color not in self.colors:
            raise ValueError(f'Unknown palette color: {color}.')
        width, height = max(map(len, lines)) * CHAR + 2 * PAD, len(lines) * LINE + 2 * PAD
        self.boxes[identity] = self.element(identity + '-box', 'rectangle', frame, x, y, width, height,
                                            backgroundColor=self.colors[color], roundness={'type': 3}, groupIds=[identity])
        self.text(identity + '-text', frame, x + PAD, y + PAD, lines, group=[identity])
        return width, height

    def shelf(self, frame, x, y, cards, limit=4200):
        """Place cards left to right in rows. Return the y below the last row."""
        _number(x, 'shelf x')
        _number(y, 'shelf y')
        _number(limit, 'shelf limit')
        if limit <= 0:
            raise ValueError('Shelf limit must be positive.')
        left, row = x, 0
        for identity, lines, color in cards:
            self._lines(lines)
            width = max(map(len, lines)) * CHAR + 2 * PAD
            if left > x and left + width > x + limit:
                left, y, row = x, y + row + GAP, 0
            _, height = self.card(identity, frame, left, y, lines, color)
            left, row = left + width + GAP, max(row, height)
        return y + row + GAP

    def arrow(self, identity, source, target, inferred=False):
        for value in (identity, source, target):
            _identity(value)
        if not isinstance(inferred, bool):
            raise ValueError('inferred must be a boolean.')
        self.pending.append((identity, source, target, inferred))

    def _draw(self, identity, source, target, inferred):
        if source not in self.boxes or target not in self.boxes:
            raise ValueError(f'Arrow {identity}: source and target must name generated cards.')
        a, b = self.boxes[source], self.boxes[target]
        x, y = a['x'] + a['width'] / 2, a['y'] + a['height']
        if b['y'] < y:
            x, y = (a['x'] + a['width'], a['y'] + a['height'] / 2) if b['x'] > a['x'] else (a['x'], a['y'] + a['height'] / 2)
        dx, dy = b['x'] + b['width'] / 2 - x, (b['y'] if b['y'] >= y else b['y'] + b['height']) - y
        item = self.element(identity, 'arrow', None, x, y, abs(dx), abs(dy), points=[[0, 0], [round(dx), round(dy)]],
                            lastCommittedPoint=None, startBinding=None, endBinding=None, startArrowhead=None, endArrowhead='arrow',
                            elbowed=False, strokeStyle='dashed' if inferred else 'solid', opacity=60)
        item['x'], item['y'] = round(x), round(y)

    def frame(self, identity, name, top):
        _identity(identity)
        _number(top, 'frame top')
        if any(identity == entry[0] for entry in self.order):
            raise ValueError(f'Duplicate frame identity: {identity}.')
        self.order.append((identity, name))
        self.text(identity + '-title', identity, 40, top + 30, [name], size=28)
        return top + 90

    def document(self):
        """Return a new document without changing this builder or the input document."""
        return copy.deepcopy(self)._build_document()

    def _build_document(self):
        elements, top = [], 0
        frame_ids = dict(self.order)
        if set(self.frames) - {None} - set(frame_ids):
            raise ValueError('An element names a frame that was not declared.')
        for identity, name in self.order:
            children = self.frames[identity]
            for child in children:
                if child['id'] not in self.moved:
                    child['y'] += top
                child['customData']['home'][1] += top
            members = children + [item for item in self.kept if item.get('frameId') == identity]
            x0, y0 = min(e['x'] for e in members) - 40, min(e['y'] for e in members) - 30
            x1, y1 = max(e['x'] + e['width'] for e in members) + 40, max(e['y'] + e['height'] for e in members) + 40
            elements += members
            elements.append({**self.element(identity, 'frame', None, x0, y0, x1 - x0, y1 - y0, name=name), 'x': round(x0), 'y': round(y0)})
            top = max(top, y1) + 200
        for request in self.pending:
            self._draw(*request)
        # Include unframed elements as well as arrows. Frames were already emitted above.
        elements += [item for item in self.kept if item.get('frameId') not in frame_ids]
        elements += [item for item in self.frames[None] if item['id'] not in frame_ids]
        result = {**self.previous, 'type': 'excalidraw', 'version': 2, 'source': 'https://excalidraw.com', 'elements': elements,
                  'appState': self.previous.get('appState', {'gridSize': None, 'viewBackgroundColor': '#ffffff'}),
                  'files': self.previous.get('files', {})}
        _validate_document(result)
        return result

    def write(self, path):
        """Validate and serialize completely before opening the selected output file."""
        content = json.dumps(self.document(), indent=1, ensure_ascii=False, allow_nan=False) + '\n'
        Path(path).write_text(content, encoding='utf-8')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--layout', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    try:
        layout = _read_json(args.layout)
        if not isinstance(layout, dict) or set(layout) - {'generator', 'colors', 'operations'}:
            raise ValueError('The layout must contain generator, optional colors and operations only.')
        if not isinstance(layout.get('operations'), list):
            raise ValueError('Layout operations must be an array.')
        previous = _read_json(args.output) if args.output.exists() else None
        writer = ExcalidrawWriter(previous, generator=layout['generator'], colors=layout.get('colors'))
        for operation in layout['operations']:
            if not isinstance(operation, dict) or operation.get('op') not in ('frame', 'text', 'card', 'shelf', 'arrow', 'element'):
                raise ValueError('Each operation must name frame, text, card, shelf, arrow or element.')
            arguments = {name: value for name, value in operation.items() if name != 'op'}
            getattr(writer, operation['op'])(**arguments)
        writer.write(args.output)
    except (OSError, ValueError, TypeError, KeyError) as error:
        parser.exit(1, f'{error}\n')


if __name__ == '__main__':
    main()
