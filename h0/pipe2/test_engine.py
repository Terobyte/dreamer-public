"""Tests for the dreamer CLI adapter. The only tests that run the real engine.

Every scene here is either `specs/examples/*` or built in the test; nothing is
written outside `tempfile.mkdtemp()`, and `build` is always `--assets none`.
"""

import copy
import json
import os
import shutil
import subprocess
import tempfile
import threading
import time
import unittest

from pipe2.engine import Engine, EngineError, Gated, blocking, green, scene_for_room
from pipe2.merge import owner_of

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ENGINE = os.path.join(REPO, "engine")
EXAMPLES = os.path.join(REPO, "specs", "examples")


def example(name):
    with open(os.path.join(EXAMPLES, name), encoding="utf-8") as fh:
        return json.load(fh)


def doorway_scene():
    """demo-flat with a hall prop standing in the `front` doorway."""
    scene = example("demo-flat.scene.json")
    scene["props"].append({
        "id": "crate", "asset": "p_table", "cat": "table", "room": "hall",
        "at": [0, 4.5], "size": {"w": 0.6, "d": 0.6, "h": 0.75},
        "mount": "floor", "yaw": 0, "solid": True,
    })
    return scene


def cut_scene():
    """demo-flat with a prop walling the hall off: `living` becomes unreachable."""
    scene = example("demo-flat.scene.json")
    scene["props"].append({
        "id": "barricade", "asset": "p_sofa", "cat": "sofa", "room": "hall",
        "at": [0, 8], "size": {"w": 3.2, "d": 0.9, "h": 0.85},
        "mount": "floor", "yaw": 0, "solid": True,
    })
    return scene


def codes(issues):
    return [i.get("code") for i in issues]


class EngineTest(unittest.TestCase):
    def setUp(self):
        self.work = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.work, True)
        self.engine = Engine(ENGINE, shots=False)

    def test_check_demo_is_green(self):
        report = self.engine.check(example("demo.scene.json"), self.work)
        self.assertEqual(0, report["code"], report["raw"])
        self.assertEqual([], report["errors"])
        self.assertTrue(green(report))

    def test_prop_in_doorway_blames_its_room(self):
        scene = doorway_scene()
        report = self.engine.check(scene, self.work)
        found = [i for i in report["errors"] if i.get("code") == "PROP_IN_DOORWAY"]
        self.assertTrue(found, codes(report["errors"]) or report["raw"])
        self.assertEqual("hall", owner_of(scene, found[0]))

    def test_asset_keys_match_engine_cache_key(self):
        scene = example("demo.scene.json")
        scene["assets"]["p_unused"] = {"kind": "object", "prompt": "nothing refers to this"}
        rows = self.engine.asset_keys(scene)
        self.assertTrue(rows)
        self.assertNotIn("p_unused", [r["id"] for r in rows])
        want = [[r["id"], scene["assets"][r["id"]]["kind"],
                 scene["assets"][r["id"]].get("prompt", ""),
                 scene["assets"][r["id"]].get("aspect", "1:1")] for r in rows]
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        snippet = os.path.join(tmp, "keys_check.ts")
        with open(snippet, "w", encoding="utf-8") as fh:
            fh.write(
                'import { cacheKey } from "%s/src/assets/cache.ts";\n'
                "const rows = JSON.parse(process.argv[2]);\n"
                "console.log(JSON.stringify(rows.map((r: any) => cacheKey(r[1], r[2], r[3]))));\n"
                % ENGINE
            )
        out = subprocess.run(["node", "--import", "tsx", snippet, json.dumps(want)],
                             cwd=ENGINE, capture_output=True, text=True)
        self.assertEqual(0, out.returncode, out.stderr)
        self.assertEqual(json.loads(out.stdout)[: len(rows)], [r["key"] for r in rows])

    def test_keys_carry_no_budget(self):
        # the cache holds the full mesh; `build` cuts it per scene, so no row asks for a triangle count
        scene = example("demo.scene.json")
        rows = {r["id"]: r for r in self.engine.asset_keys(scene)}
        self.assertIn("p_vase", rows)
        self.assertIn("t_wall", rows)
        for r in rows.values():
            self.assertNotIn("tris", r)
        big = copy.deepcopy(scene)
        vase = next(p for p in big["props"] if p["asset"] == "p_vase")
        big["props"].append({**vase, "id": "big_vase", "size": {"w": 1, "d": 1, "h": 3}})
        big_rows = {r["id"]: r for r in self.engine.asset_keys(big)}
        self.assertEqual(rows["p_vase"]["key"], big_rows["p_vase"]["key"])     # one GLB for both sizes

    def test_build_room_scene_and_shots(self):
        skeleton = example("demo-flat.scene.json")
        sofa = copy.deepcopy(next(p for p in skeleton["props"] if p["id"] == "sofa"))
        sofa["id"] = "living_sofa"
        partials = {"living": {"props": [sofa]}, "hall": {"props": []}}
        skeleton["props"] = []
        scene = scene_for_room(skeleton, partials, {}, "living")
        self.assertEqual(["living_sofa"], [p["id"] for p in scene["props"]])
        out = os.path.join(self.work, "dist")
        self.engine.build(scene, out, "none", None)
        self.assertTrue(os.path.exists(os.path.join(out, "index.html")))
        if not self._has_chromium():
            self.skipTest("no engine Chromium in this environment")
        Engine(ENGINE).shots(out)
        self.assertTrue(os.listdir(out))

    def _has_chromium(self):
        for root, _dirs, files in os.walk(os.path.join(ENGINE, "node_modules", ".cache")):
            if any(f.startswith("chrome") or f.startswith("headless") for f in files):
                return True
        return bool(os.environ.get("CHROME_PATH"))

    def test_check_full_adds_route_blocked(self):
        scene = cut_scene()
        plain = self.engine.check(scene, self.work)
        self.assertNotIn("ROUTE_BLOCKED", codes(plain["errors"] + plain["warnings"]))
        full = self.engine.check_full(scene, self.work)
        found = codes(full["errors"] + full["warnings"])
        self.assertIn("NAV_ROOM_CUT", found)
        self.assertIn("ROUTE_BLOCKED", found)
        self.assertFalse(green(full))
        self.assertIn("NAV_ROOM_CUT", codes(blocking(full)))
        self.assertIn("ROUTE_BLOCKED", codes(blocking(full)))

    def test_check_full_without_shots_is_not_shot_missing(self):
        # check --built wants a picture per camera (engine block E); a run that does not shoot must not
        # blame every room with a camera for it (Oct 30: all rooms ended empty on SHOT_MISSING)
        full = self.engine.check_full(example("demo-flat.scene.json"), self.work)
        self.assertNotIn("SHOT_MISSING", codes(full["errors"] + full["warnings"]))
        self.assertTrue(green(full), full["errors"])

    def test_check_full_shoots_before_check_built(self):
        if not self._has_chromium():
            self.skipTest("no engine Chromium in this environment")
        full = Engine(ENGINE).check_full(example("demo-flat.scene.json"), self.work)
        self.assertNotIn("SHOT_MISSING", codes(full["errors"] + full["warnings"]))

    def test_harmless_warnings_stay_green(self):
        report = {"code": 0, "errors": [], "warnings": [{"code": "PROP_TINY", "path": "/props/0"}], "raw": ""}
        self.assertEqual([], blocking(report))
        self.assertTrue(green(report))
        Engine(ENGINE, shots=False).shots(os.path.join(self.work, "nowhere"))

    def test_report_cache_skips_the_cli(self):
        engine = Engine(ENGINE, shots=False)
        runs = []
        real = engine._run

        def counting(args):
            runs.append(args[0])
            return real(args)

        engine._run = counting
        scene = example("demo.scene.json")
        engine.check_full(scene, self.work)
        first = len(runs)
        self.assertTrue(first)
        engine.check_full(scene, self.work)
        self.assertEqual(first, len(runs))
        other = copy.deepcopy(scene)
        other["style"]["ambient"] = 0.9
        engine.check_full(other, self.work)
        self.assertGreater(len(runs), first)

    def test_concurrent_check_runs_cli_once(self):
        engine = Engine(ENGINE, shots=False)
        runs = []
        lock = threading.Lock()
        real = engine._run

        def counting(args):
            with lock:
                runs.append(args[0])
            time.sleep(0.5)
            return real(args)

        engine._run = counting
        scene = example("demo.scene.json")
        results = []

        def do():
            results.append(engine.check(scene, self.work))

        threads = [threading.Thread(target=do) for _ in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=60)
        self.assertEqual(1, len(runs))
        self.assertIs(results[0], results[1])

    def test_bad_exit_raises(self):
        engine = Engine(ENGINE, shots=False)
        with self.assertRaises(EngineError) as caught:
            engine.check({"version": 0, "name": "x"}, self.work, built=self.work)
        self.assertEqual(2, caught.exception.code)


