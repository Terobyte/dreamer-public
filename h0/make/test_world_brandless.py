"""L80: a brand in brief.style never reaches TASK.md; the look it stands for does."""

import unittest

from make import world


class Brandless(unittest.TestCase):
    def test_brands_become_looks(self):
        for style in ("Studio Ghibli", "in the style of studio ghibli", "Pixar style", "Wes Anderson's"):
            out = world.brandless(style).lower()
            for brand in ("ghibli", "pixar", "anderson"):
                self.assertNotIn(brand, out, style)
            self.assertIn("look", out)

    def test_plain_style_unchanged(self):
        self.assertEqual(world.brandless("warm watercolour, soft light"), "warm watercolour, soft light")

    def test_task_md_has_no_brand(self):
        import copy
        from make.test_world import BRIEF
        b = copy.deepcopy(BRIEF)
        b["style"] = "Studio Ghibli"
        md = world.build_task_md(b)
        self.assertNotIn("Ghibli", md)
        self.assertIn("watercolour animation look", md)


if __name__ == "__main__":
    unittest.main()
