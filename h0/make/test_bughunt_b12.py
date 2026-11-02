# gate wiring: runs under tools/ptest.py (unittest) as make.test_bughunt_bNN with cwd h0
import tempfile
import unittest
import json
from pathlib import Path
from unittest.mock import patch

from make.core import Ctx, _run_brief
from make import brief as brief_mod


def test_run_brief_book_scene_without_prompt_starts(tmp_path: Path):
    out = tmp_path / "brief"
    out.mkdir(parents=True)
    ctx = Ctx(
        run_dir=tmp_path,
        out=out,
        params={"fake": True},
        resume=False,
        budget_usd=None,
        opts={"prompt": "", "book": "dream/books/jane-eyre", "scene": "tea", "effort": "medium"},
    )
    with patch.object(brief_mod, "book_context", return_value="NOTE") as bc, \
         patch.object(brief_mod, "seed_from_book", return_value={"seed": 1}) as sfb, \
         patch.object(brief_mod, "make_brief", return_value={"title": "ok"}) as mb:
        _run_brief(ctx)
    assert (out / "brief.json").exists(), "brief.json must be written for --book/--scene without prompt"
    assert json.loads((out / "brief.json").read_text()) == {"title": "ok"}
    sfb.assert_called_once()
    mb.assert_called_once()


class BughuntB12(unittest.TestCase):
    def test_b12(self):
        with tempfile.TemporaryDirectory() as d:
            test_run_brief_book_scene_without_prompt_starts(Path(d))
