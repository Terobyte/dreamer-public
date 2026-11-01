"""No code calls the paid `muse-spark-1.3`: only `muse-spark-1.3-contributor` (it burned money twice).
And pipe2 meshes default to TRELLIS.2 1024, not SAM3D."""
import re
import unittest
from pathlib import Path

from pipe2.__main__ import _parser
from pipe2.assets import MESH_APPS, ModalMesh
from pipe2.gpu import ModalAutoscaler

REPO = Path(__file__).resolve().parents[2]
PAID = re.compile(r"muse-spark-1\.3(?![-\w])")
SKIP = {"node_modules", "dist", "out", "cache", "__pycache__", "runs"}


def _sources():
    for root in ("h0", "engine/src", "engine/bin", "app/src"):
        for path in (REPO / root).rglob("*"):
            if path.suffix in (".py", ".ts", ".js", ".html") and not SKIP & set(path.parts):
                yield path


class PaidModel(unittest.TestCase):
    def test_no_code_names_the_paid_spark(self):
        hits = []
        for path in _sources():
            if path == Path(__file__).resolve():
                continue
            for n, line in enumerate(path.read_text(errors="replace").splitlines(), 1):
                if PAID.search(line):
                    hits.append(f"{path.relative_to(REPO)}:{n}: {line.strip()}")
        self.assertEqual([], hits, "paid muse-spark-1.3 in code, use muse-spark-1.3-contributor")


class MeshDefault(unittest.TestCase):
    def test_trellis_is_the_default_mesh(self):
        args = _parser().parse_args(["run", "task", "--run-dir", "r"])
        self.assertEqual("trellis", args.mesh)
        self.assertEqual(("dreamer-trellis", "Trellis"), MESH_APPS["trellis"])
        self.assertEqual("dreamer-trellis", ModalMesh().app)
        self.assertEqual("dreamer-trellis", ModalAutoscaler().app)
        self.assertEqual("1024_cascade", re.search(r'PIPELINE = "([^"]+)"',
                         (REPO / "h0/trellis_modal.py").read_text()).group(1))

    def test_trellis_takes_the_budget_and_keeps_the_original(self):
        src = (REPO / "h0/trellis_modal.py").read_text()
        self.assertRegex(src, r"def run\(self, name: str, png: bytes, with_ply: bool = False, faces: int = FACES")
        self.assertIn('"full": full', src)
        self.assertIn("int(faces * MARGIN)", src)

    def test_sam3d_is_still_selectable(self):
        args = _parser().parse_args(["run", "task", "--run-dir", "r", "--mesh", "sam3d"])
        self.assertEqual(("dreamer-sam3d", "Sam3D"), MESH_APPS[args.mesh])


if __name__ == "__main__":
    unittest.main()