class FakeForGate:
    """Stands in for the engine: counts how many builds overlap."""

    def __init__(self):
        self.lock = threading.Lock()
        self.live = 0
        self.peak = 0
        self.checks = 0

    def _enter(self):
        with self.lock:
            self.live += 1
            self.peak = max(self.peak, self.live)
        time.sleep(0.05)
        with self.lock:
            self.live -= 1

    def build(self, scene, out, assets, cache):
        self._enter()

    def shots(self, dist, size="960x720"):
        self._enter()

    def check(self, scene, work, built=None):
        self.checks += 1
        return {"code": 0, "errors": [], "warnings": [], "raw": ""}

    def check_full(self, scene, work):
        return self.check(scene, work)

    def asset_keys(self, scene):
        return []


class GatedTest(unittest.TestCase):
    def test_two_at_a_time(self):
        fake = FakeForGate()
        gated = Gated(fake, n=2)
        threads = [threading.Thread(target=gated.build, args=({}, "out", "none", None))
                   for _ in range(3)]
        threads += [threading.Thread(target=gated.shots, args=("dist",)) for _ in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertLessEqual(fake.peak, 2)
        self.assertEqual({"code": 0, "errors": [], "warnings": [], "raw": ""},
                         gated.check({}, "work"))
        self.assertEqual(1, fake.checks)
        self.assertEqual([], gated.asset_keys({}))

    def test_check_skips_full_slots(self):
        fake = FakeForGate()
        gated = Gated(fake, n=2)
        gated._slots.acquire()
        gated._slots.acquire()
        try:
            done = []
            t = threading.Thread(target=lambda: done.append(gated.check({}, "work")))
            t.start()
            t.join(timeout=10)
            self.assertFalse(t.is_alive(), "check waited on the build/shots semaphore")
            self.assertEqual(1, len(done))
        finally:
            gated._slots.release()
            gated._slots.release()
        self.assertEqual(1, fake.checks)


if __name__ == "__main__":
    unittest.main()
