"""Red tests for brief contract gaps F1-F6 (player round, minimal)."""
import json
import math
import tempfile
import unittest
import urllib.request
from pathlib import Path
from unittest import mock

from make import brief
from make import core


def _good():
    return {
        'title': 'Attic', 'mode': 'seed', 'book': None, 'style': 'warm gouache',
        'places': [{'id': 'attic', 'type': 'room', 'size_m': [5, 4], 'level': 0, 'next_to': [],
                    'query': 'attic', 'provider_hint': 'commons', 'fandom_wiki': None}],
        'cast': [{'who': 'Anna', 'sex': 'female', 'age': 'adult', 'look': 'tall', 'voice': 'woman', 'query': 'woman'}],
        'scene': {'where': 'attic', 'who': ['Anna'], 'want': 'find the trunk'},
    }


class ContractRedTest(unittest.TestCase):
    def setUp(self):
        p = mock.patch.object(urllib.request, 'urlopen', side_effect=AssertionError('network'))
        p.start()
        self.addCleanup(p.stop)

    def test_f1_fake_run_writes_brief_json(self):
        with tempfile.TemporaryDirectory() as t:
            res = core.run_make(Path(t), 'Jane meets Rochester in Thornfield library',
                                only='brief', fake=True)
            self.assertEqual(res.get('brief'), 'ran')
            self.assertTrue((Path(t) / 'brief' / 'brief.json').is_file())

    def test_f2_book_place_mismatch_rejected(self):
        b = _good()
        dream = Path(brief.__file__).resolve().parents[1] / 'dream'
        with open(dream / 'books' / 'gwtw' / 'book.json', encoding='utf-8') as f:
            book = json.load(f)
        scene = next(s for ch in book['chapters'] for s in ch['scenes'] if s['id'] == 'lawn')
        sexes = {'woman': 'female', 'man': 'male'}
        b['mode'] = 'book'
        b['book'] = {'dir': str(dream / 'books' / 'gwtw'), 'scene': 'lawn'}
        b['cast'] = [{'who': n, 'sex': sexes[book['cast'][n]['sex']], 'age': 'adult', 'look': 'x',
                      'voice': 'man', 'query': 'q'} for n in scene['cast']]
        b['scene']['who'] = [c['who'] for c in b['cast']]
        # unrelated place stays attic while book scene is lawn -> must fail
        b['places'][0]['id'] = 'attic'
        b['scene']['where'] = 'attic'
        errs = brief.validate(b)
        self.assertTrue(errs, 'unrelated place must not validate for book scene lawn')

    def test_f3_personal_place_query_null_ok(self):
        b = _good()
        b['places'][0]['query'] = None
        self.assertEqual(brief.validate(b), [])

    def test_f4_exhausted_scenario_is_brief_failed(self):
        fake = brief.ScenarioBrief(['not json'])
        with self.assertRaises(brief.BriefFailed):
            brief.make_brief('p', fake)

    def test_f5_nan_size_rejected(self):
        b = _good()
        b['places'][0]['size_m'] = [json.loads('NaN'), 4]
        self.assertTrue(brief.validate(b), 'NaN size_m must not validate')
        bad = json.dumps(_good()).replace('[5, 4]', '[NaN, 4]', 1)
        t = _Seq(bad, bad)
        with self.assertRaises(brief.BriefFailed):
            brief.make_brief('p', t)
        self.assertTrue(math.isnan(json.loads('NaN')))


class _Seq:
    def __init__(self, *replies):
        self.replies = list(replies)
        self.seen = []

    def __call__(self, messages):
        self.seen.append(messages)
        return self.replies.pop(0)


if __name__ == '__main__':
    unittest.main()
