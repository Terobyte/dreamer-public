import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch


class GpuTest(unittest.TestCase):
    def test_warmth_order_idle_cap_and_idempotency(self):
        from pipe2.gpu import GpuWarmth
        heartbeat, calls = {}, []
        assets = SimpleNamespace(closed=False, idle=lambda: True)
        ledger = SimpleNamespace(capped=False)
        now = [0]
        class Scale:
            def set(self, minimum, buffer, window):
                calls.append((heartbeat.get('ts'), minimum, buffer, window))
        warmth = GpuWarmth(Scale(), assets, ledger, heartbeat, k=4, clock=lambda: now[0])
        warmth.start(); self.assertEqual(calls, [(0, 4, 0, 120)])  # B25: window <= 120 s
        now[0] = 30; warmth.tick()
        self.assertEqual(heartbeat['ts'], 30)
        self.assertEqual(len(calls), 1)
        assets.closed = True; warmth.tick(); warmth.close(); warmth.close()
        self.assertEqual(calls[-1], (30, 0, 0, 120))
        self.assertEqual(len(calls), 2)
        other = GpuWarmth(Scale(), assets, ledger, heartbeat, k=2, clock=lambda: 40)
        assets.closed = False; other.start(); ledger.capped = True; other.tick()
        self.assertEqual(calls[-1], (40, 0, 0, 120))

    def test_modal_adapter_calls_instance(self):
        from pipe2.gpu import ModalAutoscaler
        modal = MagicMock()
        with patch.dict(sys.modules, {'modal': modal}):
            ModalAutoscaler().set(2, 0, 600)
        modal.Cls.from_name.return_value.return_value.update_autoscaler.assert_called_once_with(
            min_containers=2, buffer_containers=0, scaledown_window=600)

    def load_sam(self):
        modal = MagicMock()
        modal.enter.return_value = lambda fn: fn
        modal.method.return_value = lambda fn: fn
        modal.local_entrypoint.return_value = lambda fn: fn
        modal.function.return_value = lambda fn: fn
        modal.App.return_value.function.return_value = lambda fn: fn
        modal.App.return_value.cls.return_value = lambda cls: cls
        path = Path(__file__).parents[1] / 'sam3d_modal.py'
        spec = importlib.util.spec_from_file_location('sam_for_test', path)
        module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {'modal': modal}):
            spec.loader.exec_module(module)
        return module, modal

    def test_pack_and_save_without_ply(self):
        sam, _ = self.load_sam()
        out = {'glb': MagicMock(), 'gs': MagicMock()}
        out['glb'].export.return_value = b'glb'
        r = sam.pack_result('box', out, False, 1.234, True)
        self.assertEqual(r['ply'], b''); out['gs'].save_ply.assert_not_called()
        folder = Path(tempfile.mkdtemp()); sam.save_result(folder, r)
        self.assertEqual((folder / 'box.glb').read_bytes(), b'glb')
        self.assertFalse((folder / 'box.ply').exists())
        r['ply'] = b'ply'; sam.save_result(folder, r)
        self.assertEqual((folder / 'box.ply').read_bytes(), b'ply')
        with self.assertRaises(ValueError):
            sam.save_result(folder, {**r, 'name': '../escape'})

    def test_watchdog_stale_and_fresh(self):
        sam, modal = self.load_sam()
        sam.heartbeat = {}
        with patch('time.time', return_value=1000):
            sam.watchdog()
            modal.Cls.from_name.return_value.return_value.update_autoscaler.assert_called_once_with(
                min_containers=0, buffer_containers=0, scaledown_window=120)
            modal.Cls.from_name.reset_mock(); sam.heartbeat['ts'] = 999; sam.watchdog()
            modal.Cls.from_name.assert_not_called()
