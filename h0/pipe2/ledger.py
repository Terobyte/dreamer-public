"""Run ledger: one jsonl event per call, plus the spend/call caps that stop a run."""

import json
import os
import threading
import time
from pathlib import Path

PRICES_PATH = Path(__file__).with_name("prices.json")

# every event line carries these keys, so readers never have to guess
EVENT_FIELDS = ("ts", "kind", "role", "room", "round", "effort", "latency_s",
                "prompt_tokens", "completion_tokens", "reasoning_tokens",
                "finish_reason", "valid", "cost_usd")

PER_MILLION = 1_000_000.0


def load_prices(path=PRICES_PATH):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


class Ledger:
    """Append-only event log + budget. One instance per run, shared by every worker."""

    def __init__(self, path, prices, cap_usd, cap_calls, *, clock=time.time):
        self.path = Path(path)
        self.prices = prices
        self.cap_usd = cap_usd
        self.cap_calls = cap_calls
        self.clock = clock
        self.spent = 0.0
        self.calls = 0
        self.capped = False
        self._lock = threading.RLock()
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def record(self, event):
        with self._lock:
            line = {field: event.get(field) for field in EVENT_FIELDS}
            line.update({k: v for k, v in event.items() if k not in line})
            if line["ts"] is None:
                line["ts"] = self.clock()
            with open(self.path, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(line, ensure_ascii=False) + "\n")

    def cost_of(self, kind, units):
        """Price `units` of `kind` without charging. Unknown price -> 0."""
        if kind == "spark":
            price = (self.prices.get("spark") or {}).get(units.get("effort"))
            if not price:
                return 0.0
            return (units.get("in", 0) * price["in"] + units.get("out", 0) * price["out"]) / PER_MILLION
        price = self.prices.get(kind)
        return 0.0 if price is None else units * price

    def charge(self, kind, units, reserved=0.0):
        """Charge the actual cost, releasing a prior `allow` reservation (if any)."""
        cost = self.cost_of(kind, units)
        with self._lock:
            self.spent += cost - reserved
        return cost

    def allow(self, kind, estimate_usd):
        """Called before an external call: reserves the estimate against the cap, or
        refuses once the cap is reached. A granted reservation must be released by
        passing the same `estimate_usd` as `reserved` to the matching `charge` call -
        otherwise concurrent in-flight calls could all pass the same cap check."""
        with self._lock:
            if self.calls >= self.cap_calls or self.spent + estimate_usd > self.cap_usd:
                if not self.capped:
                    self.capped = True
                    self.record({"kind": "cap_hit", "role": kind, "cost_usd": self.spent})
                return False
            self.calls += 1
            self.spent += estimate_usd
            return True
