"""Red: F13 duplicate cast hidden by dict, F14 scene.who not linked to cast."""
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
    return book, scene, {
        'title': 'Lawn', 'mode': 'book',
        'book': {'dir': str(DREAM / 'books' / 'gwtw'), 'scene': 'lawn'},
        'style': 'warm gouache',
        'places': [{'id': 'lawn', 'type': 'yard', 'size_m': [20, 15], 'level': 0, 'next_to': [],
                    'query': 'lawn', 'provider_hint': 'commons', 'fandom_wiki': None}],
        'cast': [{'who': n, 'sex': sexes[book['cast'][n]['sex']], 'age': 'adult', 'look': 'x',
                  'voice': 'man', 'query': 'q'} for n in scene['cast']],
        'scene': {'where': 'lawn', 'who': list(scene['cast']), 'want': 'talk'},
    }


class RedTest(unittest.TestCase):
    def setUp(self):
        p = mock.patch.object(urllib.request, 'urlopen', side_effect=AssertionError('network'))
        p.start()
        self.addCleanup(p.stop)

    def test_f13_dup_wrong_sex_first_rejected(self):
        _, _, b = book_good()
        dup = dict(next(c for c in b['cast'] if c['who'] == 'Rhett Butler'))
        dup['sex'] = 'female'
        b['cast'] = [dup] + b['cast']
        b['scene']['who'] = [c['who'] for c in b['cast']]
        self.assertTrue(brief.validate(b), 'dup Rhett with wrong sex must fail')

    def test_f13_dup_name_rejected(self):
        _, _, b = book_good()
        b['cast'] = b['cast'] + [dict(b['cast'][0])]
        b['scene']['who'] = [c['who'] for c in b['cast']]
        self.assertTrue(brief.validate(b), 'duplicate cast name must fail')

    def test_f14_ghost_in_scene_who_rejected(self):
        _, _, b = book_good()
        b['scene']['who'] = list(b['scene']['who']) + ['Unlisted Ghost']
        self.assertTrue(brief.validate(b), 'ghost in scene.who must fail')


if __name__ == '__main__':
    unittest.main()
