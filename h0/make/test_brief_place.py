"""Red: book place must match book.json scene description (F12/F16/F19, minimal)."""
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


class PlaceRedTest(unittest.TestCase):
    def setUp(self):
        p = mock.patch.object(urllib.request, 'urlopen', side_effect=AssertionError('network'))
        p.start()
        self.addCleanup(p.stop)

    def test_lawn_room_attic_rejected(self):
        b = book_good()
        b['places'][0]['type'] = 'room'
        b['places'][0]['query'] = 'attic bedroom'
        self.assertTrue(brief.validate(b), 'lawn as room/attic bedroom must fail')


if __name__ == '__main__':
    unittest.main()
