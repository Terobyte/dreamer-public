"""Book scenes carry their own reference pictures (storyboard); refs stage must use them, not the web."""
import json
import tempfile
import unittest
from pathlib import Path

from make import refs
from make.test_refs import png


def empty_providers():
    none = lambda q, n: []  # noqa: E731 - a private book is not on the web
    return {'commons': none, 'openverse': none, 'tavily': none}


class BookLocalRefs(unittest.TestCase):
    def test_local_pictures_become_kept_refs_with_cues(self):
        with tempfile.TemporaryDirectory() as t:
            t = Path(t)
            pic = t / 'board.png'
            pic.write_bytes(png(600, 600))
            brief = {'places': [{'id': 'bedroom', 'query': 'Mirai bedroom', 'provider_hint': 'any'}], 'cast': []}
            out = t / 'out'
            out.mkdir()
            slots = refs.run_refs(brief, out, providers=empty_providers(), loader=lambda u: b'',
                                  local={'bedroom': ([pic], 'wooden bed with round knobs')})
            self.assertTrue((out / 'bedroom' / '0.png').is_file())
            self.assertTrue(any(c['kept'] for c in slots['bedroom']))
            self.assertIn('wooden bed with round knobs', (out / 'cues.md').read_text())

    def test_book_scene_refs_resolved_from_book_json(self):
        with tempfile.TemporaryDirectory() as t:
            t = Path(t)
            book = t / 'books' / 'b'
            (book / 'refs').mkdir(parents=True)
            (book / 'refs' / 's.png').write_bytes(png(600, 600))
            (book / 'book.json').write_text(json.dumps({'chapters': [{'scenes': [
                {'id': 'bedroom', 'refs': ['refs/s.png'], 'ref_cues': 'peach window'}]}]}))
            brief = {'book': {'dir': str(book), 'scene': 'bedroom'}, 'places': [{'id': 'bedroom'}]}
            local = refs.book_local(brief, base=t)
            self.assertEqual(local['bedroom'][0], [book / 'refs' / 's.png'])
            self.assertEqual(local['bedroom'][1], 'peach window')


if __name__ == '__main__':
    unittest.main()
