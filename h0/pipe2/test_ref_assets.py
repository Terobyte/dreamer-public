"""H2: an object is drawn from the room's reference frame, not from a retelling of it."""
import base64
import hashlib
import tempfile
import unittest
import urllib.request
from pathlib import Path

from pipe2.assets import AssetQueue
from pipe2.floor import attach_refs


def _no_net(*_a, **_k):
    raise AssertionError("network is forbidden in tests")


def _scene():
    return {
        "assets": {
            "a_bed": {"kind": "object", "prompt": "bed"},
            "a_lamp": {"kind": "object", "prompt": "lamp"},
            "a_tub": {"kind": "object", "prompt": "tub"},
            "t_wall": {"kind": "tile", "prompt": "wall"},
            "d_pic": {"kind": "decal", "prompt": "picture"},
        },
        "materials": {"wall": {"tile": "t_wall"}},
        "props": [
            {"id": "bed", "asset": "a_bed", "room": "bedroom"},
            {"id": "lamp", "asset": "a_lamp", "room": "bedroom"},
            {"id": "tub", "asset": "a_tub", "room": "bath"},
        ],
        "decals": [{"asset": "d_pic", "room": "bedroom"}],
    }


class AttachRefs(unittest.TestCase):
    def setUp(self):
        self._urlopen = urllib.request.urlopen
        urllib.request.urlopen = _no_net
        self.tmp = Path(tempfile.mkdtemp())
        self.task_refs = self.tmp / "task" / "refs"
        self.task_refs.mkdir(parents=True)
        self.frame = self.task_refs / "bedroom.png"
        self.frame.write_bytes(b"\x89PNG\r\n\x1a\nbedroom")
        self.scene_dir = self.tmp / "run"
        self.scene_dir.mkdir()

    def tearDown(self):
        urllib.request.urlopen = self._urlopen

    def test_room_with_ref_gets_ref_on_every_object(self):
        scene = _scene()
        plan = {"rooms": {"bedroom": {"refs": [str(self.frame)]}, "bath": {}}}
        attach_refs(scene, plan, self.scene_dir)
        bed = scene["assets"]["a_bed"]["ref"]
        lamp = scene["assets"]["a_lamp"]["ref"]
        self.assertEqual(bed["what"], "bed")
        self.assertEqual(lamp["what"], "lamp")
        self.assertEqual(bed["image"], lamp["image"])
        self.assertFalse(Path(bed["image"]).is_absolute())
        self.assertNotIn("..", Path(bed["image"]).parts)
        self.assertEqual((self.scene_dir / bed["image"]).read_bytes(), self.frame.read_bytes())

    def test_room_without_ref_gets_none(self):
        scene = _scene()
        plan = {"rooms": {"bedroom": {"refs": [str(self.frame)]}, "bath": {"refs": []}}}
        attach_refs(scene, plan, self.scene_dir)
        self.assertNotIn("ref", scene["assets"]["a_tub"])

    def test_tiles_and_decals_never_get_ref(self):
        scene = _scene()
        plan = {"rooms": {"bedroom": {"refs": [str(self.frame)]}}}
        attach_refs(scene, plan, self.scene_dir)
        self.assertNotIn("ref", scene["assets"]["t_wall"])
        self.assertNotIn("ref", scene["assets"]["d_pic"])


class _RefImages:
    """Fake image provider with the optional `fromRef` entry point."""

    def __init__(self, png=b"png"):
        self.png = png
        self.seen_generate = []
        self.seen_from_ref = []

    def generate(self, prompt, size):
        self.seen_generate.append((prompt, size))
        return self.png

    def fromRef(self, ref_bytes, what, prompt, size):
        self.seen_from_ref.append((bytes(ref_bytes), what, prompt, size))
        return self.png


class _OkMeshes:
    def __init__(self):
        self.names = []

    def submit(self, name, png):
        self.names.append((name, bytes(png)))
        return _OkHandle()


class _OkHandle:
    def get(self, timeout):
        return {"glb": b"glb", "sec": 1.0}


class _Ledger:
    def cost_of(self, kind, units):
        return 0.0

    def allow(self, kind, estimate, reserve_tokens=0):
        return True

    def charge(self, kind, units, reserved=0.0):
        return 0.0

    def record(self, event):
        pass


class QueueRef(unittest.TestCase):
    """F1: the queue generates a ref-carrying asset from its frame, not from text."""

    def test_picture_uses_from_ref_when_spec_carries_ref(self):
        import time

        cache = Path(tempfile.mkdtemp()) / "cache"
        images = _RefImages()
        q = AssetQueue(cache, images, _OkMeshes(), _Ledger(),
                       clock=time.time, sleep=lambda s: None)
        frame = b"frame bytes"
        q.put("bedroom", [{"id": "a_bed", "kind": "object", "key": "k-bed",
                           "prompt": "bed", "size": "1024x1024",
                           "ref": {"bytes": frame, "what": "bed"}}])
        q.wait("bedroom")
        self.assertEqual(len(images.seen_from_ref), 1)
        self.assertEqual(images.seen_from_ref[0][0], frame)
        self.assertEqual(images.seen_from_ref[0][1], "bed")
        self.assertEqual(images.seen_generate, [])

    def test_text_only_spec_still_uses_generate(self):
        import time

        cache = Path(tempfile.mkdtemp()) / "cache"
        images = _RefImages()
        q = AssetQueue(cache, images, _OkMeshes(), _Ledger(),
                       clock=time.time, sleep=lambda s: None)
        q.put("bedroom", [{"id": "a_bed", "kind": "object", "key": "k-bed2",
                           "prompt": "bed", "size": "1024x1024"}])
        q.wait("bedroom")
        self.assertEqual(images.seen_from_ref, [])
        self.assertEqual(len(images.seen_generate), 1)


