"""make --mesh sam3d reaches `pipe2 run --mesh` (live judge demo needs sam3d)."""
import tempfile
import unittest
from unittest import mock

from make import world
from make.test_world import _ctx, _prep_run


class Mesh(unittest.TestCase):
    def test_argv_mesh(self):
        a = world.pipe2_argv("t", "r", mesh="sam3d")
        self.assertEqual(a[a.index("--mesh") + 1], "sam3d")
        self.assertNotIn("--mesh", world.pipe2_argv("t", "r"))

    def test_run_world_forwards_mesh(self):
        with tempfile.TemporaryDirectory() as tmp:
            calls = []
            world.run_world(_ctx(_prep_run(tmp), opts={"mesh": "sam3d"}),
                            runner=lambda argv, **kw: calls.append(argv) or mock.Mock(returncode=0))
            self.assertEqual(calls[0][calls[0].index("--mesh") + 1], "sam3d")


if __name__ == "__main__":
    unittest.main()
