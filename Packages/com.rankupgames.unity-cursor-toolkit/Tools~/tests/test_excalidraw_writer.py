"""Regeneration contracts. Run with python3 -B -m unittest discover -s this_directory -v."""
import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from excalidraw_writer import ExcalidrawWriter


def layout(previous=None):
    writer = ExcalidrawWriter(previous, generator='fixture', colors={'card': '#ffffff'})
    for frame in ('first', 'second'):
        y = writer.frame(frame, frame, 0)
        writer.shelf(frame, 40, y, [(frame + '-card', ['card'], 'card')])
    writer.arrow('connection', 'first-card', 'second-card', True)
    return writer


def serialize(document):
    return json.dumps(document, indent=1, ensure_ascii=False, allow_nan=False) + '\n'


class WriterTests(unittest.TestCase):
    def test_fresh_and_rerun_bytes_match_and_input_stays_unchanged(self):
        writer = layout()
        first = writer.document()
        self.assertEqual(first, writer.document(), 'document() must not append a second set of frames')
        before = copy.deepcopy(first)
        second = layout(first).document()
        self.assertEqual(serialize(first), serialize(second))
        self.assertEqual(first, before)
        by_id = {item['id']: item for item in first['elements']}
        self.assertEqual([40, 90], by_id['first-card-box']['customData']['home'])
        self.assertGreater(by_id['second-card-box']['y'], by_id['first-card-box']['y'])
        self.assertEqual('dashed', by_id['connection']['strokeStyle'])
        self.assertEqual('arrow', by_id['connection']['endArrowhead'])

    def test_manual_moves_notes_arrows_bindings_images_and_document_fields_survive(self):
        previous = layout().document()
        by_id = {item['id']: item for item in previous['elements']}
        moved = by_id['second-card-box']
        moved['x'] += 33
        moved['y'] += 47
        moved['boundElements'] = [{'id': 'manual-arrow', 'type': 'arrow'}, {'id': 'note', 'type': 'text'}]
        note = {'id': 'note', 'type': 'text', 'x': 80, 'y': 150, 'width': 90, 'height': 20,
                'frameId': 'first', 'text': 'Manual note', 'containerId': moved['id']}
        arrow = {'id': 'manual-arrow', 'type': 'arrow', 'x': 0, 'y': 0, 'width': 1, 'height': 1,
                 'startBinding': {'elementId': moved['id'], 'focus': 0, 'gap': 1}, 'points': [[0, 0], [1, 1]]}
        image = {'id': 'manual-image', 'type': 'image', 'x': 5, 'y': 5, 'width': 3, 'height': 3, 'fileId': 'image-file'}
        previous['elements'].extend([note, arrow, image])
        previous['files'] = {'image-file': {'id': 'image-file', 'mimeType': 'image/png', 'dataURL': 'data:image/png;base64,cGl4ZWw='}}
        previous['appState'] = {'gridSize': 20, 'viewBackgroundColor': '#123456', 'scrollX': 99, 'zoom': {'value': 1.5}}
        previous['customField'] = {'nested': ['retained']}
        result = layout(previous).document()
        after = {item['id']: item for item in result['elements']}
        for field in ('x', 'y', 'boundElements'):
            self.assertEqual(moved[field], after[moved['id']][field])
        for item in (note, arrow, image):
            self.assertEqual(item, after[item['id']])
        for field in ('files', 'appState', 'customField'):
            self.assertEqual(previous[field], result[field])
        self.assertEqual(serialize(result), serialize(layout(result).document()))

    def test_deleted_generated_items_regenerate_but_deleted_manual_items_stay(self):
        previous = layout().document()
        previous['elements'][0]['isDeleted'] = True
        deleted = {'id': 'deleted-note', 'type': 'text', 'x': 0, 'y': 0, 'width': 0, 'height': 0, 'isDeleted': True}
        previous['elements'].append(deleted)
        result = {item['id']: item for item in layout(previous).document()['elements']}
        self.assertFalse(result[previous['elements'][0]['id']]['isDeleted'])
        self.assertEqual(deleted, result['deleted-note'])

    def test_malformed_previous_documents_fail(self):
        document = layout().document()
        bad_documents = [[], {'type': 'other', 'elements': []}, {'type': 'excalidraw'},
                         {**document, 'elements': [document['elements'][0]] * 2},
                         {**document, 'files': []}, {**document, 'appState': None}]
        for invalid in bad_documents:
            with self.subTest(invalid=invalid):
                with self.assertRaises(ValueError):
                    layout(invalid)
        for field, value in (('x', float('nan')), ('y', float('inf')), ('width', -1), ('height', '2'),
                             ('id', ''), ('frameId', []), ('customData', []), ('boundElements', [1]), ('isDeleted', 'yes')):
            invalid = copy.deepcopy(document)
            invalid['elements'][0][field] = value
            with self.subTest(field=field):
                with self.assertRaises(ValueError):
                    layout(invalid)

    def test_generated_identity_collisions_and_unknown_references_fail(self):
        writer = layout()
        with self.assertRaises(ValueError):
            writer.text('first-title', 'first', 0, 0, ['duplicate'])
        previous = layout().document()
        previous['elements'].append({'id': 'collision', 'type': 'text', 'x': 0, 'y': 0, 'width': 1, 'height': 1})
        with self.assertRaises(ValueError):
            layout(previous).text('collision', None, 0, 0, ['manual id'])
        writer = layout()
        writer.arrow('unknown', 'missing', 'first-card')
        with self.assertRaises(ValueError):
            writer.document()
        writer = layout()
        writer.text('orphan', 'missing-frame', 0, 0, ['missing'])
        with self.assertRaises(ValueError):
            writer.document()
        writer = layout()
        writer.arrow('connection', 'first-card', 'second-card')
        with self.assertRaises(ValueError):
            writer.document()

    def test_generated_nonfinite_and_wrong_values_fail(self):
        for x in (float('inf'), float('nan'), True, '12'):
            with self.subTest(x=x):
                with self.assertRaises(ValueError):
                    layout().element('bad', 'rectangle', None, x, 0, 1, 1)
        with self.assertRaises(ValueError):
            layout().text('bad', None, 0, 0, [])
        with self.assertRaises(ValueError):
            layout().card('bad', None, 0, 0, ['color'], 'missing')
        with self.assertRaises(ValueError):
            layout().element('bad', 'rectangle', None, 0, 0, -1, 1)

    def test_cli_rerun_and_failure_do_not_replace_existing_bytes(self):
        script = str(Path(__file__).resolve().parents[1] / 'excalidraw_writer.py')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, output = root / 'layout.json', root / 'drawing.excalidraw'
            plan = {'generator': 'fixture', 'operations': [
                {'op': 'frame', 'identity': 'frame', 'name': 'Example', 'top': 0},
                {'op': 'text', 'identity': 'label', 'frame': 'frame', 'x': 40, 'y': 90, 'lines': ['Example']}]}
            source.write_text(json.dumps(plan), encoding='utf-8')
            command = [sys.executable, '-B', script, '--layout', str(source), '--output', str(output)]
            first = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(0, first.returncode, first.stderr)
            initial = output.read_bytes()
            self.assertEqual(0, subprocess.run(command, capture_output=True).returncode)
            self.assertEqual(initial, output.read_bytes())
            for bad in ('{"generator":"a","generator":"b","operations":[]}',
                        '{"generator":"fixture","operations":[{"op":"delete"}]}',
                        '{"generator":"fixture","operations":[{"op":"frame"}]}',
                        '{"generator":"fixture","operations":"bad"}', '{'):
                source.write_text(bad, encoding='utf-8')
                self.assertNotEqual(0, subprocess.run(command, capture_output=True).returncode)
                self.assertEqual(initial, output.read_bytes())


if __name__ == '__main__':
    unittest.main()
