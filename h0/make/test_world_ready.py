"""`make --world DIR`: a world already built by the engine (scene.json + dist/) is the world stage, no pipe2.
Squidward, Nov 3: the H16 round room existed; a pipe2 rebuild warmed two H100s for nothing, and the hand-made
symlink to it was relative and broke when make moved world.tmp into .pub/."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from make import core, world
from make.__main__ import main


def _built(root):
    w = root / "room"
    (w / "dist").mkdir(parents=True)
    (w / "scene.json").write_text(json.dumps({"version": 0, "rooms": []}))
    (w / "dist" / "geometry.json").write_text(json.dumps({"meshes": []}))
    (w / "dist" / "nav.json").write_text("{}")
    return w


def _ctx(run, **opts):
    out = run / "world.tmp"
    out.mkdir(parents=True, exist_ok=True)
    return core.Ctx(run_dir=run, out=out, params={}, resume=False, budget_usd=None, opts=opts)


class WorldReady(unittest.TestCase):
    def test_links_the_built_world_and_never_runs_pipe2(self):
        with tempfile.TemporaryDirectory() as d:
            w = _built(Path(d))
            ctx = _ctx(Path(d) / "run", world=str(w))
            usd = world.run_world(ctx, runner=lambda *a, **k: self.fail("pipe2 must not run"))
            self.assertEqual(usd, 0.0)
            link = ctx.out / "run"
            self.assertTrue(link.is_symlink())
            self.assertTrue(Path(link.readlink()).is_absolute(), "a relative link breaks when make publishes the stage")
            self.assertEqual(link.resolve(), w.resolve())
            self.assertTrue((ctx.out / "marker.txt").is_file())

    def test_a_folder_without_a_build_is_refused(self):
        with tempfile.TemporaryDirectory() as d:
            w = Path(d) / "empty"
            w.mkdir()
            with self.assertRaises(RuntimeError):
                world.run_world(_ctx(Path(d) / "run", world=str(w)), runner=lambda *a, **k: self.fail("no pipe2"))

    def test_a_rebuilt_world_changes_the_world_hash(self):
        with tempfile.TemporaryDirectory() as d:
            w = _built(Path(d))
            a = world.ready_inputs(w)
            (w / "dist" / "geometry.json").write_text(json.dumps({"meshes": [1]}))
            self.assertNotEqual(a, world.ready_inputs(w))

    def test_cli_passes_the_world(self):
        with mock.patch.object(core, "run_make", return_value={"world": "ran"}) as rm:
            main(["--run", "/tmp/x", "--world", "/tmp/room", "p"])
        self.assertEqual(rm.call_args.kwargs["world"], str(Path("/tmp/room").resolve()))


if __name__ == "__main__":
    unittest.main()
