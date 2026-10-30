"""One clock for the whole dream: real monotonic time, waits divided by speed (spec section 5).
usage: c = Clock(speed=20); c.now(); c.sleep(7 * 60)  # sleeps 21 s
"""

import time


class Clock:
    def __init__(self, speed=1.0):
        self.speed = float(speed)
        self.t0 = time.monotonic()
        self._paused_at = None

    def now(self):
        """Real seconds since start (what the log stores as t). While paused the
        dream's time stands still: now() keeps the value it had at pause()."""
        if self._paused_at is not None:
            return self._paused_at - self.t0
        return time.monotonic() - self.t0

    def pause(self):
        """2.2: stop the dream's clock, so no fsm timer or scene event comes due."""
        if self._paused_at is None:
            self._paused_at = time.monotonic()

    def resume(self):
        """Go on from the same now(): the pause costs the dream no simulated time."""
        if self._paused_at is not None:
            self.t0 += time.monotonic() - self._paused_at
            self._paused_at = None

    def scale(self, seconds):
        """A simulation timer or pause in real seconds."""
        return seconds / self.speed

    def sleep(self, seconds):
        time.sleep(max(0.0, seconds) / self.speed)

    def real_sleep(self, seconds):
        """Unscaled wall-clock wait: real latency (e.g. a director call) that
        world speed does not compress."""
        time.sleep(max(0.0, seconds))
