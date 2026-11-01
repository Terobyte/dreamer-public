"""Н2б: an object is cut out of the room's frame by a SAM 3 mask and meshed by SAM3D with it."""
import importlib.util
import io
import json
import sys
import tempfile
import time
import unittest
import urllib.request
from pathlib import Path
from unittest.mock import MagicMock, patch

from pipe2 import assets as assets_mod
from pipe2.assets import MESH_APPS, SEG_APP, AssetQueue, ModalMesh
from pipe2.fakes import FakeSam3D, FakeSceneMeshes, FakeSegmenter


def _no_net(*_a, **_k):
    raise AssertionError("network is forbidden in tests")


class _Images:
    def __init__(self):
        self.generate_calls = []
        self.from_ref_calls = []

    def generate(self, prompt, size):
        self.generate_calls.append(prompt)
        return b"\x89PNG\r\n\x1a\nimg"

    def fromRef(self, ref_bytes, what, prompt, size):
        self.from_ref_calls.append(what)
        return b"\x89PNG\r\n\x1a\nimg"


class _Ledger:
    def __init__(self):
        self.events = []

    def cost_of(self, kind, units):
        return 0.0

    def allow(self, kind, estimate, reserve_tokens=0):
        return True

    def charge(self, kind, units, reserved=0.0):
        return 0.0

    def record(self, event):
        self.events.append(event)


FRAME = b"\x89PNG\r\n\x1a\nbedroom frame"


def _spec(name, what, mode=None):
    ref = {"bytes": FRAME, "what": what}
    if mode is not None:
        ref["mode"] = mode
    return {"id": name, "kind": "object", "key": f"k-{name}", "prompt": what, "size": "1024x1024", "ref": ref}


def _run(meshes, specs):
    cache = Path(tempfile.mkdtemp()) / "cache"
    images, ledger = _Images(), _Ledger()
    q = AssetQueue(cache, images, meshes, ledger, clock=time.time, sleep=lambda s: None)
    q.put("bedroom", specs)
    q.wait("bedroom")
    q.close()
    return cache, images, ledger


def load_module(name):
    modal = MagicMock()
    modal.enter.return_value = lambda fn: fn
    modal.method.return_value = lambda fn: fn
    modal.local_entrypoint.return_value = lambda fn: fn
    modal.function.return_value = lambda fn: fn
    modal.App.return_value.function.return_value = lambda fn: fn
    modal.App.return_value.cls.return_value = lambda cls: cls
    path = Path(__file__).parents[1] / f"{name}.py"
    spec = importlib.util.spec_from_file_location(f"{name}_for_test", path)
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, {"modal": modal}):
        spec.loader.exec_module(module)
    return module


