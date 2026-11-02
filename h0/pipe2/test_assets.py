"""Tests for the asset queue. Offline: fake providers, fake clock, no engine."""

import threading
import unittest
from pathlib import Path
import tempfile

from pipe2.assets import AssetQueue


class Clock:
    """Fake time: nothing really sleeps, every `sleep` moves the clock forward."""

    def __init__(self):
        self.t = 0.0
        self._lock = threading.Lock()

    def __call__(self):
        return self.t

    def sleep(self, seconds):
        with self._lock:
            self.t += seconds


class FakeLedger:
    def __init__(self, allow=True):
        self.allowed = allow
        self.calls = []
        self.events = []

    def cost_of(self, kind, units):
        return (1.0 if kind == "image" else 0.01) * (units if isinstance(units, (int, float)) else 1)

    def allow(self, kind, estimate_usd, reserve_tokens=0):
        self.calls.append(("allow", kind, estimate_usd))
        return self.allowed

    def charge(self, kind, units, reserved=0.0):
        self.calls.append(("charge", kind, units, reserved))
        return 0.0

    def record(self, event):
        self.events.append(event)


class FakeImages:
    def __init__(self, png=b"png", fail=False):
        self.png = png
        self.fail = fail
        self.seen = []
        self._lock = threading.Lock()

    def generate(self, prompt, size):
        with self._lock:
            self.seen.append((prompt, size))
        if self.fail:
            raise RuntimeError("no image")
        return self.png


class FakeHandle:
    def __init__(self, glb, sec=12.0, hang=False):
        self.glb = glb
        self.sec = sec
        self.hang = hang
        self.timeouts = []

    def get(self, timeout):
        self.timeouts.append(timeout)
        if self.hang:
            raise TimeoutError("not ready")
        return {"glb": self.glb, "sec": self.sec, "baked": True}


class FakeMeshes:
    def __init__(self, glb=b"glb", hang=False, glbs=None):
        self.glb = glb
        self.hang = hang
        self.glbs = list(glbs) if glbs is not None else None
        self.handles = []
        self.names = []
        self._lock = threading.Lock()

    def submit(self, name, png):
        with self._lock:
            self.names.append(name)
            glb = self.glbs.pop(0) if self.glbs else self.glb
            handle = FakeHandle(glb, hang=self.hang)
            self.handles.append(handle)
        return handle


def key(k, kind="object"):
    return {"id": f"id-{k}", "kind": kind, "key": k, "prompt": f"a {k}", "size": "1024x1024"}


def queue(images=None, meshes=None, ledger=None, clock=None, **kw):
    clock = clock or Clock()
    cache = Path(tempfile.mkdtemp()) / "cache"
    q = AssetQueue(cache, images or FakeImages(), meshes or FakeMeshes(),
                   ledger or FakeLedger(), clock=clock, sleep=clock.sleep, **kw)
    return q, cache, clock


def events_of(ledger, kind):
    return [e for e in ledger.events if e.get("kind") == kind]


class TestHappyPath(unittest.TestCase):
    def test_object_writes_png_and_glb(self):
        q, cache, _ = queue()
        q.put("kitchen", [key("stool")])
        q.wait("kitchen")
        self.assertTrue((cache / "stool.src.png").exists())
        self.assertEqual((cache / "stool.glb").read_bytes(), b"glb")

    def test_tile_only_generates_a_picture(self):
        meshes = FakeMeshes()
        q, cache, _ = queue(meshes=meshes)
        q.put("kitchen", [key("floor", kind="tile")])
        q.wait("kitchen")
        self.assertTrue((cache / "floor.png").exists())
        self.assertEqual(meshes.names, [])

    def test_object_image_submits_before_the_rest_of_the_room(self):
        submitted = threading.Event()
        saw = []

        class Meshes(FakeMeshes):
            def submit(self, name, png):
                handle = super().submit(name, png)
                submitted.set()
                return handle

        class Images(FakeImages):
            def generate(self, prompt, size):
                if "tile" in prompt:
                    saw.append(submitted.wait(10))
                return super().generate(prompt, size)

        q, _, _ = queue(images=Images(), meshes=Meshes())
        q.put("kitchen", [key("stool"), key("tile", kind="tile")])
        q.wait("kitchen")
        self.assertEqual(saw, [True])


class TestCacheAndDedup(unittest.TestCase):
    def test_cached_key_is_not_generated_again(self):
        images = FakeImages()
        q, cache, _ = queue(images=images)
        cache.mkdir(parents=True, exist_ok=True)
        (cache / "stool.glb").write_bytes(b"old")
        q.put("kitchen", [key("stool")])
        q.wait("kitchen")
        self.assertEqual(images.seen, [])
        self.assertEqual((cache / "stool.glb").read_bytes(), b"old")

    def test_same_key_from_two_rooms_is_generated_once(self):
        images = FakeImages()
        meshes = FakeMeshes()
        q, _, _ = queue(images=images, meshes=meshes)
        q.put("kitchen", [key("stool")])
        q.put("hall", [key("stool")])
        q.wait("kitchen")
        q.wait("hall")
        self.assertEqual(len(images.seen), 1)
        self.assertEqual(meshes.names, ["stool"])