class EngineRefPaths(unittest.TestCase):
    """F1/F2: keys and builds resolve `ref.image` against the scene folder."""

    def setUp(self):
        self._urlopen = urllib.request.urlopen
        urllib.request.urlopen = _no_net
        self.tmp = Path(tempfile.mkdtemp())
        self.engine = None

    def tearDown(self):
        urllib.request.urlopen = self._urlopen

    def _engine(self):
        from pipe2.engine import Engine
        from pipe2.fakes import FakeEngine
        _ = Engine
        return FakeEngine()

    def test_asset_keys_differ_by_frame_bytes(self):
        from pipe2.engine import Engine  # noqa: F401  (real CLI also resolves refs)
        eng = self._engine()
        run = self.tmp / "run"
        (run / "refs").mkdir(parents=True)
        (run / "refs" / "bedroom.png").write_bytes(b"frame-A")
        scene_a = {"assets": {"a_bed": {"kind": "object", "prompt": "bed",
                                        "ref": {"image": "refs/bedroom.png", "what": "bed"}}},
                   "props": [{"id": "bed", "asset": "a_bed", "room": "bedroom"}]}
        ka = eng.asset_keys(scene_a, run)
        (run / "refs" / "bedroom.png").write_bytes(b"frame-B")
        scene_b = {"assets": {"a_bed": {"kind": "object", "prompt": "bed",
                                        "ref": {"image": "refs/bedroom.png", "what": "bed"}}},
                   "props": [{"id": "bed", "asset": "a_bed", "room": "bedroom"}]}
        kb = eng.asset_keys(scene_b, run)
        self.assertNotEqual(ka[0]["key"], kb[0]["key"])

    def test_build_sees_frames_copied_next_to_scene(self):
        eng = self._engine()
        run = self.tmp / "run"
        (run / "refs").mkdir(parents=True)
        (run / "refs" / "bedroom.png").write_bytes(b"frame bytes")
        scene = {"assets": {"a_bed": {"kind": "object", "prompt": "bed",
                                      "ref": {"image": "refs/bedroom.png", "what": "bed"}}},
                 "props": [{"id": "bed", "asset": "a_bed", "room": "bedroom"}]}
        out = self.tmp / "dist"
        eng.build(scene, out, "none", None, run)
        stored = (out / "scene.json").read_text()
        self.assertIn("refs/bedroom.png", stored)

    def test_dotdot_staying_inside_is_accepted(self):
        """F5: `sub/../refs/bedroom.png` normalizes inside scene_dir — the key
        folds the frame bytes and the build does not report REF_MISSING."""
        from pipe2.engine import Engine
        eng = self._engine()
        run = self.tmp / "run"
        (run / "refs").mkdir(parents=True)
        (run / "refs" / "bedroom.png").write_bytes(b"frame bytes")
        (run / "sub").mkdir()
        scene = {"assets": {"a_bed": {"kind": "object", "prompt": "bed",
                                      "ref": {"image": "sub/../refs/bedroom.png", "what": "bed"}}},
                 "props": [{"id": "bed", "asset": "a_bed", "room": "bedroom"}]}
        keys = eng.asset_keys(scene, run)
        self.assertIn("ref", keys[0])
        scene_path = Engine._stage_scene(scene, run)
        self.assertTrue((scene_path.parent / "refs" / "bedroom.png").is_file())

    def test_fake_keys_match_real_engine_formula(self):
        """F1: очередь и сборка обязаны делить один ref-aware ключ (cacheKey)."""
        eng = self._engine()
        run = self.tmp / "run"
        (run / "refs").mkdir(parents=True)
        raw = b"frame bytes"
        (run / "refs" / "bedroom.png").write_bytes(raw)
        scene = {"assets": {"a_bed": {"kind": "object", "prompt": "bed",
                                      "ref": {"image": "refs/bedroom.png", "what": "bed"}}},
                 "props": [{"id": "bed", "asset": "a_bed", "room": "bedroom"}]}
        got = eng.asset_keys(scene, run)[0]["key"]
        framed = "single object, front view facing the camera, whole object, plain white background, no shadow. bed"
        subject = "%s|ref|%s|%s" % (framed, hashlib.sha256(raw).hexdigest(), "bed")
        want = hashlib.sha256(subject.encode()).hexdigest()
        self.assertEqual(got, want)


if __name__ == "__main__":
    unittest.main()
