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

    def __init__(self, path, prices, cap_usd, cap_calls, cap_tokens=None, *, clock=time.time, resume=False):
        self.path = Path(path)
        self.prices = prices
        self.cap_usd = cap_usd
        self.cap_calls = cap_calls
        # Spark's price is unknown, so tokens - not dollars - are its real cap.
        # None means "no token cap": callers written before this existed still work.
        self.cap_tokens = cap_tokens
        self.clock = clock
        self.spent = 0.0
        self.calls = 0
        self.calls_by_kind = {}
        self.tokens_used = 0
        self.tokens_reserved = 0
        self.capped = False
        self.closed = False
        self._lock = threading.RLock()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._budget_path = self.path.with_suffix(".budget.json")
        if resume and self._budget_path.exists():
            saved = json.loads(self._budget_path.read_text())
            for key in ("spent", "calls", "calls_by_kind", "tokens_used", "tokens_reserved", "capped"):
                setattr(self, key, saved[key])
        elif resume and self.path.exists() and self.path.stat().st_size:
            raise ValueError("cannot resume an event log without its budget checkpoint")
        self._save_budget()

    def _save_budget(self):
        data = {k: getattr(self, k) for k in ("spent", "calls", "calls_by_kind", "tokens_used", "tokens_reserved", "capped")}
        temporary = self._budget_path.with_suffix(".tmp")
        temporary.write_text(json.dumps(data))
        temporary.replace(self._budget_path)

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
            self._save_budget()
        return cost

    def allow(self, kind, estimate_usd, reserve_tokens=0):
        """Called before an external call: checks every cap and reserves against it in
        one critical section, or refuses once a cap is reached. A granted reservation
        must be released - dollars by passing the same `estimate_usd` as `reserved` to
        the matching `charge`, tokens by `settle` - otherwise concurrent in-flight
        calls could all pass the same cap check.

        `cap_calls` limits `spark` only; images and GPU seconds are bounded by `cap_usd`."""
        with self._lock:
            if self.closed:
                return False
            if self._refused(kind, estimate_usd, reserve_tokens):
                if not self.capped:
                    self.capped = True
                    self._save_budget()
                    self.record({"kind": "cap_hit", "role": kind, "cost_usd": self.spent,
                                 "prompt_tokens": self.tokens_used})
                return False
            self.calls_by_kind[kind] = self.calls_by_kind.get(kind, 0) + 1
            if kind == "spark":
                self.calls += 1
            self.spent += estimate_usd
            self.tokens_reserved += reserve_tokens
            self._save_budget()
            return True

    def _refused(self, kind, estimate_usd, reserve_tokens):
        """Cap checks only - called with the lock held. Once capped, stays capped: a
        reserve freed by `settle` must not reopen a run that already hit a ceiling."""
        if self.capped or self.spent + estimate_usd > self.cap_usd:
            return True
        if kind == "spark" and self.calls >= self.cap_calls:
            return True
        return (self.cap_tokens is not None
                and self.tokens_used + self.tokens_reserved + reserve_tokens > self.cap_tokens)

    def settle(self, reserve_tokens, actual_tokens):
        """Close a granted `allow`: drop its token reserve, book what was really used."""
        with self._lock:
            self.tokens_reserved -= reserve_tokens
            self.tokens_used += actual_tokens
            self._save_budget()

    def close(self):
        with self._lock:
            self.closed = True
