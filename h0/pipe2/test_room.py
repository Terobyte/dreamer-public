"""Tests for the per-room pipeline. Offline: fake Spark, fake engine, fake asset queue."""

import json
import tempfile
import unittest
from pathlib import Path

from pipe2.fakes import FakeEngine, FakeSpark
from pipe2.room import Ctx, RoomPipeline, RoomStore


def room(rid, x0, x1):
    return {"id": rid, "level": "L0", "height": 3.0,
            "shape": [[x0, 0], [x1, 0], [x1, 4], [x0, 4]],
            "floor": "grey", "ceiling": "white",
            "walls": {"material": "white", "thickness": 0.12}}


def skeleton():
    return {
        "version": 0, "name": "v2",
        "levels": [{"id": "L0", "y": 0}],
        "rooms": [room("A", 0, 4), room("B", 4, 8)],
        "openings": [
            {"id": "ab", "kind": "door", "at": [4, 2], "width": 0.9, "height": 2.1, "sill": 0},
            {"id": "win", "kind": "window", "at": [2, 0], "width": 1.0, "height": 1.0, "sill": 1.0},
            {"id": "bx", "kind": "door", "at": [8, 2], "width": 0.9, "height": 2.1, "sill": 0},
        ],
        "stairs": [], "spawn": {"room": "A", "at": [1, 1], "yaw": 0},
        "style": {"ambient": 1.0},
        "materials": {"white": {"color": "#eeeae0"}, "grey": {"color": "#888888"}},
        "assets": {}, "props": [],
        "lights": [{"kind": "hemi", "pos": [0, 3, 0], "color": "#ffffff", "power": 0.8}],
        "routes": [],
    }


PLAN = {
    "rooms": {"A": {"max_points": 2, "brief": "Squidward's living room"},
              "B": {"max_points": 2, "brief": "kitchen"}},
    "openings": {"ab": {"owner": "A"}, "win": {"owner": "A"}, "bx": {"owner": "B"}},
    "cues": "stone walls, teal palette",
}


def partial(prompt="oak planks", prop="A_sofa"):
    return {
        "props": [{"id": prop, "room": "A", "asset": "A_t", "at": [1, 0, 1]}],
        "cameras": [{"id": "A_ref1", "at": [1, 1.6, 1], "look": [3, 1, 3]}],
        "assets": {"A_t": {"kind": "tile", "prompt": prompt}},
    }


def answer(obj):
    return "cues: teal\n```json\n%s\n```" % json.dumps(obj)


RED = {"code": 1, "errors": [{"code": "PROP_OUT_OF_ROOM", "path": "/props/0", "id": "A_sofa"}],
       "warnings": []}
GREEN = {"code": 0, "errors": [], "warnings": []}


class FakeAssets:
    """Stand-in for AssetQueue: records `put`, answers `done` from a flag."""

    def __init__(self, ready=False):
        self.puts = []
        self.waits = []
        self.ready = ready

    def put(self, room, keys):
        self.puts.append((room, keys))

    def done(self, room):
        return self.ready

    def wait(self, room):
        self.waits.append(room)


class RoomCase(unittest.TestCase):
    def ctx(self, answers, reports=None, assets=None, flags=None):
        self.work = Path(tempfile.mkdtemp())
        self.spark = FakeSpark(answers)
        self.engine = FakeEngine(reports)
        self.assets = assets or FakeAssets()
        self.store = RoomStore(self.work)
        return Ctx(skeleton=skeleton(), plan=PLAN, spark=self.spark, engine=self.engine,
                   assets=self.assets, store=self.store, work=self.work,
                   effort={"builder": "max", "fix": "high", "critic_layout": "high",
                           "critic_assets": "high"},
                   flags=flags, spec="SPEC-TEXT", schema="SCHEMA-TEXT")

    def asked(self, role):
        return [c for c in self.spark.calls if c["role"] == role]

    def texts(self, call):
        return "\n".join(part["text"] for message in call["messages"]
                         for part in message["content"] if part["type"] == "text")