class TestFailures(unittest.TestCase):
    def test_empty_glb_is_failure(self):
        ledger = FakeLedger()
        meshes = FakeMeshes(glbs=[b"", b""])
        q, cache, _ = queue(meshes=meshes, ledger=ledger)
        q.put("kitchen", [key("stool")])
        q.wait("kitchen")
        self.assertEqual(len(meshes.names), 2)  # one retry
        self.assertFalse((cache / "stool.glb").exists())
        self.assertEqual(len(events_of(ledger, "asset_failed")), 1)
        self.assertTrue(q.idle())

    def test_hanging_mesh_times_out_on_the_clock(self):
        ledger = FakeLedger()
        meshes = FakeMeshes(hang=True)
        q, _, clock = queue(meshes=meshes, ledger=ledger, mesh_timeout_s=30, poll_s=2)
        q.put("kitchen", [key("stool")])
        q.wait("kitchen")
        self.assertEqual(len(events_of(ledger, "asset_failed")), 1)
        self.assertGreaterEqual(clock(), 30)
        self.assertEqual(len(meshes.handles), 1)  # a timeout is not retried
        for handle in meshes.handles:
            self.assertTrue(handle.timeouts)
            self.assertLessEqual(max(handle.timeouts), 2)

    def test_image_failure_is_asset_failed(self):
        ledger = FakeLedger()
        meshes = FakeMeshes()
        q, _, _ = queue(images=FakeImages(fail=True), meshes=meshes, ledger=ledger)
        q.put("kitchen", [key("stool")])
        q.wait("kitchen")
        self.assertEqual(meshes.names, [])
        self.assertEqual(len(events_of(ledger, "asset_failed")), 1)

    def test_cache_write_error_is_asset_failed(self):
        ledger = FakeLedger()
        q, _, _ = queue(ledger=ledger)

        def boom(name, blob):
            raise OSError("disk full")

        q._write = boom
        q.put("kitchen", [key("stool")])
        q.wait("kitchen")
        self.assertTrue(q.done("kitchen"))
        self.assertTrue(q.idle())
        failed = events_of(ledger, "asset_failed")
        self.assertEqual(len(failed), 1)
        self.assertEqual(failed[0]["reason"], "OSError")


class TestIdleAndClose(unittest.TestCase):
    def test_idle_is_true_only_when_everything_finished(self):
        gate = threading.Event()

        class Images(FakeImages):
            def generate(self, prompt, size):
                gate.wait(10)
                return super().generate(prompt, size)

        q, _, _ = queue(images=Images())
        self.assertTrue(q.idle())
        q.put("kitchen", [key("stool")])
        self.assertFalse(q.idle())
        gate.set()
        q.wait("kitchen")
        self.assertTrue(q.idle())

    def test_put_after_close_is_late_and_calls_nobody(self):
        ledger = FakeLedger()
        images = FakeImages()
        meshes = FakeMeshes()
        q, _, _ = queue(images=images, meshes=meshes, ledger=ledger)
        self.assertFalse(q.closed)
        q.close()
        self.assertTrue(q.closed)
        q.put("kitchen", [key("stool"), key("tile", kind="tile")])
        self.assertEqual(images.seen, [])
        self.assertEqual(meshes.names, [])
        self.assertEqual(len(events_of(ledger, "asset_late")), 2)
        self.assertTrue(q.done("kitchen"))
        self.assertTrue(q.idle())


class TestAccounting(unittest.TestCase):
    def test_allow_comes_before_the_call_and_charge_after(self):
        ledger = FakeLedger()
        q, _, _ = queue(ledger=ledger, mesh_timeout_s=330)
        q.put("kitchen", [key("stool")])
        q.wait("kitchen")
        kinds = [c for c in ledger.calls]
        self.assertEqual(kinds[0][:2], ("allow", "image"))
        self.assertEqual(kinds[1][:2], ("charge", "image"))
        self.assertEqual(kinds[1][2:], (1, kinds[0][2]))
        self.assertEqual(kinds[2][:2], ("allow", "h100_s"))
        self.assertEqual(kinds[2][2], ledger.cost_of("h100_s", 330))
        self.assertEqual(kinds[3][:2], ("charge", "h100_s"))
        self.assertEqual(kinds[3][2:], (12.0, kinds[2][2]))

    def test_zero_sec_is_charged_as_zero(self):
        ledger = FakeLedger()

        class Meshes(FakeMeshes):
            def submit(self, name, png):
                with self._lock:
                    self.names.append(name)
                    handle = FakeHandle(b"glb", sec=0.0)
                    self.handles.append(handle)
                return handle

        q, cache, _ = queue(meshes=Meshes(), ledger=ledger)
        q.put("kitchen", [key("stool")])
        q.wait("kitchen")
        self.assertEqual((cache / "stool.glb").read_bytes(), b"glb")
        charges = [c for c in ledger.calls if c[0] == "charge" and c[1] == "h100_s"]
        self.assertEqual(len(charges), 1)
        self.assertEqual(charges[0][2], 0.0)

    def test_refused_budget_skips_the_providers(self):
        ledger = FakeLedger(allow=False)
        images = FakeImages()
        meshes = FakeMeshes()
        q, _, _ = queue(images=images, meshes=meshes, ledger=ledger)
        q.put("kitchen", [key("stool")])
        q.wait("kitchen")
        self.assertEqual(images.seen, [])
        self.assertEqual(meshes.names, [])
        self.assertEqual(len(events_of(ledger, "asset_failed")), 1)

