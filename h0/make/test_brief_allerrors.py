"""Red: validate reports scene AND book errors together (no short-circuit)."""
import json
import unittest
import urllib.request
from pathlib import Path
from unittest import mock

from make import brief

DREAM = Path(brief.__file__).resolve().parents[1] / 'dream'


def book_good():
    with open(DREAM / 'books' / 'gwtw' / 'book.json', encoding='utf-8') as f:
        book = json.load(f)
    scene = next(s for ch in book['chapters'] for s in ch['scenes'] if s['id'] == 'lawn')
    sexes = {'woman': 'female', 'man': 'male'}
    return {
        'title': 'Lawn', 'mode': 'book',
        'book': {'dir': str(DREAM / 'books' / 'gwtw'), 'scene': 'lawn'},
        'style': 'warm gouache',
        'places': [{'id': 'lawn', 'type': 'yard', 'size_m': [20, 15], 'level': 0, 'next_to': [],
                    'query': 'lawn', 'provider_hint': 'commons', 'fandom_wiki': None}],
        'cast': [{'who': n, 'sex': sexes[book['cast'][n]['sex']], 'age': 'adult', 'look': 'x',
                  'voice': 'man', 'query': 'q'} for n in scene['cast']],
        'scene': {'where': 'lawn', 'who': list(scene['cast']), 'want': 'talk'},
    }


class AllErrorsTest(unittest.TestCase):
    def setUp(self):
        p = mock.patch.object(urllib.request, 'urlopen', side_effect=AssertionError('network'))
        p.start()
        self.addCleanup(p.stop)

    def test_scene_and_book_errors_together(self):
        b = book_good()
        b['scene']['where'] = 'attic'  # scene error: no such place
        next(c for c in b['cast'] if c['who'] == 'Rhett Butler')['sex'] = 'female'  # book error
        errs = brief.validate(b)
        self.assertTrue(any('attic' in e for e in errs), errs)
        self.assertTrue(any('Rhett Butler' in e and 'sex' in e for e in errs), errs)


if __name__ == '__main__':
    unittest.main()
