"""Host fixes on the M1 fuse: CLI book wins over Spark's pick, empty prompt, query, sizes."""
import tempfile
import unittest
from pathlib import Path

from make import brief, core
from make.test_brief_place import book_good, DREAM


class FuseFixTest(unittest.TestCase):
    def test_seed_answer_rejected_for_book_run(self):
        want = {'dir': str(DREAM / 'books' / 'gwtw'), 'scene': 'lawn'}
        errs = brief.validate(core._seed_brief('x'), want)
        self.assertTrue(any('mode' in e for e in errs), errs)
        self.assertEqual(brief.validate(book_good(), want), [])

    def test_other_book_scene_rejected(self):
        errs = brief.validate(book_good(), {'dir': str(DREAM / 'books' / 'gwtw'), 'scene': 'other'})
        self.assertTrue(any('--book/--scene' in e for e in errs), errs)

    def test_one_shared_word_is_not_a_place_query(self):
        b = book_good()
        b['places'][0]['query'] = 'April attic bedroom'
        self.assertTrue(brief.validate(b))

    def test_empty_queries_and_bad_sizes(self):
        b = core._seed_brief('x')
        b['places'][0]['size_m'] = [-2, 0]
        b['places'][0]['query'] = ''
        b['cast'][0]['query'] = '  '
        self.assertEqual(len(brief.validate(b)), 4)

    def test_no_prompt_fails_brief(self):
        with tempfile.TemporaryDirectory() as d:
            res = core.run_make(Path(d) / 'r', None, only='brief', fake=True)
        self.assertEqual(res['brief'], 'failed')


if __name__ == '__main__':
    unittest.main()