class TestRoom(RoomCase):
    def test_bad_answer_keeps_last_green(self):
        ctx = self.ctx({"builder": [answer(partial())],
                        "critic_layout": ["sorry, no scene for you"],
                        "critic_assets": ["still no json"]})
        result = RoomPipeline("A", ctx).run()
        self.assertEqual("rolled_back", result.status)
        self.assertEqual(partial(), result.partial)

    def test_red_check_sends_own_findings_without_history(self):
        ctx = self.ctx({"builder": [answer(partial())], "fix": [answer(partial())]},
                       reports=[RED, GREEN, GREEN, GREEN])
        RoomPipeline("A", ctx).run()
        fix = self.asked("fix")
        self.assertEqual(1, len(fix))
        self.assertEqual(0, fix[0]["round_no"])
        self.assertEqual(1, len(fix[0]["messages"]), "no history: one user message")
        self.assertEqual("user", fix[0]["messages"][0]["role"])
        body = self.texts(fix[0])
        self.assertIn("PROP_OUT_OF_ROOM", body)
        self.assertNotIn("cues: teal", body, "the builder's answer is not replayed")

    def test_three_red_rounds_end_empty(self):
        ctx = self.ctx({"builder": [answer(partial())],
                        "fix": [answer(partial()), answer(partial())]},
                       reports=[RED, RED, RED])
        result = RoomPipeline("A", ctx).run()
        self.assertEqual("empty", result.status)
        self.assertEqual({}, result.partial)
        self.assertEqual([], self.asked("critic_layout"))
        self.assertEqual([], self.asked("critic_assets"))

    def test_red_after_layout_critic_rolls_back(self):
        hurt = partial(prop="A_chair")
        ctx = self.ctx({"builder": [answer(partial())], "critic_layout": [answer(hurt)],
                        "critic_assets": [answer(partial())]},
                       reports=[GREEN, RED, GREEN])
        result = RoomPipeline("A", ctx).run()
        self.assertEqual("rolled_back", result.status)
        self.assertEqual([], self.asked("fix"), "critics get no fix rounds")
        critic = self.asked("critic_assets")
        self.assertEqual(1, len(critic))
        self.assertIn("A_sofa", self.texts(critic[0]))
        self.assertNotIn("A_chair", self.texts(critic[0]))

    def test_prompts_are_frozen_and_reissue_happens_once(self):
        reissued = partial(prompt="shiny marble")
        reissued["assets"]["A_t"]["reissue"] = True
        ctx = self.ctx({"builder": [answer(partial())],
                        "critic_layout": [answer(partial(prompt="cheap lino"))],
                        "critic_assets": [answer(reissued)]})
        result = RoomPipeline("A", ctx).run()
        self.assertEqual("green", result.status)
        self.assertEqual("oak planks #v2", result.partial["assets"]["A_t"]["prompt"])
        self.assertNotIn("reissue", result.partial["assets"]["A_t"])
        keys = [spec["key"] for _room, specs in self.assets.puts for spec in specs]
        self.assertIn("A_t:oak planks #v2", keys)

    def test_second_reissue_is_ignored(self):
        def two(first, second, reissue=False):
            out = partial(prompt=first)
            out["assets"]["A_u"] = {"kind": "object", "prompt": second}
            if reissue:
                out["assets"]["A_t"]["reissue"] = True
                out["assets"]["A_u"]["reissue"] = True
            return out

        ctx = self.ctx({"builder": [answer(two("oak planks", "a lamp"))],
                        "critic_layout": [answer(two("oak planks", "a lamp"))],
                        "critic_assets": [answer(two("granite", "a chandelier", reissue=True))]})
        result = RoomPipeline("A", ctx).run()
        assets = result.partial["assets"]
        self.assertEqual("oak planks #v2", assets["A_t"]["prompt"])
        self.assertEqual("a lamp", assets["A_u"]["prompt"], "only one reissue per room")
        kinds = [e["kind"] for e in self.spark.ledger.events]
        self.assertEqual(["reissue", "reissue_ignored"], [k for k in kinds if "reissue" in k])

    def test_both_critics_run_when_meshes_are_ready(self):
        ctx = self.ctx({"builder": [answer(partial())],
                        "critic_layout": [answer(partial())],
                        "critic_assets": [answer(partial())]},
                       assets=FakeAssets(ready=True))
        RoomPipeline("A", ctx).run()
        self.assertEqual(1, len(self.asked("critic_layout")))
        self.assertEqual(1, len(self.asked("critic_assets")))

    def test_store_keeps_every_step(self):
        ctx = self.ctx({"builder": [answer(partial())],
                        "critic_layout": [answer(partial())],
                        "critic_assets": [answer(partial())]})
        result = RoomPipeline("A", ctx).run()
        here = self.work / "rooms" / "A"
        for name in ("builder_0", "critic_layout_0", "critic_assets_0"):
            self.assertTrue((here / (name + ".json")).exists(), name)
            self.assertTrue((here / (name + ".messages.json")).exists(), name)
        self.assertEqual(result.room, json.loads((here / "done.json").read_text())["room"])
        self.assertEqual(partial(), RoomStore(self.work).last_green("A"))

    def test_builder_prompt_names_its_keys_and_openings(self):
        ctx = self.ctx({"builder": ["no json"]})
        RoomPipeline("A", ctx).run()
        body = self.texts(self.asked("builder")[0])
        for key in ("props", "decals", "lights", "cameras", "assets", "materials",
                    "fixtures", "cosmetic"):
            self.assertIn(key, body)
        dress = next(line for line in body.splitlines() if "ONLY these openings" in line)
        self.assertIn("ab", dress)
        self.assertIn("win", dress)
        self.assertNotIn("bx", dress, "another room's opening is not ours to dress")
        self.assertIn("Squidward's living room", body)
        self.assertIn("SCHEMA-TEXT", body)

    def test_critics_see_only_their_own_shots(self):
        ctx = self.ctx({"builder": [answer(partial())],
                        "critic_layout": [answer(partial())],
                        "critic_assets": [answer(partial())]})
        RoomPipeline("A", ctx).run()
        for call in self.asked("critic_layout") + self.asked("critic_assets"):
            shots = [p for p in call["messages"][0]["content"] if p["type"] == "image_url"]
            self.assertEqual(1, len(shots))
            self.assertIn("Objects of another room seen through an opening are not yours.",
                          self.texts(call))
        self.assertEqual(["A_ref1"], self.engine.shot_cameras)


    def test_red_without_own_findings_is_not_accepted(self):
        overlap = {"code": 1, "errors": [{"code": "ROOMS_OVERLAP", "path": "/rooms/0",
                                          "id": "A"}],
                   "warnings": []}
        ctx = self.ctx({"builder": [answer(partial())],
                        "fix": [answer(partial()), answer(partial())]},
                       reports=[overlap, overlap, overlap])
        result = RoomPipeline("A", ctx).run()
        self.assertEqual("empty", result.status)
        self.assertEqual({}, result.partial)
        self.assertIsNone(RoomStore(self.work).last_green("A"))

    def test_fix_prompt_excludes_unowned_findings(self):
        red = {"code": 1, "errors": [
            {"code": "PROP_OUT_OF_ROOM", "path": "/props/0", "id": "A_sofa"},
            {"code": "LEVEL_BAD", "path": "/levels/0", "id": "L0"}],
            "warnings": []}
        ctx = self.ctx({"builder": [answer(partial())], "fix": [answer(partial())]},
                       reports=[red, GREEN, GREEN, GREEN])
        RoomPipeline("A", ctx).run()
        fix = self.asked("fix")
        self.assertEqual(1, len(fix))
        self.assertEqual(1, len(fix[0]["messages"]))
        body = self.texts(fix[0])
        self.assertIn("PROP_OUT_OF_ROOM", body)
        self.assertNotIn("LEVEL_BAD", body)

    def test_critic_assets_gets_saved_green_report(self):
        hurt = partial(prop="A_chair")
        ctx = self.ctx({"builder": [answer(partial())], "critic_layout": [answer(hurt)],
                        "critic_assets": [answer(partial())]},
                       reports=[GREEN, RED, GREEN])
        RoomPipeline("A", ctx).run()
        critic = self.asked("critic_assets")
        self.assertEqual(1, len(critic))
        body = self.texts(critic[0])
        self.assertIn('"code": 0', body)
        self.assertNotIn("PROP_OUT_OF_ROOM", body)

    def test_invalid_fix_keeps_builder_findings(self):
        ctx = self.ctx({"builder": [answer(partial())],
                        "fix": ["sorry, no json", answer(partial())]},
                       reports=[RED, GREEN, GREEN, GREEN, GREEN])
        RoomPipeline("A", ctx).run()
        fix = self.asked("fix")
        self.assertEqual(2, len(fix))
        self.assertEqual(1, len(fix[1]["messages"]), "no history: one user message")
        body = self.texts(fix[1])
        self.assertIn("A_sofa", body)
        self.assertIn("PROP_OUT_OF_ROOM", body)
        self.assertNotIn("sorry, no json", body)

    def test_invalid_critic_still_writes_artifacts(self):
        ctx = self.ctx({"builder": [answer(partial())],
                        "critic_layout": ["sorry, no scene"],
                        "critic_assets": ["still no json"]})
        RoomPipeline("A", ctx).run()
        here = self.work / "rooms" / "A"
        self.assertTrue((here / "critic_layout_0.json").exists())
        self.assertTrue((here / "critic_layout_0.messages.json").exists())

    def test_completed_room_resumes_without_reasking(self):
        ctx = self.ctx({"builder": [answer(partial())],
                        "critic_layout": [answer(partial())],
                        "critic_assets": [answer(partial())]})
        RoomPipeline("A", ctx).run()
        before = len(self.asked("builder"))
        RoomPipeline("A", ctx).run()
        self.assertEqual(before, len(self.asked("builder")))
        self.assertEqual(1, len(self.asked("builder")))

    def test_builder_prompt_has_full_row_fields(self):
        ctx = self.ctx({"builder": ["no json"]})
        RoomPipeline("A", ctx).run()
        body = self.texts(self.asked("builder")[0])
        self.assertIn("max_points", body)

    def test_messages_json_images_are_reconstructible(self):
        ctx = self.ctx({"builder": [answer(partial())],
                        "critic_layout": [answer(partial())],
                        "critic_assets": [answer(partial())]})
        RoomPipeline("A", ctx).run()
        here = self.work / "rooms" / "A"
        stored = json.loads((here / "critic_layout_0.messages.json").read_text())
        images = [p for p in stored["messages"][0]["content"] if p["type"] == "image_url"] \
            if "messages" in stored else \
            [p for p in stored[0]["content"] if p["type"] == "image_url"]
        self.assertEqual(1, len(images))
        rel = images[0]["path"]
        on_disk = here / rel
        self.assertTrue(on_disk.exists(), rel)
        self.assertTrue(on_disk.read_bytes().startswith(b"\x89PNG"))

    def test_critics_exclude_foreign_camera_shots(self):
        skel = skeleton()
        skel["cameras"] = [{"id": "B_ref1", "at": [5, 1.6, 1], "look": [6, 1, 3]}]
        work = Path(tempfile.mkdtemp())
        spark = FakeSpark({"builder": [answer(partial())],
                           "critic_layout": [answer(partial())],
                           "critic_assets": [answer(partial())]})
        engine = FakeEngine()
        store = RoomStore(work)
        ctx = Ctx(skeleton=skel, plan=PLAN, spark=spark, engine=engine,
                  assets=FakeAssets(), store=store, work=work,
                  effort={"builder": "max", "fix": "high", "critic_layout": "high",
                          "critic_assets": "high"},
                  flags=None, spec="SPEC-TEXT", schema="SCHEMA-TEXT")
        RoomPipeline("A", ctx).run()
        calls = [c for c in spark.calls if c["role"] in ("critic_layout", "critic_assets")]
        self.assertEqual(2, len(calls))
        layout_shot = work / "rooms" / "A" / "dist_layout" / "shots" / "B_ref1.png"
        assets_shot = work / "rooms" / "A" / "dist_assets" / "shots" / "B_ref1.png"
        self.assertTrue(layout_shot.exists() or assets_shot.exists(),
                        "fixture must contain a foreign-camera screenshot to exclude")
        for call in calls:
            names = [p.get("name") for p in call["messages"][0]["content"]
                     if p["type"] == "image_url"]
            self.assertGreater(len(names), 0, "critics get their own shots")
            for name in names:
                self.assertTrue(name.startswith("A_"), name)
                self.assertNotIn("B_ref1", name)
            attached = " ".join(names)
            self.assertNotIn("B_ref1", attached)

    def test_sidecar_images_with_same_basename_dont_collide(self):
        ctx = self.ctx({"builder": [answer(partial())],
                        "critic_layout": [answer(partial())],
                        "critic_assets": [answer(partial())]})
        dir1 = Path(tempfile.mkdtemp())
        dir2 = Path(tempfile.mkdtemp())
        ref1 = dir1 / "ref.png"
        ref2 = dir2 / "ref.png"
        ref1.write_bytes(b"\x89PNG" + b"1" * 20)
        ref2.write_bytes(b"\x89PNG" + b"2" * 20)
        ctx.plan["rooms"]["A"]["refs"] = [str(ref1), str(ref2)]
        RoomPipeline("A", ctx).run()
        here = self.work / "rooms" / "A"
        stored = json.loads((here / "builder_0.messages.json").read_text())
        images = [p for p in stored[0]["content"] if p["type"] == "image_url"]
        self.assertEqual(2, len(images))
        paths = [here / p["path"] for p in images]
        self.assertEqual(2, len(set(str(p) for p in paths)),
                         "each same-basename image needs its own sidecar path")
        self.assertTrue(all(p.exists() for p in paths))
        contents = [p.read_bytes() for p in paths]
        self.assertNotEqual(contents[0], contents[1],
                            "second image must not overwrite the first")

    def test_critic_sees_shot_for_camera_id_with_slash(self):
        with_slash = partial()
        with_slash["cameras"] = [{"id": "A_g/left", "at": [1, 1.6, 1], "look": [3, 1, 3]}]
        ctx = self.ctx({"builder": [answer(with_slash)],
                        "critic_layout": [answer(with_slash)],
                        "critic_assets": [answer(with_slash)]})
        RoomPipeline("A", ctx).run()
        calls = self.asked("critic_layout")
        self.assertEqual(1, len(calls))
        shots = [p for p in calls[0]["messages"][0]["content"] if p["type"] == "image_url"]
        self.assertEqual(1, len(shots),
                         "a camera id containing a slash must still produce an attached shot")

    def test_critic_sees_shots_for_colliding_camera_ids(self):
        both = partial()
        both["cameras"] = [{"id": "A_g/left", "at": [1, 1.6, 1], "look": [3, 1, 3]},
                           {"id": "A_g_left", "at": [2, 1.6, 1], "look": [3, 1, 3]}]
        ctx = self.ctx({"builder": [answer(both)], "critic_layout": [answer(both)],
                        "critic_assets": [answer(both)]})
        RoomPipeline("A", ctx).run()
        calls = self.asked("critic_layout")
        shots = [p for p in calls[0]["messages"][0]["content"] if p["type"] == "image_url"]
        self.assertEqual(2, len({p["name"] for p in shots}),
                         "two ids that sanitize to the same name keep two distinct shots")

    def test_crash_leaves_the_room_resumable(self):
        assets = FakeAssets()

        def boom(room):
            raise RuntimeError("asset worker died")

        assets.wait = boom
        ctx = self.ctx({"builder": [answer(partial())], "critic_layout": [answer(partial())]},
                       assets=assets)
        with self.assertRaises(RuntimeError):
            RoomPipeline("A", ctx).run()
        self.assertFalse((self.work / "rooms" / "A" / "done.json").exists(),
                         "an interrupted room must not look finished to a resumed run")

    def test_fix_prompt_tells_a_red_check_from_a_bad_answer(self):
        overlap = {"code": 1, "errors": [{"code": "ROOMS_OVERLAP", "path": "/rooms/0",
                                          "id": "A"}],
                   "warnings": []}
        ctx = self.ctx({"builder": [answer(partial())], "fix": ["no json", answer(partial())]},
                       reports=[overlap, overlap, GREEN, GREEN, GREEN])
        RoomPipeline("A", ctx).run()
        fix = self.asked("fix")
        self.assertNotIn("json", self.texts(fix[0]).split("## Findings")[1].split("##")[0],
                         "a valid answer with no findings of ours is not a json complaint")
        self.assertIn("json", self.texts(fix[1]).split("## Findings")[1].split("##")[0],
                      "an invalid answer is reported as such")

    def test_builder_prompt_asks_a_camera_per_reference(self):
        ctx = self.ctx({"builder": ["no json"]})
        folder = Path(tempfile.mkdtemp())
        refs = []
        for i in (1, 2):
            ref = folder / ("ref%d.png" % i)
            ref.write_bytes(b"\x89PNG" + bytes([i]) * 20)
            refs.append(str(ref))
        ctx.plan = json.loads(json.dumps(PLAN))
        ctx.plan["rooms"]["A"]["refs"] = refs
        RoomPipeline("A", ctx).run()
        body = self.texts(self.asked("builder")[0])
        self.assertIn("A_ref1", body)
        self.assertIn("A_ref2", body, "two refs need two cameras, one per viewpoint")

    def test_unsafe_room_id_is_refused(self):
        root = Path(tempfile.mkdtemp())
        store = RoomStore(root / "work")
        for bad in (str(root / "escape"), "../escape", "..", "", "a/b"):
            with self.assertRaises(ValueError, msg=bad):
                store.save(bad, "builder", 0, {})
        self.assertFalse((root / "escape").exists())
        self.assertFalse((root / "work" / "escape").exists())

    def test_failed_preview_attaches_no_stale_shots(self):
        ctx = self.ctx({"builder": [answer(partial())],
                        "critic_layout": [answer(partial())],
                        "critic_assets": [answer(partial())]})
        stale = self.work / "rooms" / "A" / "dist_layout" / "shots"
        stale.mkdir(parents=True)
        (stale / "A_ref1.png").write_bytes(b"\x89PNG stale")
        (self.work / "rooms" / "A" / "dist_assets" / "shots").mkdir(parents=True)
        (self.work / "rooms" / "A" / "dist_assets" / "shots" / "A_ref1.png").write_bytes(b"old")

        def broken(*_args, **_kwargs):
            raise RuntimeError("build failed")
        self.engine.build = broken
        RoomPipeline("A", ctx).run()
        for role in ("critic_layout", "critic_assets"):
            shots = [p for p in self.asked(role)[0]["messages"][0]["content"]
                     if p["type"] == "image_url"]
            self.assertEqual([], shots, "%s got a picture of an older scene" % role)

    def test_critic_new_asset_is_queued(self):
        grown = partial()
        grown["assets"]["A_rug"] = {"kind": "object", "prompt": "red rug"}
        ctx = self.ctx({"builder": [answer(partial())],
                        "critic_layout": [answer(grown)],
                        "critic_assets": [answer(grown)]})
        RoomPipeline("A", ctx).run()
        queued = [spec["id"] for _room, specs in self.assets.puts for spec in specs]
        self.assertIn("A_rug", queued, "a key the critic added must reach the queue")
        self.assertEqual(1, queued.count("A_rug"), "queued once, not again by the next critic")


if __name__ == "__main__":
    unittest.main()
