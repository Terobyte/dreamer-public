"""Real progress of a place build: one line per change in progress.jsonl, read by the page.

The bar is the sum over stages of weight x done-fraction. Weights are the seconds each stage took on the last
measured run (timings.json next to this file, updated after every run), so 50 % means "half of the expected time
is behind us". Inside a stage: assets count finished files (a mesh weighs more than a picture); a Spark call
has no inner signal, so it moves with its own elapsed time against the last measurement and stops at 90 % of
the stage until the answer is in.
"""
import json
import threading
import time
from pathlib import Path

TIMINGS = Path(__file__).with_name("timings.json")
DEFAULT = {"read": 35, "plan": 120, "compile": 3, "assets": 240, "build": 25, "shell_assets": 60, "shell_build": 10,
           "wish": 25}


def load_timings():
    try:
        return {**DEFAULT, **json.loads(TIMINGS.read_text())}
    except (OSError, ValueError):
        return dict(DEFAULT)


class Progress:
    def __init__(self, path: Path, stages: list[str], label: str, clock=time.time):
        self.path, self.stages, self.label, self.clock = Path(path), stages, label, clock
        self.w = load_timings()
        self.frac = {s: 0.0 for s in stages}
        self.cur, self.t0, self.stage_t0, self.took = None, clock(), clock(), {}
        self.lock = threading.Lock()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text("")
        self._stop = threading.Event()
        threading.Thread(target=self._tick, daemon=True).start()

    def pct(self):
        tot = sum(self.w[s] for s in self.stages)
        return round(100 * sum(self.w[s] * self.frac[s] for s in self.stages) / tot, 1)

    def eta(self):
        left = sum(self.w[s] * (1 - self.frac[s]) for s in self.stages)
        return round(left)

    def emit(self, note=""):
        rec = {"t": round(self.clock() - self.t0, 1), "pct": self.pct(), "stage": self.cur, "eta_s": self.eta(),
               "label": self.label, "note": note}
        with self.lock, self.path.open("a") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")

    def start(self, stage, note=""):
        if self.cur:
            self.done(self.cur)
        self.cur, self.stage_t0 = stage, self.clock()
        self.emit(note)

    def set(self, frac, note=""):
        self.frac[self.cur] = max(self.frac[self.cur], min(1.0, frac))
        self.emit(note)

    def done(self, stage):
        self.frac[stage] = 1.0
        self.took[stage] = round(self.clock() - self.stage_t0, 1)
        self.cur = None

    def finish(self, ok=True, note=""):
        if self.cur and ok:
            self.done(self.cur)
        self._stop.set()
        rec = {"t": round(self.clock() - self.t0, 1), "pct": 100.0 if ok else self.pct(), "stage": "done" if ok else "failed",
               "eta_s": 0, "label": self.label, "note": note, "took": self.took}
        with self.lock, self.path.open("a") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        if ok:  # the next bar is weighted by what this run measured
            w = load_timings()
            w.update(self.took)
            TIMINGS.write_text(json.dumps(w, indent=1))

    def _tick(self):
        """time-only stages (Spark) creep against their measured length, never past 90 %"""
        while not self._stop.wait(1.0):
            s = self.cur
            if s in ("read", "plan", "wish", "compile", "build", "shell_build"):
                el = self.clock() - self.stage_t0
                f = min(0.9, el / max(1.0, self.w[s]))
                if f > self.frac[s] + 0.005:
                    self.frac[s] = f
                    self.emit()
