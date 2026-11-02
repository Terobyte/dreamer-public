"""A1 red: cast.json `clips` / `idle` / `verbs` are checked by check_cast and carried into cast/."""
import importlib.util
import json
import shutil
import struct
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from . import cast, core

FIX = Path(__file__).resolve().parent / "testdata" / "cast_clips"
PROMPT = "a cat mother wakes her kitten"


def _copy():
    d = Path(tempfile.mkdtemp()) / "cast"
    shutil.copytree(FIX, d)
    return d


def _edit(d, **kw):
    p = d / "cast.json"
    c = json.loads(p.read_text())
    c["Mama"].update(kw)
    p.write_text(json.dumps(c))


def _errs(**kw):
    d = _copy()
    _edit(d, **kw)
    return cast.check_cast(d)


def _mutate_glb(d, name, fix):
    """Rewrite the JSON chunk of a fixture GLB in place (BIN chunk untouched)."""
    p = d / name
    raw = p.read_bytes()
    n = struct.unpack("<I", raw[12:16])[0]
    doc = json.loads(raw[20:20 + n].decode("utf-8"))
    fix(doc)
    js = json.dumps(doc).encode()
    js += b" " * (-len(js) % 4)
    body = struct.pack("<I4s", len(js), b"JSON") + js + raw[20 + n:]
    p.write_bytes(struct.pack("<III", 0x46546C67, 2, 12 + len(body)) + body)


class Fixture(unittest.TestCase):
    def test_build_matches_committed_bytes(self):
        spec = importlib.util.spec_from_file_location("cast_clips_build", FIX / "build.py")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        tmp = Path(tempfile.mkdtemp())
        mod.build(tmp)
        built = sorted(p.name for p in tmp.iterdir())
        self.assertTrue(built)
        for name in built:
            self.assertEqual((tmp / name).read_bytes(), (FIX / name).read_bytes(), name)


