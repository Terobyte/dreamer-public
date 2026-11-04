# gate wiring: runs under tools/ptest.py (unittest) as make.test_bughunt_bNN with cwd h0
import tempfile
import unittest
import json
import shutil
from pathlib import Path
from types import SimpleNamespace

from make import book as book_mod
from make import cast as cast_mod

REPO = Path(__file__).resolve().parents[2]
FIXTURE = REPO / "h0" / "make" / "testdata" / "cast_clips"


def test_step_cast_copies_clips_in_subdir(tmp_path):
    # valid cast (body + 2 clips) whose clips live in a subdirectory, as cast.json allows
    src = tmp_path / "cast_src"
    (src / "clips").mkdir(parents=True)
    shutil.copy(FIXTURE / "body.glb", src / "body.glb")
    shutil.copy(FIXTURE / "wake.glb", src / "clips" / "wake.glb")
    shutil.copy(FIXTURE / "hug.glb", src / "clips" / "hug.glb")
    cast = json.loads((FIXTURE / "cast.json").read_text())
    cast["Mama"]["clips"] = {"wake": "clips/wake.glb", "hug": "clips/hug.glb"}
    (src / "cast.json").write_text(json.dumps(cast))
    assert cast_mod.check_cast(src) == [], "fixture must be a valid cast in its source dir"

    out = tmp_path / "out"
    out.mkdir()
    ctx = SimpleNamespace(cast_dir=src, out=out, prev=lambda step: tmp_path / step)
    # expected: step succeeds and clips are copied; bug: StepError "...clips.wake: 'clips/wake.glb' missing or not a GLB"
    book_mod._step_cast(ctx)
    assert (out / "clips" / "wake.glb").is_file()


class BughuntB11(unittest.TestCase):
    def test_b11(self):
        with tempfile.TemporaryDirectory() as d:
            test_step_cast_copies_clips_in_subdir(Path(d))
