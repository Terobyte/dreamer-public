"""Red tests for brief gaps F8/F9/F10 (player round, minimal)."""
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


class GapsRedTest(unittest.TestCase):
    def setUp(self):
        p = mock.patch.object(urllib.request, 'urlopen', side_effect=AssertionError('network'))
        p.start()
        self.addCleanup(p.stop)

    def test_f8_where_must_match_place(self):
        b = _good()
        b['scene']['where'] = 'basement'
        self.assertTrue(brief.validate(b), 'where basement with only place attic must fail')

    def test_f9_cast_query_null_rejected_place_null_ok(self):
        b = _good()
        b['places'][0]['query'] = None
        self.assertEqual(brief.validate(b), [])
        b2 = _good()
        b2['cast'][0]['query'] = None
        self.assertTrue(brief.validate(b2), 'cast query null must fail')

    def test_f10_id_trailing_newline_rejected(self):
        b = _good()
        b['places'][0]['id'] = 'attic\n'
        b['scene']['where'] = 'attic\n'
        self.assertTrue(brief.validate(b), 'id with trailing newline must fail')


if __name__ == '__main__':
    unittest.main()
