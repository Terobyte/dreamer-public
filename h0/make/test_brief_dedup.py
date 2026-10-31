"""Red: duplicate cast `who` / place `id` must fail validation (seed mode)."""
import copy
import unittest
import urllib.request
from unittest import mock

from make import brief


def _good():
    return {
        'title': 'Attic', 'mode': 'seed', 'book': None, 'style': 'warm gouache',
        'places': [{'id': 'attic', 'type': 'room', 'size_m': [5, 4], 'level': 0, 'next_to': [],
                    'query': 'attic', 'provider_hint': 'commons', 'fandom_wiki': None}],
        'cast': [{'who': 'Anna', 'sex': 'female', 'age': 'adult', 'look': 'tall', 'voice': 'woman', 'query': 'woman'}],
        'scene': {'where': 'attic', 'who': ['Anna'], 'want': 'find the trunk'},
    }


class DedupRedTest(unittest.TestCase):
    def setUp(self):
        p = mock.patch.object(urllib.request, 'urlopen', side_effect=AssertionError('network'))
        p.start()
        self.addCleanup(p.stop)

    def test_dup_cast_who_rejected(self):
        b = _good()
        b['cast'] = [copy.deepcopy(b['cast'][0]), copy.deepcopy(b['cast'][0])]
        self.assertTrue(brief.validate(b), 'duplicate cast who must fail')

    def test_dup_place_id_rejected(self):
        b = _good()
        b['places'] = [copy.deepcopy(b['places'][0]), copy.deepcopy(b['places'][0])]
        self.assertTrue(brief.validate(b), 'duplicate place id must fail')


if __name__ == '__main__':
    unittest.main()
