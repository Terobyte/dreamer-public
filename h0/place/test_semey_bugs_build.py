"""Bug tests for B22 (progress weights) and B23 (build_dist without timeout). Stdlib only, no network."""
import ast
import json
import subprocess
import tempfile
import unittest
from collections import Counter
from pathlib import Path
from unittest import mock

from place import assets, progress

PROGRESS_SRC = Path(progress.__file__).read_text()


class TestB22ProgressWeights(unittest.TestCase):
    def test_B22_default_has_no_duplicate_keys(self):
        """B22(a): DEFAULT in progress.py defines "assets" twice; the first value is silently dropped."""
        tree = ast.parse(PROGRESS_SRC)
        dict_nodes = [
            node.value for node in tree.body
            if isinstance(node, ast.Assign)
            and any(isinstance(t, ast.Name) and t.id == "DEFAULT" for t in node.targets)
            and isinstance(node.value, ast.Dict)
        ]
        self.assertEqual(len(dict_nodes), 1, "expected exactly one DEFAULT dict literal in progress.py")
        keys = [k.value for k in dict_nodes[0].keys if isinstance(k, ast.Constant)]
        dupes = sorted(k for k, n in Counter(keys).items() if n > 1)
        self.assertEqual(dupes, [], f"DEFAULT in progress.py defines these keys more than once: {dupes}")

    def test_B22_absurdly_low_timing_does_not_shrink_assets_weight(self):
        """B22(b): timings.json with assets=1.9 (default 150) must not shrink the assets weight to a sliver.

        Floor choice: a quarter of the shipped default (150 s -> 37.5 s). Anything below that means one
        cached/fast run has rewritten the stage weight so the bar ignores assets almost entirely.
        """
        floor = 0.25 * progress.DEFAULT["assets"]
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            fake_timings = tmp / "timings.json"
            fake_timings.write_text(json.dumps({"assets": 1.9}))
            with mock.patch.object(progress, "TIMINGS", fake_timings):
                prog = progress.Progress(tmp / "progress.jsonl", ["assets"], "test", save_timings=False)
                try:
                    weight = prog.w["assets"]
                finally:
                    prog._stop.set()
            self.assertGreaterEqual(
                weight, floor,
                f"assets weight is {weight} s from timings.json (1.9), below floor {floor} s; the bar would ignore assets",
            )


class TestB23BuildDistTimeout(unittest.TestCase):
    def test_B23_build_dist_passes_a_timeout_to_subprocess_run(self):
        """B23: build_dist calls subprocess.run with no timeout, so a hung engine build never returns."""
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            scene = tmp / "scene.json"
            scene.write_text("{}")
            out = tmp / "dist"
            out.mkdir()
            cache = tmp / "cache"
            fake_result = subprocess.CompletedProcess(args=[], returncode=0, stdout="", stderr="")
            with mock.patch.object(assets.subprocess, "run", return_value=fake_result) as run:
                rc = assets.build_dist(scene, out, cache)
            self.assertEqual(rc, 0)
            self.assertTrue(run.called, "build_dist did not call subprocess.run")
            kwargs = run.call_args.kwargs
            self.assertIn("timeout", kwargs, "subprocess.run in build_dist has no timeout= kwarg; a hung build blocks forever")
            self.assertIsNotNone(kwargs["timeout"])
            self.assertGreater(kwargs["timeout"], 0)


if __name__ == "__main__":
    unittest.main()
