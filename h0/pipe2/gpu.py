"""Warm GPU lifecycle, kept alive by a heartbeat and always reset on exit."""

import threading
import time
from typing import Protocol


class Autoscaler(Protocol):
    def set(self, min_containers: int, buffer_containers: int, scaledown_window: int): ...


class ModalAutoscaler:
    def __init__(self, app='dreamer-sam3d', cls='Sam3D'):
        self.app, self.cls = app, cls

    def set(self, min_containers, buffer_containers, scaledown_window):
        import modal
        modal.Cls.from_name(self.app, self.cls)().update_autoscaler(
            min_containers=min_containers, buffer_containers=buffer_containers,
            scaledown_window=scaledown_window)


#: B25 (lessons #33/#38): a warm container outlives the last call by at most this
WARM_WINDOW_S = 120


class GpuWarmth:
    def __init__(self, autoscaler, assets, ledger, heartbeat, *, k, clock=time.time):
        self.autoscaler, self.assets, self.ledger = autoscaler, assets, ledger
        self.heartbeat, self.k, self.clock = heartbeat, k, clock
        self._closed = False
        self._started = False
        self._started_at = None
        self._lock = threading.RLock()

    def start(self):
        with self._lock:
            if self._closed or self._started:
                return
            self.heartbeat['ts'] = self.clock()
            self.autoscaler.set(self.k, 0, WARM_WINDOW_S)
            self._started = True
            self._started_at = self.clock()

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
                self.autoscaler.set(0, 0, WARM_WINDOW_S)
                self._closed = True
                # B25: k warm H100s bill for every second they are held, busy or not
                charge = getattr(self.ledger, 'charge', None)
                if self._started_at is not None and charge is not None:
                    charge('h100_s', self.k * max(0.0, self.clock() - self._started_at))
