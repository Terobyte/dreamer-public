import threading
import pytest
from pipe2.gpu import GpuWarmth

class FailingAutoscaler:
    def set(self, *a, **kw):
        raise TimeoutError("modal timeout")

class FakeLedger:
    def __init__(self):
        self.charges = []
        self.capped = False
    def charge(self, kind, amount):
        self.charges.append((kind, amount))

class FakeAssets:
    closed = False
    def idle(self):
        return False

def test_close_marks_closed_and_charges_on_autoscaler_failure():
    t = [100.0]
    ledger = FakeLedger()
    g = GpuWarmth(FailingAutoscaler(), FakeAssets(), ledger, {'ts': 0}, k=2, clock=lambda: t[0])
    # simulate successful start (bypass failing autoscaler by patching temporarily)
    g._started = True
    g._started_at = 100.0
    t[0] = 110.0
    with pytest.raises(TimeoutError):
        g.close()
    assert g._closed is True, "close() must mark closed even if autoscaler.set fails"
    assert ledger.charges, "ledger must be charged for worked time even if autoscaler.set fails"
    kind, amount = ledger.charges[0]
    assert kind == 'h100_s'
    assert amount == pytest.approx(2 * 10.0)