class CheckClips(unittest.TestCase):
    def test_valid_two_clips_ok(self):
        self.assertEqual(cast.check_cast(FIX), [])

    def test_clip_glb_missing_or_broken(self):
        d = _copy()
        (d / "hug.glb").write_bytes(b"nope")
        errs = cast.check_cast(d)
        self.assertEqual(len(errs), 1, errs)
        self.assertIn("Mama.clips.hug", errs[0])
        d = _copy()
        (d / "wake.glb").unlink()
        errs = cast.check_cast(d)
        self.assertEqual(len(errs), 1, errs)
        self.assertIn("Mama.clips.wake", errs[0])

    def test_clip_without_animation(self):
        for f in ("noanim.glb", "emptyanim.glb"):
            errs = _errs(clips={"wake": f})
            self.assertEqual(len(errs), 1, (f, errs))
            self.assertIn("Mama.clips.wake", errs[0])

    def test_zero_duration(self):
        errs = _errs(clips={"wake": "zero.glb"})
        self.assertEqual(len(errs), 1, errs)
        self.assertIn("Mama.clips.wake", errs[0])
        self.assertIn("duration", errs[0])

    def test_sampler_input_without_max(self):
        errs = _errs(clips={"wake": "nomax.glb"})
        self.assertEqual(len(errs), 1, errs)
        self.assertIn("Mama.clips.wake: sampler input has no max", errs[0])

    def test_huge_int_max_is_a_field_error(self):
        d = _copy()
        _mutate_glb(d, "wake.glb", lambda doc: doc["accessors"].__setitem__(
            -2, {**doc["accessors"][-2], "max": [10**400]}))
        errs = cast.check_cast(d)
        self.assertEqual(errs, ["Mama.clips.wake: sampler input has no max"])

    def test_foreign_skeleton(self):
        errs = _errs(clips={"wake": "foreign.glb"})
        self.assertEqual(len(errs), 1, errs)
        self.assertIn("Mama.clips.wake", errs[0])
        self.assertIn("tail", errs[0])

    def test_unnamed_channel_target(self):
        errs = _errs(clips={"wake": "unnamed.glb"})
        self.assertEqual(len(errs), 1, errs)
        self.assertIn("Mama.clips.wake", errs[0])
        self.assertIn("channel 1", errs[0])

    def test_channel_with_missing_sampler_index(self):
        d = _copy()
        _mutate_glb(d, "wake.glb",
                    lambda doc: doc["animations"][0]["channels"][0].__setitem__("sampler", 999))
        errs = cast.check_cast(d)
        self.assertEqual(len(errs), 1, errs)
        self.assertIn("Mama.clips.wake", errs[0])
        self.assertIn("sampler", errs[0])

    def test_non_list_joints_is_a_field_error(self):
        for f in ("wake.glb", "body.glb"):
            d = _copy()
            _mutate_glb(d, f, lambda doc: doc["skins"][0].__setitem__("joints", 5))
            errs = cast.check_cast(d)  # must not raise
            self.assertTrue(errs, (f, errs))
            self.assertTrue(all(e.startswith("Mama.") for e in errs), (f, errs))

    def test_body_without_skin_and_clips(self):
        errs = _errs(glb="noskin_body.glb")
        self.assertEqual(errs, ["Mama.glb: no skin, clips need a skinned body"])

    def test_clip_path_outside(self):
        d = _copy()
        shutil.copy(FIX / "wake.glb", d.parent / "out.glb")
        for bad in ("../out.glb", str(d.parent / "out.glb")):
            _edit(d, clips={"wake": bad})
            errs = cast.check_cast(d)
            self.assertEqual(len(errs), 1, (bad, errs))
            self.assertIn("Mama.clips.wake", errs[0])

    def test_empty_clips_map_is_static_character(self):
        d = _copy()
        _edit(d, clips={})
        d_idle = cast.check_cast(d)
        self.assertEqual(d_idle, [])
        self.assertIsNone(cast.default_idle({}))

    def test_clip_symlink_outside(self):
        d = _copy()
        shutil.copy(FIX / "wake.glb", d.parent / "out.glb")
        (d / "link.glb").symlink_to(d.parent / "out.glb")
        _edit(d, clips={"wake": "link.glb"})
        errs = cast.check_cast(d)
        self.assertEqual(len(errs), 1, errs)
        self.assertIn("Mama.clips.wake", errs[0])

    def test_bad_clip_names(self):
        for bad in ("Wake", "1a", "a-b", "", "wake\n", "x" * 33):
            errs = _errs(clips={bad: "wake.glb"})
            self.assertEqual(len(errs), 1, (bad, errs))
            self.assertIn("Mama.clips", errs[0])
        self.assertEqual(_errs(clips={"x" * 32: "wake.glb"}), [])

    def test_clips_must_be_object(self):
        for bad in ([], "wake.glb", 3, None):
            errs = _errs(clips=bad)
            self.assertEqual(len(errs), 1, (bad, errs))
            self.assertIn("Mama.clips", errs[0])

    def test_same_file_twice_and_as_body_ok(self):
        self.assertEqual(_errs(clips={"wake": "wake.glb", "also": "wake.glb"}), [])
        self.assertEqual(_errs(clips={"wake": "body.glb"}), [])

    def test_body_rigaction_is_not_a_clip(self):
        # body.glb carries a rigAction, but explicit `clips` replace it: only wake/hug exist
        errs = _errs(idle="rigAction")
        self.assertEqual(len(errs), 1, errs)
        self.assertIn("Mama.idle", errs[0])
        errs = _errs(idle="body")
        self.assertIn("Mama.idle", errs[0])

    def test_idle_forms(self):
        self.assertEqual(_errs(idle="wake"), [])
        self.assertEqual(_errs(idle="wake@0"), [])
        self.assertEqual(_errs(idle="hug@2"), [])
        self.assertEqual(_errs(idle="hug@0.5"), [])

    def test_idle_bad(self):
        for bad in ("sleep", "sleep@0", "wake@x", "wake@-1", "wake@1.5", "hug@2.01", "wake@", 5, ["wake"]):
            errs = _errs(idle=bad)
            self.assertEqual(len(errs), 1, (bad, errs))
            self.assertIn("Mama.idle", errs[0])

    def test_idle_without_clips(self):
        d = _copy()
        c = json.loads((d / "cast.json").read_text())
        del c["Mama"]["clips"]
        c["Mama"]["idle"] = "wake"
        (d / "cast.json").write_text(json.dumps(c))
        errs = cast.check_cast(d)
        self.assertEqual(len(errs), 1, errs)
        self.assertIn("Mama.idle", errs[0])

    def test_verbs_shape(self):
        self.assertEqual(_errs(verbs={"hug": ["hug"], "wake": []}), [])
        for bad in ([], {"hug": "hug"}, {"hug": [1]}):
            errs = _errs(verbs=bad)
            self.assertEqual(len(errs), 1, (bad, errs))
            self.assertIn("Mama.verbs", errs[0])
            self.assertIn("must be an object", errs[0])

    def test_aliases_shape(self):
        self.assertEqual(_errs(aliases=["Мама", "мамы"]), [])
        for bad in ({"a": "b"}, [1], "Мама", None):
            errs = _errs(aliases=bad)
            self.assertEqual(len(errs), 1, (bad, errs))
            self.assertIn("Mama.aliases", errs[0])
            self.assertIn("list of names", errs[0])

    def test_idle_null_rejected(self):
        errs = _errs(idle=None)
        self.assertEqual(len(errs), 1, errs)
        self.assertIn("Mama.idle", errs[0])

    def test_verbs_null_rejected_empty_map_ok(self):
        errs = _errs(verbs=None)
        self.assertEqual(len(errs), 1, errs)
        self.assertIn("Mama.verbs", errs[0])
        self.assertEqual(_errs(verbs={}), [])

    def test_no_exception_on_garbage(self):
        for bad in ({"wake": None}, {"wake": 5}, {"wake": ""}, {"wake": ["a"]}, {"wake": "."}):
            errs = _errs(clips=bad)
            self.assertTrue(errs and all(e.startswith("Mama.clips.wake") for e in errs), (bad, errs))

    def test_no_clips_no_checks(self):
        d = _copy()
        c = json.loads((d / "cast.json").read_text())
        del c["Mama"]["clips"], c["Mama"]["verbs"]
        c["Mama"]["glb"] = "noskin_body.glb"
        (d / "cast.json").write_text(json.dumps(c))
        self.assertEqual(cast.check_cast(d), [])