def _png(w, h, on):
    from PIL import Image

    img = Image.new("L", (w, h), 0)
    for i in range(on):
        img.putpixel((i % w, i // w), 255)
    out = io.BytesIO()
    img.save(out, "PNG")
    return out.getvalue()


class SceneMask(unittest.TestCase):
    def setUp(self):
        self._urlopen = urllib.request.urlopen
        urllib.request.urlopen = _no_net

    def tearDown(self):
        urllib.request.urlopen = self._urlopen

    def test_seg_app_next_to_mesh_apps(self):
        self.assertEqual(SEG_APP, ("dreamer-sam3", "Sam3"))
        self.assertIn("sam3d", MESH_APPS)

    def test_three_objects_two_seg_fail_one_by_mask(self):
        seg = FakeSegmenter(fail={"lamp": "error", "tub": "error"})
        sam = FakeSam3D()
        meshes = FakeSceneMeshes(seg, sam)
        cache, images, ledger = _run(meshes, [_spec("bed", "bed"), _spec("lamp", "lamp"), _spec("tub", "tub")])
        self.assertEqual(sorted(c["what"] for c in seg.calls), ["bed", "lamp", "tub"])
        self.assertTrue(all(c["png"] == FRAME for c in seg.calls))
        masked = [c for c in sam.calls if c["mask"] is not None]
        self.assertEqual([c["name"] for c in masked], ["k-bed"])
        self.assertEqual(masked[0]["png"], FRAME)
        self.assertEqual(sorted(images.from_ref_calls), ["lamp", "tub"])
        for name in ("bed", "lamp", "tub"):
            self.assertTrue((cache / f"k-{name}.glb").exists(), name)
        falls = sorted((e["asset"], e["reason"]) for e in ledger.events if e["kind"] == "MASK_FALLBACK")
        self.assertEqual(falls, [("k-lamp", "error"), ("k-tub", "error")])
        self.assertFalse(any(e["kind"] == "MASK_ALL_FALLBACK" for e in ledger.events))

    def test_all_fallback_is_said(self):
        seg = FakeSegmenter(fail={"bed": "error", "lamp": "empty"})
        _, _, ledger = _run(FakeSceneMeshes(seg, FakeSam3D()), [_spec("bed", "bed"), _spec("lamp", "lamp")])
        self.assertTrue(any(e["kind"] == "MASK_ALL_FALLBACK" for e in ledger.events))

    def test_mask_empty_goes_redraw(self):
        seg = FakeSegmenter(fail={"bed": "empty"})
        _, images, ledger = _run(FakeSceneMeshes(seg, FakeSam3D()), [_spec("bed", "bed")])
        self.assertEqual(images.from_ref_calls, ["bed"])
        self.assertIn(("k-bed", "empty"), [(e["asset"], e.get("reason")) for e in ledger.events if e["kind"] == "MASK_FALLBACK"])

    def test_without_from_scene_is_unavailable(self):
        class _Plain:
            def submit(self, name, png):
                return FakeSam3D().handle(name, png)

        _, images, ledger = _run(_Plain(), [_spec("bed", "bed")])
        self.assertEqual(images.from_ref_calls, ["bed"])
        self.assertIn(("k-bed", "unavailable"), [(e["asset"], e.get("reason")) for e in ledger.events if e["kind"] == "MASK_FALLBACK"])

    def test_redraw_mode_skips_mask(self):
        seg = FakeSegmenter()
        _, images, _ = _run(FakeSceneMeshes(seg, FakeSam3D()), [_spec("bed", "bed", mode="redraw")])
        self.assertEqual(seg.calls, [])
        self.assertEqual(images.from_ref_calls, ["bed"])

    def test_sam3d_failure_after_mask_is_failed_without_redraw(self):
        sam = FakeSam3D(fail=True)
        cache, images, ledger = _run(FakeSceneMeshes(FakeSegmenter(), sam), [_spec("bed", "bed")])
        self.assertEqual(images.from_ref_calls, [])
        self.assertEqual(images.generate_calls, [])
        self.assertFalse((cache / "k-bed.glb").exists())
        self.assertTrue(any(e["kind"] == "asset_failed" and e["asset"] == "k-bed" for e in ledger.events))
        self.assertTrue(any(e["kind"] == "MASK_FALLBACK" and e["asset"] == "k-bed" for e in ledger.events))

    def test_spawn_failure_after_mask_is_failed_without_redraw(self):
        modal = MagicMock()
        seg_cls, mesh_cls = MagicMock(), MagicMock()
        modal.Cls.from_name.side_effect = lambda app, cls: seg_cls if (app, cls) == SEG_APP else mesh_cls
        seg_cls.return_value.mask.remote.return_value = b"maskpng"
        mesh_cls.return_value.run.spawn.side_effect = RuntimeError("fake SAM3D spawn failed")
        with patch.dict(sys.modules, {"modal": modal}):
            cache, images, ledger = _run(ModalMesh(), [_spec("bed", "bed")])
        seg_cls.return_value.mask.remote.assert_called_once_with(FRAME, "bed")
        self.assertEqual(mesh_cls.return_value.run.spawn.call_count, 1)
        self.assertEqual(images.from_ref_calls, [])
        self.assertEqual(images.generate_calls, [])
        self.assertFalse((cache / "k-bed.glb").exists())
        self.assertTrue(any(e["kind"] == "asset_failed" and e["asset"] == "k-bed" for e in ledger.events))
        self.assertTrue(any(e["kind"] == "MASK_FALLBACK" and e["asset"] == "k-bed" for e in ledger.events))

    def test_redraw_and_mask_keys_differ_and_queue_gets_redraw(self):
        import base64
        import hashlib
        import tempfile
        from pathlib import Path as _Path
        from pipe2.fakes import FakeEngine
        frame = b"frame-bytes"
        d = _Path(tempfile.mkdtemp())
        (d / "room.png").write_bytes(frame)
        base = {"assets": {"o": {"kind": "object", "prompt": "a bed", "ref": {"image": "room.png", "what": "bed"}}},
                "props": [{"asset": "o"}]}
        redraw_scene = {"assets": {"o": {"kind": "object", "prompt": "a bed", "ref": {"image": "room.png", "what": "bed", "mode": "redraw"}}},
                        "props": [{"asset": "o"}]}
        eng = FakeEngine()
        mask_keys = eng.asset_keys(base, scene_dir=str(d))
        redraw_keys = eng.asset_keys(redraw_scene, scene_dir=str(d))
        self.assertNotEqual(mask_keys[0]["key"], redraw_keys[0]["key"])
        self.assertEqual(redraw_keys[0]["ref"]["mode"], "redraw")
        seg = FakeSegmenter()
        _, images, _ = _run(FakeSceneMeshes(seg, FakeSam3D()), [_spec("bed", "bed", mode="redraw")])
        self.assertEqual(seg.calls, [])
        self.assertEqual(images.from_ref_calls, ["bed"])

    def test_implied_mask_key_equals_explicit_mask_and_queue_files_redraw_key(self):
        # F4: an unset mode means mask (same key as explicit mask, other than
        # redraw), and the queue files the asset under the key it was given,
        # so a redraw build finds its GLB under the redraw key.
        from pipe2.fakes import FakeEngine
        frame = b"frame-bytes-for-key-parity"
        d = Path(tempfile.mkdtemp())
        (d / "room.png").write_bytes(frame)
        base = {"assets": {"o": {"kind": "object", "prompt": "a bed", "ref": {"image": "room.png", "what": "bed"}}},
                "props": [{"asset": "o"}]}
        explicit = {"assets": {"o": {"kind": "object", "prompt": "a bed", "ref": {"image": "room.png", "what": "bed", "mode": "mask"}}},
                    "props": [{"asset": "o"}]}
        redraw_scene = {"assets": {"o": {"kind": "object", "prompt": "a bed", "ref": {"image": "room.png", "what": "bed", "mode": "redraw"}}},
                        "props": [{"asset": "o"}]}
        eng = FakeEngine()
        implied = eng.asset_keys(base, scene_dir=str(d))[0]
        explicit_mask = eng.asset_keys(explicit, scene_dir=str(d))[0]
        redraw = eng.asset_keys(redraw_scene, scene_dir=str(d))[0]
        self.assertEqual(implied["key"], explicit_mask["key"])
        self.assertEqual(implied["ref"]["mode"], "mask")
        self.assertNotEqual(redraw["key"], implied["key"])
        self.assertEqual(redraw["ref"]["mode"], "redraw")
        spec = {"id": "o", "kind": "object", "key": redraw["key"], "prompt": "a bed",
                "size": "1024x1024", "ref": {"bytes": frame, "what": "bed", "mode": "redraw"}}
        seg = FakeSegmenter()
        cache, images, _ = _run(FakeSceneMeshes(seg, FakeSam3D()), [spec])
        self.assertEqual(seg.calls, [])
        self.assertEqual(images.from_ref_calls, ["bed"])
        self.assertTrue((cache / (redraw["key"] + ".glb")).exists())
        self.assertFalse((cache / (implied["key"] + ".glb")).exists())

    def test_all_without_from_scene_says_all_fallback(self):
        class _Plain:
            def submit(self, name, png):
                return FakeSam3D().handle(name, png)

        _, _, ledger = _run(_Plain(), [_spec("bed", "bed"), _spec("lamp", "lamp")])
        self.assertTrue(any(e["kind"] == "MASK_ALL_FALLBACK" for e in ledger.events))

    def test_sam3d_failure_after_mask_is_not_redraw_summary(self):
        sam = FakeSam3D(fail=True)
        _, _, ledger = _run(FakeSceneMeshes(FakeSegmenter(), sam), [_spec("bed", "bed")])
        self.assertTrue(any(e["kind"] == "MASK_FALLBACK" and e["asset"] == "k-bed" for e in ledger.events))
        self.assertFalse(any(e["kind"] == "MASK_ALL_FALLBACK" for e in ledger.events))

    def test_pose_is_written_next_to_glb(self):
        pose = {"rotation": [1, 0, 0, 0], "translation": [0, 1, 2], "scale": [1, 1, 1]}
        cache, _, _ = _run(FakeSceneMeshes(FakeSegmenter(), FakeSam3D(pose=pose)), [_spec("bed", "bed")])
        self.assertEqual(json.loads((cache / "k-bed.pose.json").read_text()), pose)

    def test_modal_mesh_from_scene_calls_seg_then_sam3d_with_mask(self):
        modal = MagicMock()
        seg_cls, mesh_cls = MagicMock(), MagicMock()
        modal.Cls.from_name.side_effect = lambda app, cls: seg_cls if (app, cls) == SEG_APP else mesh_cls
        seg_cls.return_value.mask.remote.return_value = b"maskpng"
        with patch.dict(sys.modules, {"modal": modal}):
            ModalMesh().from_scene("k-bed", FRAME, "bed")
        seg_cls.return_value.mask.remote.assert_called_once_with(FRAME, "bed")
        mesh_cls.return_value.run.spawn.assert_called_once_with("k-bed", FRAME, with_ply=False, mask=b"maskpng")

    def test_sam3d_run_with_mask_skips_white_bg(self):
        sam = load_module("sam3d_modal")
        out = {"glb": MagicMock(), "gs": MagicMock()}
        out["glb"].export.return_value = b"glb"
        for mask, white_calls in ((_png(4, 4, 8), 0), (None, 1)):
            me = MagicMock()
            me.inf._pipeline.run.return_value = out
            me.inf.merge_mask_to_rgba.return_value = "rgba"
            white = MagicMock(return_value="white-mask")
            with patch.object(sam, "white_bg_mask", white):
                if mask is None:
                    r = sam.Sam3D.run(me, "box", _png(4, 4, 0), False)
                else:
                    r = sam.Sam3D.run(me, "box", _png(4, 4, 0), False, mask=mask)
            self.assertEqual(white.call_count, white_calls)
            passed = me.inf.merge_mask_to_rgba.call_args[0][1]
            if mask is None:
                self.assertEqual(passed, "white-mask")
            else:
                self.assertEqual(int(passed.sum()), 8)
            self.assertEqual(r["glb"], b"glb")

    def test_pack_result_pose(self):
        sam = load_module("sam3d_modal")
        glb = MagicMock()
        glb.export.return_value = b"glb"
        r = sam.pack_result("box", {"glb": glb}, False, 1.0, True)
        self.assertIsNone(r["pose"])
        r = sam.pack_result("box", {"glb": glb, "rotation": [1, 0, 0, 0], "translation": [0, 0, 1], "scale": [2]},
                            False, 1.0, True)
        self.assertEqual(r["pose"], {"rotation": [1, 0, 0, 0], "translation": [0, 0, 1], "scale": [2]})

    def test_mask_area_under_half_percent_is_empty(self):
        sam3 = load_module("sam3_modal")
        me = MagicMock()
        # 1000x1 frame: 4 pixels = 0.4%, 6 pixels = 0.6%
        me._predict = lambda png, what: [([[1] * 4 + [0] * 996], 0.9)]
        with self.assertRaises(sam3.MaskEmpty) as caught:
            sam3.Sam3.mask(me, b"frame", "bed")
        self.assertEqual(caught.exception.code, "MASK_EMPTY")
        me._predict = lambda png, what: []
        with self.assertRaises(sam3.MaskEmpty):
            sam3.Sam3.mask(me, b"frame", "bed")
        me._predict = lambda png, what: [([[1] * 4 + [0] * 996], 0.9), ([[1] * 6 + [0] * 994], 0.5)]
        with self.assertRaises(sam3.MaskEmpty):
            sam3.Sam3.mask(me, b"frame", "bed")  # the best match is too small, not the biggest
        me._predict = lambda png, what: [([[1] * 6 + [0] * 994], 0.9)]
        self.assertEqual(sam3.Sam3.mask(me, b"frame", "bed")[:8], b"\x89PNG\r\n\x1a\n")


if __name__ == "__main__":
    unittest.main()
