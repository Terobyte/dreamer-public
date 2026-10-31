"""F7/F11/F15/F18 live branch calls Spark; F17/F20 --book/--scene; F21 book place query."""
import json
import tempfile
import unittest
import urllib.request
from pathlib import Path
from unittest import mock

from make import brief, core
from make import __main__ as cli
from make.test_brief import BriefTest, good

DREAM = Path(__file__).resolve().parents[1] / 'dream'
GWTW = DREAM / 'books' / 'gwtw'


def jane():
    b = good()
    b['title'] = 'Thornfield library'
    b['places'][0].update(id='library', query='Thornfield library')
    b['cast'] = [{'who': 'Jane Eyre', 'sex': 'female', 'age': 'adult', 'look': 'plain', 'voice': 'woman', 'query': 'q'},
                 {'who': 'Edward Rochester', 'sex': 'male', 'age': 'adult', 'look': 'dark', 'voice': 'man', 'query': 'q'}]
    b['scene'] = {'where': 'library', 'who': ['Jane Eyre', 'Edward Rochester'], 'want': 'talk'}
    return b


class FakeTransport:
    def __init__(self, *texts):
        self.texts = list(texts)
        self.bodies = []

    def post(self, body, timeout):
        self.bodies.append(body)
        return {'choices': [{'message': {'content': self.texts.pop(0)}, 'finish_reason': 'stop'}],
                'usage': {'prompt_tokens': 10, 'completion_tokens': 10}}


class SparkBranchTest(unittest.TestCase):
    def setUp(self):
        p = mock.patch.object(urllib.request, 'urlopen', side_effect=AssertionError('network'))
        p.start()
        self.addCleanup(p.stop)
        self.tmp = Path(tempfile.mkdtemp())

    def test_live_branch_calls_spark_and_writes_its_plan(self):
        t = FakeTransport('```json\n' + json.dumps(jane()) + '\n```')
        with mock.patch.object(core, '_spark_transport', lambda: t):
            res = core.run_make(self.tmp, 'Jane meets Rochester in Thornfield library', only='brief')
        self.assertEqual(res['brief'], 'ran')
        out = json.loads((self.tmp / 'brief' / 'brief.json').read_text())
        self.assertEqual({c['who'] for c in out['cast']}, {'Jane Eyre', 'Edward Rochester'})
        self.assertEqual(out['places'][0]['id'], 'library')
        self.assertEqual(len(t.bodies), 1)
        self.assertIn('Jane meets Rochester', json.dumps(t.bodies[0]['messages']))
        self.assertIn('json', json.dumps(t.bodies[0]['messages']).lower())

    def test_live_branch_invalid_twice_fails(self):
        t = FakeTransport('not json', 'still not json')
        with mock.patch.object(core, '_spark_transport', lambda: t):
            res = core.run_make(self.tmp, 'p', only='brief')
        self.assertEqual(res['brief'], 'failed')
        self.assertEqual(len(t.bodies), 2)
        self.assertIn('json', json.dumps(t.bodies[1]['messages']).lower())

    def test_cli_book_and_scene(self):
        rc = cli.main(['Scarlett on the lawn at Twelve Oaks', '--run', str(self.tmp), '--only', 'brief',
                       '--fake', '--book', str(GWTW), '--scene', 'lawn'])
        self.assertEqual(rc, 0)
        out = json.loads((self.tmp / 'brief' / 'brief.json').read_text())
        self.assertEqual(out['mode'], 'book')
        self.assertEqual(out['book']['scene'], 'lawn')
        book = json.loads((GWTW / 'book.json').read_text())
        scene = next(s for ch in book['chapters'] for s in ch['scenes'] if s['id'] == 'lawn')
        self.assertEqual({c['who'] for c in out['cast']}, set(scene['cast']))

    def test_live_book_prompt_carries_book_scene(self):
        b = BriefTest().book_reply()
        t = FakeTransport(json.dumps(b))
        with mock.patch.object(core, '_spark_transport', lambda: t):
            res = core.run_make(self.tmp, 'Scarlett on the lawn', only='brief', book=str(GWTW), scene='lawn')
        self.assertEqual(res['brief'], 'ran')
        self.assertIn('Rhett Butler', json.dumps(t.bodies[0]['messages']))

    def test_book_place_query_must_match_book_place(self):
        b = BriefTest().book_reply()
        b['places'][0].update(type='yard', query='attic bedroom')
        errs = brief.validate(b)
        self.assertTrue(any('query' in e for e in errs), errs)
        b['places'][0]['query'] = 'Twelve Oaks back lawn'
        self.assertEqual(brief.validate(b), [])


if __name__ == '__main__':
    unittest.main()