class DefaultIdle(unittest.TestCase):
    def test_alphabetical_first_at_zero(self):
        self.assertEqual(cast.default_idle({"wake": "w", "hug": "h"}), "hug@0")

    def test_idle_clip_wins(self):
        self.assertEqual(cast.default_idle({"wake": "w", "idle": "i"}), "idle")

    def test_no_clips_none(self):
        self.assertIsNone(cast.default_idle({}))
        self.assertIsNone(cast.default_idle(None))


def _stage_run(run):
    def stub(ctx):
        (ctx.out / "marker.txt").write_text("{}")
        return 0.0

    mocks = {"_run_brief": stub, "_run_refs": stub, "_run_world": stub,
             "_run_story": stub, "_run_stage": stub, "_run_cast": core._run_cast}
    with mock.patch.multiple(core, **mocks):
        return core.run_make(run, PROMPT, fake=False, live=True)


class StageCarriesClips(unittest.TestCase):
    def _run(self):
        run = Path(tempfile.mkdtemp()) / "run"
        shutil.copytree(FIX, run / "cast.src")
        return run

    def test_cast_json_carries_clips_idle_verbs(self):
        run = self._run()
        _stage_run(run)
        pub = json.loads((run / "cast" / "cast.json").read_text())["Mama"]
        self.assertEqual(pub["clips"], {"wake": "wake.glb", "hug": "hug.glb"})
        self.assertEqual(pub["idle"], "hug@0")
        self.assertEqual(pub["verbs"], {"hug": ["hug", "hugged", "hold", "held"]})
        for f in ("body.glb", "wake.glb", "hug.glb"):
            self.assertTrue((run / "cast" / f).is_file(), f)

    def test_explicit_idle_kept(self):
        run = self._run()
        _edit(run / "cast.src", idle="wake@0.5")
        _stage_run(run)
        pub = json.loads((run / "cast" / "cast.json").read_text())["Mama"]
        self.assertEqual(pub["idle"], "wake@0.5")

    def test_character_without_clips_untouched(self):
        run = Path(tempfile.mkdtemp()) / "run"
        shutil.copytree(cast.FIXTURE, run / "cast.src")
        _stage_run(run)
        self.assertEqual((run / "cast" / "cast.json").read_bytes(),
                         (cast.FIXTURE / "cast.json").read_bytes())

    def test_clip_bytes_change_reruns_cast(self):
        run = self._run()
        self.assertEqual(_stage_run(run).get("cast"), "ran")
        self.assertEqual(_stage_run(run).get("cast"), "cached")
        p = run / "cast.src" / "wake.glb"
        raw = bytearray(p.read_bytes())
        raw[-1] ^= 0xFF  # last byte sits in the BIN padding/values: still a valid GLB
        p.write_bytes(bytes(raw))
        self.assertEqual(cast.check_cast(run / "cast.src"), [])
        res = _stage_run(run)
        self.assertEqual(res.get("cast"), "ran", res)
        self.assertEqual(res.get("stage"), "ran", res)

    def test_invalid_clip_fails_stage(self):
        run = self._run()
        (run / "cast.src" / "hug.glb").write_bytes(b"nope")
        res = _stage_run(run)
        self.assertEqual(res.get("cast"), "failed", res)


