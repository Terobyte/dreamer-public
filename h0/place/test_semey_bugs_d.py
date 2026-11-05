"""Gate 2 bug B58 as red tests (meta/bugs.md): the wall/floor tile prompt must be ONE uniform surface.
No network. Expected to FAIL on current code.

  cd h0 && python3 -m unittest place.test_semey_bugs_d -v
"""
import re
import unittest

from place import semey as S


def spec(**kw):
    s = {"label": "Пекарня", "sign": "НАН", "board": "worn painted board", "window": "plain window with bread",
         "wall": "warm beige plaster walls with lower half pale green oil paint",
         "floor": "worn linoleum, dark tiles in the middle and light tiles near the walls",
         "objects": [{"id": f"o{i}", "prompt": "a counter", "w": 1.0, "d": 0.5, "h": 1.0, "place": "back"} for i in range(3)]}
    s.update(kw)
    return s


class B58(unittest.TestCase):
    def test_wish_prompt_demands_uniform_tile(self):
        t = S.WISH_PLACE.lower()
        self.assertIn("uniform", t, "B58 expected: WISH_PLACE tells Spark wall/floor are ONE uniform material")
        self.assertIn("two-tone", t, "B58 expected: WISH_PLACE forbids two-tone")
        self.assertIn("half", t, "B58 expected: WISH_PLACE forbids halves")
        self.assertRegex(t, r"(no|never|not|without|forbid)[^.\n]{0,80}(two-tone|half)", "B58 expected: forbidding clause")

    def test_fix_spec_appends_uniform_rule(self):
        out = S.fix_spec(spec())
        for k in ("wall", "floor"):
            v = out[k].lower()
            self.assertIn("uniform", v, f"B58 expected: {k} prompt carries the uniform-tile rule; actual: {out[k]!r}")
            self.assertIn("no two-tone", v, f"B58 expected: {k} prompt carries 'no two-tone'; actual: {out[k]!r}")
            self.assertRegex(v, r"(uniform|two-tone)[^.]*$", f"B58 expected: rule at the END of the {k} prompt; actual: {out[k]!r}")


if __name__ == "__main__":
    unittest.main()
