"""D2 debt: a repeated idea id answers as the first time, even after the clean cache is gone."""

import tempfile
import unittest

from sim import Sim


class RepeatId(unittest.TestCase):
    def test_repeat_after_cache_clear_and_failing_clean(self):
        s = Sim(fake=True, outdir=tempfile.mkdtemp())
        try:
            first = s.post_idea({"id": "a1", "source": "operator", "value": "поговорите о сестре"})
            self.assertTrue(first.get("ok"), first)
            s._clean_cache.clear()
            s._clean_text = lambda v: {"error": "boom"}
            again = s.post_idea({"id": "a1", "source": "operator", "value": "поговорите о сестре"})
            self.assertEqual(again, first)
            new = s.post_idea({"id": "a2", "source": "operator", "value": "поговорите о брате"})
            self.assertEqual(new.get("error"), "clean_failed")
        finally:
            s.close()


if __name__ == "__main__":
    unittest.main()