class CastRunsClipfacts(unittest.TestCase):
    """Г4: run_cast calls `dreamer.ts clipfacts <ctx.out>` when someone has a GLB and clips."""

    def _ctx(self, src):
        run = Path(tempfile.mkdtemp()) / "run"
        shutil.copytree(src, run / "cast.src")
        out = run / "cast"
        out.mkdir(parents=True)
        return core.Ctx(run_dir=run, out=out, params={}, resume=False, budget_usd=None, opts={"live": True})

    def _marker(self, ctx):
        return json.loads((ctx.out / "marker.txt").read_text())

    def test_calls_command_with_out(self):
        ctx = self._ctx(FIX)
        seen = []

        def fake(cmd, **kw):
            seen.append((cmd, kw))
            # by then copytree and _fill_idle are done, marker not yet written
            self.assertTrue((ctx.out / "body.glb").is_file())
            self.assertEqual(json.loads((ctx.out / "cast.json").read_text())["Mama"]["idle"], "hug@0")
            self.assertFalse((ctx.out / "marker.txt").exists())
            return mock.Mock(returncode=0)

        with mock.patch.object(cast.subprocess, "run", side_effect=fake):
            cast.run_cast(ctx)
        self.assertEqual(len(seen), 1)
        cmd, kw = seen[0]
        self.assertEqual(cmd, ["node", "--import", "tsx", "bin/dreamer.ts", "clipfacts", str(ctx.out)])
        self.assertEqual(Path(kw["cwd"]).resolve(), (Path(cast.__file__).resolve().parents[2] / "engine").resolve())
        self.assertNotIn("check", kw)
        self.assertNotIn("CLIPFACTS_FAILED", " ".join(self._marker(ctx).get("warnings", [])))

    def test_no_clips_no_call(self):
        ctx = self._ctx(cast.FIXTURE)
        with mock.patch.object(cast.subprocess, "run") as run:
            cast.run_cast(ctx)
        run.assert_not_called()

    def test_no_glb_no_call(self):
        ctx = self._ctx(FIX)
        self.assertFalse(cast._wants_clipfacts({"Mama": {"clips": {"wake": "wake.glb"}}}))
        self.assertFalse(cast._wants_clipfacts({"Mama": {"glb": "body.glb", "clips": {}}}))
        self.assertTrue(cast._wants_clipfacts({"Mama": {"glb": "body.glb", "clips": {"wake": "wake.glb"}}}))

    def test_nonzero_exit_is_a_warning(self):
        ctx = self._ctx(FIX)
        with mock.patch.object(cast.subprocess, "run", return_value=mock.Mock(returncode=1)):
            self.assertEqual(cast.run_cast(ctx), 0.0)
        self.assertIn("CLIPFACTS_FAILED", " ".join(self._marker(ctx)["warnings"]))


if __name__ == "__main__":
    unittest.main()
