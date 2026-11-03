"""Камера, полоса B v2: стадия shotplan — Spark выбирает приём на бит. Без сети и без живого Spark."""
import dataclasses
import io
import json
import shutil
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

from make import core, film, shotplan, story
from make.__main__ import main

FIX = Path(__file__).resolve().parent / "testdata" / "shotplan_koshakan"
CAT = json.loads((FIX / "catalog.json").read_text())

EXAMPLE = {"version": 1, "scene": "bedroom", "style": "storybook",
           "beats": {"2": {"move": "follow_side", "subject": {"actor": "Mama"}},
                     "3": {"move": "close", "subject": {"actor": "Mirai"}},
                     "4": {"hold": True}},
           "warnings": ["MOVE_UNKNOWN B1 zoomzoom"]}


def build_run(root, edit=None):
    rd = Path(root) / "run"
    for sub, name in (("story", "score.json"), ("stage", "stage.json"),
                      ("stage", "places.json"), ("cast", "cast.json")):
        (rd / sub).mkdir(parents=True, exist_ok=True)
        shutil.copy(FIX / name, rd / sub / name)
    if edit:
        p = rd / "story" / "score.json"
        sc = json.loads(p.read_text())
        edit(sc)
        p.write_text(json.dumps(sc))
    return rd


def good_scene():
    return {"beats": [{"beat": 2, "move": "follow_side", "subject": {"actor": "Mama"}},
                      {"beat": 3, "move": "close", "subject": {"actor": "Mirai"}},
                      {"beat": 4, "hold": True},
                      {"beat": 1, "move": "zoomzoom", "subject": {"actor": "Mama"}}]}


class FakeSpark:
    def __init__(self, scenes):
        self.scenes = list(scenes)
        self.msgs = []

    def ask(self, role, room, round_no, messages, effort):
        self.msgs.append(messages)
        sc = self.scenes.pop(0)
        return mock.Mock(valid=sc is not None, scene=sc)


def ctx_for(rd, **opts):
    out = Path(rd) / "shotplan"
    out.mkdir(exist_ok=True)
    return core.Ctx(Path(rd), out, {}, False, None, dict({"fake": False, "live": True}, **opts))


def run_with(rd, scenes, **opts):
    fake = FakeSpark(scenes)
    ledger = mock.Mock(spent=0.0)
    ctx = ctx_for(rd, **opts)
    with mock.patch.object(shotplan, "catalog", return_value=CAT), \
            mock.patch.object(shotplan, "_make_spark", return_value=(fake, ledger)):
        shotplan.run_shotplan(ctx)
    p = ctx.out / "moves.json"
    return fake, ctx, (json.loads(p.read_text()) if p.is_file() else None)


