"""A click on an object sends the engine a `touch` for the hero (debt sweep Nov 3): the engine's stage
`touch` handler walks the actor there, and nothing used to send it."""

import tempfile
import unittest

from sim import Sim


class ClickWalks(unittest.TestCase):
    def test_click_emits_touch_for_the_hero(self):
        s = Sim(fake=True, outdir=tempfile.mkdtemp())
        try:
            seen = []
            orig = s._diagnostic
            s._diagnostic = lambda e: (seen.append(e), orig(e))
            obj = s.fsm.objects[0]
            s.click(obj)
            t = [e for e in seen if e.get("type") == "touch"]
            self.assertEqual(len(t), 1)
            self.assertEqual(t[0]["object"], obj)
            self.assertEqual(t[0]["who"], s.hero)
            s.click("no such thing at all")
            self.assertEqual(len([e for e in seen if e.get("type") == "touch"]), 1)
        finally:
            s.close()


if __name__ == "__main__":
    unittest.main()
