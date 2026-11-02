import copy, json, unittest, urllib.request
from pathlib import Path
from unittest import mock

from make import brief

DREAM = Path(__file__).resolve().parents[1] / 'dream'
with open(DREAM / 'voices.json', encoding='utf-8') as _vf:
    VOICES = json.load(_vf)


def good():
    return {
        'title': 'Attic', 'mode': 'seed', 'book': None, 'style': 'warm gouache',
        'places': [{'id': 'attic', 'type': 'room', 'size_m': [5, 4], 'level': 0, 'next_to': [],
                    'query': 'attic', 'provider_hint': 'commons', 'fandom_wiki': None}],
        'cast': [{'who': 'Anna', 'sex': 'female', 'age': 'adult', 'look': 'tall', 'voice': 'woman', 'query': 'woman'}],
        'scene': {'where': 'attic', 'who': ['Anna'], 'want': 'find the trunk'},
    }


class Seq:
    """Scripted transport: returns replies in order, records prompts."""
    def __init__(self, *replies):
        self.replies = list(replies)
        self.seen = []

    def __call__(self, messages):
        self.seen.append(messages)
        return self.replies.pop(0)


class BriefTest(unittest.TestCase):
    def setUp(self):
        p = mock.patch.object(urllib.request, 'urlopen', side_effect=AssertionError('network'))
        p.start()
        self.addCleanup(p.stop)

    def test_schema_voice_enum_is_voices_json(self):
        with open(brief.SCHEMA_PATH, encoding='utf-8') as f:
            s = json.load(f)
        # `<label>@ru` keys are lookups for --lang ru, not labels a brief may pick
        labels = [k for k in VOICES if '@' not in k]
        self.assertEqual(s['properties']['cast']['items']['properties']['voice']['enum'], labels)

    def test_valid(self):
        self.assertEqual(brief.validate(good()), [])

    def test_bad_voice_and_id(self):
        b = good()
        b['cast'][0]['voice'] = 'nope'
        b['places'][0]['id'] = 'Bad Id'
        errs = brief.validate(b)
        self.assertTrue(any('voice' in e for e in errs))
        self.assertTrue(any('places' in e and 'id' in e for e in errs))

    def test_extra_and_missing_field(self):
        b = good()
        b['extra'] = 1
        del b['style']
        errs = ' '.join(brief.validate(b))
        self.assertIn('extra', errs)
        self.assertIn('style', errs)

    def test_retry_once_with_error_text(self):
        t = Seq('not json', json.dumps(good()))
        out = brief.make_brief('a prompt', t)
        self.assertEqual(out['title'], 'Attic')
        self.assertEqual(len(t.seen), 2)
        self.assertIn('json', json.dumps(t.seen[1], ensure_ascii=False).lower())

    def test_invalid_twice_failed(self):
        bad = good()
        bad['cast'][0]['voice'] = 'nope'
        t = Seq(json.dumps(bad), json.dumps(bad), json.dumps(good()))
        with self.assertRaises(brief.BriefFailed) as c:
            brief.make_brief('p', t)
        self.assertIn('voice', str(c.exception))
        self.assertEqual(len(t.seen), 2)

    def test_scenario_fake(self):
        fake = brief.ScenarioBrief([json.dumps(good())])
        self.assertEqual(brief.make_brief('p', fake)['scene']['where'], 'attic')

    def book_reply(self):
        b = good()
        b['mode'] = 'book'
        b['book'] = {'dir': str(DREAM / 'books' / 'gwtw'), 'scene': 'lawn'}
        b['places'][0]['id'] = 'lawn'
        b['places'][0]['type'] = 'yard'
        b['places'][0]['query'] = 'lawn'
        b['scene']['where'] = 'lawn'
        with open(DREAM / 'books' / 'gwtw' / 'book.json', encoding='utf-8') as f:
            book = json.load(f)
        scene = next(s for ch in book['chapters'] for s in ch['scenes'] if s['id'] == 'lawn')
        sexes = {'woman': 'female', 'man': 'male'}
        b['cast'] = [{'who': n, 'sex': sexes[book['cast'][n]['sex']], 'age': 'adult', 'look': 'x',
                      'voice': 'man', 'query': 'q'} for n in scene['cast']]
        b['scene']['who'] = [c['who'] for c in b['cast']]
        return b

    def test_book_merge_ok(self):
        out = brief.make_brief('p', Seq(json.dumps(self.book_reply())))
        names = {c['who'] for c in out['cast']}
        with open(DREAM / 'books' / 'gwtw' / 'book.json', encoding='utf-8') as f:
            book = json.load(f)
        scene = next(s for ch in book['chapters'] for s in ch['scenes'] if s['id'] == 'lawn')
        self.assertEqual(names, set(scene['cast']))
        sex = {c['who']: c['sex'] for c in out['cast']}
        self.assertEqual(sex['Rhett Butler'], 'male')
        self.assertEqual(sex['Scarlett O\'Hara'], 'female')

    def test_book_sex_conflict(self):
        b = self.book_reply()
        next(c for c in b['cast'] if c['who'] == 'Rhett Butler')['sex'] = 'female'
        errs = brief.validate(b)
        self.assertTrue(any('Rhett Butler' in e and 'sex' in e for e in errs))
        with self.assertRaises(brief.BriefFailed):
            brief.make_brief('p', Seq(json.dumps(b), json.dumps(b)))

    def test_book_name_conflict(self):
        b = self.book_reply()
        next(c for c in b['cast'] if c['who'] == 'Rhett Butler')['who'] = 'Rhet Butlr'
        errs = brief.validate(b)
        self.assertTrue(any('Rhet Butlr' in e or 'Rhett Butler' in e for e in errs))


if __name__ == '__main__':
    unittest.main()