class TestFailedMeshCharge(unittest.TestCase):
    def test_a_poll_error_is_charged_the_time_it_took_not_the_whole_reserve(self):
        ledger = FakeLedger()
        clock = Clock()

        class Broken:
            def get(self, timeout):
                clock.sleep(5)
                raise ConnectionError("cold container")

        class Meshes(FakeMeshes):
            def submit(self, name, png):
                return Broken()

        q, _, _ = queue(meshes=Meshes(), ledger=ledger, clock=clock, mesh_timeout_s=330)
        q.put("kitchen", [key("stool")])
        q.wait("kitchen")
        charges = [c[2] for c in ledger.calls if c[0] == "charge" and c[1] == "h100_s"]
        self.assertEqual(charges, [5, 5])
        self.assertEqual(len(events_of(ledger, "asset_failed")), 1)

    def test_a_submit_error_is_charged_the_time_it_took(self):
        ledger = FakeLedger()
        clock = Clock()

        class Meshes(FakeMeshes):
            def submit(self, name, png):
                clock.sleep(2)
                raise ConnectionError("down")

        q, _, _ = queue(meshes=Meshes(), ledger=ledger, clock=clock, mesh_timeout_s=330)
        q.put("kitchen", [key("stool")])
        q.wait("kitchen")
        charges = [c[2] for c in ledger.calls if c[0] == "charge" and c[1] == "h100_s"]
        self.assertEqual(charges, [2, 2])

    def test_a_timeout_still_costs_the_whole_reserve(self):
        ledger = FakeLedger()
        q, _, _ = queue(meshes=FakeMeshes(hang=True), ledger=ledger, mesh_timeout_s=30)
        q.put("kitchen", [key("stool")])
        q.wait("kitchen")
        charges = [c[2] for c in ledger.calls if c[0] == "charge" and c[1] == "h100_s"]
        self.assertTrue(charges and all(c >= 30 for c in charges))


if __name__ == "__main__":
    unittest.main()


class TestMeshBudget(unittest.TestCase):
    """The cache holds the full mesh; the engine cuts it to the budget at build time."""

    def test_mesh_is_asked_for_without_a_budget(self):
        meshes = FakeMeshes()
        q, cache, _ = queue(meshes=meshes)
        q.put("kitchen", [key("cup"), key("stool")])
        q.wait("kitchen")
        self.assertEqual({"cup", "stool"}, set(meshes.names))
        self.assertEqual(b"glb", (cache / "cup.glb").read_bytes())

    def test_modal_mesh_submit_takes_no_faces(self):
        import inspect
        from pipe2 import assets

        self.assertEqual(["self", "name", "png"], list(inspect.signature(assets.ModalMesh.submit).parameters))
        self.assertFalse(hasattr(assets, "SIZED_APPS"))

    def test_only_the_scene_mesh_is_written(self):
        # one mesh in the cache, untouched: no second "full" copy beside it
        class Full(FakeHandle):
            def get(self, timeout):
                return {**super().get(timeout), "full": b"full-glb"}

        class Meshes(FakeMeshes):
            def submit(self, name, png):
                return Full(b"glb")

        q, cache, _ = queue(meshes=Meshes())
        q.put("kitchen", [key("cup")])
        q.wait("kitchen")
        self.assertEqual(b"glb", (cache / "cup.glb").read_bytes())
        self.assertFalse((cache / "cup.full.glb").exists())


class TestPngBytes(unittest.TestCase):
    """Muse Image answers WebP now; the engine reads the cache with pngjs, so every picture must be a PNG."""

    def test_webp_becomes_png(self):
        import io
        from PIL import Image
        from pipe2.assets import as_png
        buf = io.BytesIO()
        Image.new("RGB", (4, 4), (200, 30, 30)).save(buf, "WEBP")
        out = as_png(buf.getvalue())
        self.assertEqual(out[:8], b"\x89PNG\r\n\x1a\n")
        self.assertEqual(Image.open(io.BytesIO(out)).getpixel((1, 1))[0] > 150, True)

    def test_png_passes_through_untouched(self):
        import io
        from PIL import Image
        from pipe2.assets import as_png
        buf = io.BytesIO()
        Image.new("RGB", (2, 2)).save(buf, "PNG")
        self.assertEqual(as_png(buf.getvalue()), buf.getvalue())
