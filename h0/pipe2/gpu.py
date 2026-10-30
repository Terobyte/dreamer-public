"""Warm GPU lifecycle, kept alive by a heartbeat and always reset on exit."""

import threading
import time
from typing import Protocol


class Autoscaler(Protocol):
    def set(self, min_containers: int, buffer_containers: int, scaledown_window: int): ...


class ModalAutoscaler:
    def set(self, min_containers, buffer_containers, scaledown_window):
        import modal
        modal.Cls.from_name('dreamer-sam3d', 'Sam3D')().update_autoscaler(
            min_containers=min_containers, buffer_containers=buffer_containers,
            scaledown_window=scaledown_window)


class GpuWarmth:
    def __init__(self, autoscaler, assets, ledger, heartbeat, *, k, clock=time.time):
        self.autoscaler, self.assets, self.ledger = autoscaler, assets, ledger
        self.heartbeat, self.k, self.clock = heartbeat, k, clock
        self._closed = False
        self._started = False
        self._lock = threading.RLock()

    def start(self):
        with self._lock:
            if self._closed or self._started:
                return
            self.heartbeat['ts'] = self.clock()
            self.autoscaler.set(self.k, 0, 600)
            self._started = True

    def tick(self):
        with self._lock:
            if self._closed:
                return
            self.heartbeat['ts'] = self.clock()
            if self.ledger.capped or (self.assets.closed and self.assets.idle()):
                self.close()

    def close(self):
        with self._lock:
            if not self._closed:
                self.autoscaler.set(0, 0, 120)
                self._closed = True
