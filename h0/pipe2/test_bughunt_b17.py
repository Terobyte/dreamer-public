import subprocess
from pathlib import Path
from unittest.mock import patch
import tempfile

from pipe2.engine import Engine


class _Done:
    returncode = 0
    stdout = ""
    stderr = ""


def test_stage_scene_tmpdir_cleaned_after_build(tmp_path):
    eng = Engine.__new__(Engine)
    scene = {"assets": {}}
    out = tmp_path / "out"

    created = []
    real_mkdtemp = tempfile.mkdtemp
    def tracking_mkdtemp(*a, **k):
        p = real_mkdtemp(*a, **k)
        created.append(Path(p))
        return p

    with patch("tempfile.mkdtemp", side_effect=tracking_mkdtemp):
        with patch.object(Engine, "_run", return_value=_Done()):
            eng.build(scene, out, "none", None)

    assert created, "expected _stage_scene to create a temp dir"
    here = created[0]
    # expected: staging dir removed after build finishes
    assert not here.exists(), f"temp staging dir leaked: {here}"