class Base(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.rd = build_run(self._tmp.name)
        self.score = json.loads((self.rd / "story" / "score.json").read_text())


class TestR1Dag(unittest.TestCase):
    def test_r1_stage_in_dag(self):
        st = core.default_stages()["shotplan"]
        self.assertEqual(st.deps, ("stage",))
        self.assertEqual(st.params, ("fake", "camera_style"))
        self.assertEqual(sum(core.DEFAULT_SPLIT.values()), 100)
        self.assertEqual(core.DEFAULT_SPLIT["shotplan"], 2)
        self.assertEqual(core.DEFAULT_SPLIT["story"], 8)


class TestR2StageJson(unittest.TestCase):
    def test_r2_moves_field_and_version(self):
        self.assertEqual(core.default_stages()["stage"].version, 3)
        with tempfile.TemporaryDirectory() as t:
            rd = Path(t) / "run"
            (rd / "stage").mkdir(parents=True)
            ctx = core.Ctx(rd, rd / "stage", {}, False, None, {"fake": True})
            story.run_stage(ctx)
            sj = json.loads((rd / "stage" / "stage.json").read_text())
            self.assertEqual(sj["moves"], "shotplan/moves.json")


class TestR3CameraStyle(unittest.TestCase):
    def test_r3_style_rehashes_shotplan_only(self):
        self.assertIn("camera_style", core.OPTIONAL_PARAMS)
        with tempfile.TemporaryDirectory() as t:
            rd = Path(t) / "run"
            a = core.run_make(rd, "p", fake=True, live=True, camera_style="ozu")
            self.assertEqual(a["shotplan"], "ran")
            b = core.run_make(rd, "p", fake=True, live=True, camera_style="ozu")
            self.assertEqual(b["shotplan"], "cached")
            c = core.run_make(rd, "p", fake=True, live=True, camera_style="anderson")
            self.assertEqual(c["shotplan"], "ran")
            self.assertEqual(c["stage"], "cached")

    def test_r3_cli_flag(self):
        with tempfile.TemporaryDirectory() as t, mock.patch.object(core, "run_make", return_value={}) as rm:
            main(["p", "--fake", "--run", t, "--camera-style", "ozu"])
            self.assertEqual(rm.call_args.kwargs["camera_style"], "ozu")


class TestR4Prompt(Base):
    def test_r4_prompt(self):
        p = shotplan.prompt(self.rd, CAT, "storybook")
        allowed = (set(CAT["moves"]) | (set(CAT["schemes"]) - {"oner", "rhythm_cut", "open_from_light"})
                   | set(CAT["records"]))
        for i in allowed:
            self.assertIn(i, p)
        self.assertNotIn("oner", p)
        self.assertNotIn("rhythm_cut", p)
        self.assertTrue(any("push_in" in l and "3" in l for l in p.splitlines()))
        self.assertTrue(any("Mirai" in l and "lie" in l for l in p.splitlines()))
        for name in ("bed", "nightstand", "Mama"):
            self.assertIn(name, p)
        b2 = [l for l in p.splitlines() if "Mama: goto bed, pose sit, look Mirai" in l]
        self.assertTrue(b2)
        self.assertIn("2", b2[0])
        self.assertIn("СМЕНА", b2[0])
        self.assertEqual(p, shotplan.prompt(self.rd, CAT, "storybook"))


class TestR5Parse(Base):
    def parse(self, scene):
        return shotplan.parse(scene, CAT, self.score)

    def test_r5_not_object_or_beats_not_list(self):
        for bad in (None, [], {"beats": "x"}, {}):
            r, w = self.parse(bad)
            self.assertIsNone(r)
            self.assertTrue(w)

    def test_r5_beat_invalid_and_duplicate(self):
        for el in ({"beat": "1", "move": "close", "subject": {"actor": "Mama"}},
                   {"beat": 99, "move": "close", "subject": {"actor": "Mama"}},
                   {"beat": -1, "move": "close", "subject": {"actor": "Mama"}},
                   {"beat": True, "move": "close", "subject": {"actor": "Mama"}}):
            r, w = self.parse({"beats": [el]})
            self.assertEqual(r["beats"], {})
            self.assertEqual(len(w), 1)
            self.assertTrue(w[0].startswith("BEAT_INVALID"))
        ok = {"beat": 1, "move": "close", "subject": {"actor": "Mama"}}
        r, w = self.parse({"beats": [ok, dict(ok)]})
        self.assertEqual(list(r["beats"]), ["1"])
        self.assertEqual(w, ["BEAT_INVALID B1"])

    def test_r5_duplicate_after_rejected(self):
        bad = {"beat": 1, "move": "nope", "subject": {"actor": "Mama"}}
        ok = {"beat": 1, "move": "close", "subject": {"actor": "Mama"}}
        r, w = self.parse({"beats": [bad, ok]})
        self.assertEqual(r["beats"], {})
        self.assertEqual(w, ["MOVE_UNKNOWN B1 nope", "BEAT_INVALID B1"])

    def test_r5_unhashable_subject(self):
        for s in ({"actor": []}, {"actor": {"a": 1}}, {"actor": 5}, {"pair": [[], "Mama"]}):
            r, w = self.parse({"beats": [{"beat": 1, "move": "close", "subject": s}]})
            self.assertEqual(r["beats"], {}, s)
            self.assertEqual(w, ["SUBJECT_INVALID B1"], s)

    def test_r5_move_unknown(self):
        r, w = self.parse({"beats": [{"beat": 1, "move": "oner", "subject": {"actor": "Mama"}}]})
        self.assertEqual(r["beats"], {})
        self.assertEqual(w, ["MOVE_UNKNOWN B1 oner"])

    def test_r5_subject_invalid(self):
        for s in ({"actor": "Nobody"}, {"pair": ["Mama"]}, {"pair": ["Mama", "Mama"]},
                  {"room": True}, {}, "Mama"):
            r, w = self.parse({"beats": [{"beat": 1, "move": "close", "subject": s}]})
            self.assertEqual(r["beats"], {}, s)
            self.assertEqual(w, ["SUBJECT_INVALID B1"], s)
        r, w = self.parse({"beats": [{"beat": 1, "move": "wide", "subject": {"room": True}},
                                     {"beat": 2, "move": "close", "subject": {"pair": ["Mama", "Mirai"]}}]})
        self.assertEqual(set(r["beats"]), {"1", "2"})
        self.assertEqual(w, [])

    def test_r5_hold_first(self):
        r, w = self.parse({"beats": [{"beat": 0, "hold": True}, {"beat": 1, "hold": True}]})
        self.assertEqual(r["beats"], {"1": {"hold": True}})
        self.assertEqual(w, ["HOLD_FIRST"])

    def test_r5_empty_element(self):
        r, w = self.parse({"beats": [{}]})
        self.assertIsNotNone(r)
        self.assertEqual(r["beats"], {})
        self.assertTrue(w)


class TestR6Calls(Base):
    def test_r6_retry_with_error_text(self):
        fake, ctx, mv = run_with(self.rd, [{"beats": "x"}, good_scene()])
        self.assertEqual(len(fake.msgs), 2)
        _, err = shotplan.parse({"beats": "x"}, CAT, self.score)
        self.assertIn(err[0] if isinstance(err, list) else err, json.dumps(fake.msgs[1], ensure_ascii=False))
        self.assertIsNotNone(mv)

    def test_r6_two_bad_no_file(self):
        fake, ctx, mv = run_with(self.rd, [None, {"beats": 1}])
        self.assertEqual(len(fake.msgs), 2)
        self.assertIsNone(mv)
        self.assertIn("SHOTPLAN_INVALID", (ctx.out / "marker.txt").read_text() + "".join(
            p.read_text() for p in ctx.out.iterdir() if p.is_file()))

    def test_r6_spend_charged(self):
        fake = FakeSpark([good_scene()])
        ledger = mock.Mock(spent=0.07)
        ctx = ctx_for(self.rd)
        with mock.patch.object(shotplan, "catalog", return_value=CAT), \
                mock.patch.object(shotplan, "_make_spark", return_value=(fake, ledger)):
            shotplan.run_shotplan(ctx)
        self.assertAlmostEqual(ctx.usd, 0.07)

    def test_r6_no_catalog(self):
        ctx = ctx_for(self.rd)
        with mock.patch.object(shotplan, "catalog", side_effect=OSError("no bridge")):
            shotplan.run_shotplan(ctx)
        self.assertFalse((ctx.out / "moves.json").exists())
        self.assertIn("SHOTPLAN_NO_CATALOG", "".join(p.read_text() for p in ctx.out.iterdir() if p.is_file()))


class TestR7Style(Base):
    def test_r7_given_known(self):
        _, _, mv = run_with(self.rd, [good_scene()], camera_style="ozu")
        self.assertEqual(mv["style"], "ozu")

    def test_r7_given_unknown_still_asks(self):
        fake, _, mv = run_with(self.rd, [good_scene()], camera_style="nope")
        self.assertEqual(len(fake.msgs), 1)
        self.assertEqual(mv["style"], "storybook")
        self.assertIn("STYLE_UNKNOWN nope", mv["warnings"])

    def test_r7_from_answer(self):
        _, _, mv = run_with(self.rd, [dict(good_scene(), style="kubrick")])
        self.assertEqual(mv["style"], "kubrick")
        _, _, mv = run_with(self.rd, [dict(good_scene(), style="zzz")])
        self.assertEqual(mv["style"], "storybook")
        self.assertIn("STYLE_UNKNOWN zzz", mv["warnings"])
        _, _, mv = run_with(self.rd, [good_scene()])
        self.assertEqual(mv["style"], "storybook")


class TestR8Write(Base):
    def test_r8_exact_file_and_bytes(self):
        _, ctx, mv = run_with(self.rd, [good_scene()])
        self.assertEqual(mv, EXAMPLE)
        raw = (ctx.out / "moves.json").read_bytes()
        self.assertEqual(raw, (json.dumps(EXAMPLE, indent=2, sort_keys=True, ensure_ascii=False) + "\n").encode())
        _, ctx2, _ = run_with(self.rd, [good_scene()])
        self.assertEqual(raw, (ctx2.out / "moves.json").read_bytes())


class TestR9Fake(unittest.TestCase):
    def test_r9_fake_writes_empty_plan(self):
        with tempfile.TemporaryDirectory() as t:
            rd = build_run(t)
            ctx = ctx_for(rd, fake=True)
            ctx.params["fake"] = True
            with mock.patch.object(shotplan, "catalog", return_value=CAT), \
                    mock.patch.object(shotplan, "_make_spark", side_effect=AssertionError("spark")):
                shotplan.run_shotplan(ctx)
            mv = json.loads((ctx.out / "moves.json").read_text())
            self.assertEqual(mv["beats"], {})
            self.assertEqual(mv["style"], "storybook")
            with mock.patch.object(shotplan, "catalog", side_effect=OSError("x")):
                shotplan.run_shotplan(ctx_for(rd, fake=True, camera_style="ozu"))
            self.assertEqual(json.loads((ctx.out / "moves.json").read_text())["style"], "ozu")

    def test_r9_make_fake_twice_equal(self):
        with tempfile.TemporaryDirectory() as t:
            rd = Path(t) / "run"
            blobs = []
            for _ in range(2):
                with mock.patch("urllib.request.urlopen", side_effect=AssertionError("net")), \
                        mock.patch.object(shotplan, "catalog", return_value=CAT), redirect_stdout(io.StringIO()):
                    self.assertEqual(main(["p", "--fake", "--fresh", "--run", str(rd)]), 0)
                blobs.append((rd / "shotplan" / "moves.json").read_bytes())
            self.assertEqual(blobs[0], blobs[1])
            self.assertEqual(json.loads(blobs[0])["beats"], {})

    def test_r9_no_flags_skips(self):
        with tempfile.TemporaryDirectory() as t:
            rd = Path(t) / "run"
            core.run_make(rd, "p")
            self.assertFalse((rd / "shotplan" / "moves.json").exists())


class TestR10Film(unittest.TestCase):
    def test_r10_page_url(self):
        self.assertIn("&camera_style=ozu", film.page_url("/tmp/x", 1, 2, "ozu"))
        self.assertNotIn("camera_style", film.page_url("/tmp/x", 1, 2))
        self.assertNotIn("camera_style", film.page_url("/tmp/x", 1, 2, None))

    def test_r10_cli_flag(self):
        with mock.patch.object(film, "film") as f:
            film.main(["r", "--out", "o.mp4", "--camera-style", "ozu"])
            self.assertEqual(f.call_args.kwargs["camera_style"], "ozu")


if __name__ == "__main__":
    unittest.main()
