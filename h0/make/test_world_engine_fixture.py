"""Red (F6/F10/F12/F14): the fake world_run dist is an engine build.

`build_world_run.sh` must compile a scene with `dreamer build` over a cache of
fakeGlb/fakePng, so the fixture page loads the engine runtime and renders the
scene with real (fake) assets — not a hand-written geometry and a static page.
"""
import json
import re
import unittest
from pathlib import Path

DATA = Path(__file__).resolve().parent / "testdata"
DIST = DATA / "world_run" / "dist"


class EngineFixture(unittest.TestCase):
    def test_script_builds_with_engine(self):
        sh = (DATA / "build_world_run.sh").read_text()
        self.assertIn("bin/dreamer.ts", sh)
        self.assertRegex(sh, r"\bbuild\b.*--assets cache")
        self.assertIn("fakeGlb", sh)
        self.assertIn("fakePng", sh)

    def test_geometry_has_glb_props(self):
        g = json.loads((DIST / "geometry.json").read_text())
        self.assertTrue(g.get("meshes") and g.get("floors"))
        glbs = [m["glb"] for m in g["meshes"] if isinstance(m.get("glb"), str)]
        self.assertTrue(glbs, "props must carry fake GLBs")
        for rel in glbs:
            self.assertTrue((DIST / rel).is_file(), f"missing {rel}")

    def test_page_loads_engine_runtime(self):
        html = (DIST / "index.html").read_text()
        srcs = re.findall(r'<script[^>]*src="([^"]+)"', html)
        self.assertTrue(srcs, "page must load a runtime script")
        for s in srcs:
            self.assertTrue((DIST / s).is_file(), f"missing {s}")
        rt = "".join((DIST / s).read_text() for s in srcs)
        self.assertIn("geometry.json", rt)
        self.assertGreater(len(rt), 50_000, "runtime must be the engine bundle (three.js)")

    def test_build_json_from_engine(self):
        b = json.loads((DIST / "build.json").read_text())
        self.assertIn("props", b)
        self.assertIn("tris", b)


if __name__ == "__main__":
    unittest.main()
