"""Red tests for B25 (warm GPU time not charged), B27 (resume re-pays src.png), B39 (truncated PNG accepted)."""

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from pipe2.assets import AssetQueue, as_png
from pipe2.gpu import GpuWarmth
from pipe2.test_assets import FakeImages, FakeLedger, FakeMeshes, Clock, key


class ChargingLedger(FakeLedger):
    def __init__(self):
        super().__init__()
        self.h100_s = 0.0

    def charge(self, kind, units, reserved=0.0):
        if kind == "h100_s":
            self.h100_s += units
        return super().charge(kind, units, reserved)


class RecordingScaler:
    def __init__(self):
        self.calls = []

    def set(self, minimum, buffer, window):
        self.calls.append((minimum, buffer, window))


class BugsAssets(unittest.TestCase):
    def test_B25_warm_gpu_time_is_charged_and_window_is_short(self):
        now = [0.0]
        scaler, ledger, heartbeat = RecordingScaler(), ChargingLedger(), {}
        assets = SimpleNamespace(closed=False, idle=lambda: True)
        warmth = GpuWarmth(scaler, assets, ledger, heartbeat, k=2, clock=lambda: now[0])
        warmth.start()
        now[0] = 60.0
        warmth.close()
        self.assertAlmostEqual(ledger.h100_s, 2 * 60.0, delta=1.0)
        self.assertLessEqual(scaler.calls[0][2], 120)

    def test_B27_resume_reuses_existing_src_png(self):
        images = FakeImages()
        cache = Path(tempfile.mkdtemp()) / "cache"
        cache.mkdir(parents=True)
        (cache / "stool.src.png").write_bytes(b"\x89PNG\r\n\x1a\n" + b"x" * 16)
        q = AssetQueue(cache, images, FakeMeshes(), FakeLedger(),
                       clock=Clock(), sleep=Clock().sleep)
        q.put("kitchen", [key("stool")])
        q.wait("kitchen")
        self.assertEqual(images.seen, [])

    def test_B39_truncated_png_is_rejected(self):
        truncated = b"\x89PNG\r\n\x1a\n" + b"\x00garbage-not-a-real-png"
        try:
            out = as_png(truncated)
        except Exception:
            return  # rejected loudly: acceptable
        self.assertNotEqual(out, truncated, "truncated PNG passed through as-is")


if __name__ == "__main__":
    unittest.main()
