"""Phase 1 contract (row Ф1 of 7.2): the phase result is written down and matches the ledger.

Offline: reads DEVLOG.md, PROGRESS.md and h0/out/dream/bank/f1_ledger.jsonl, never the network.
The summary is data, not prose: every step of the phase has a row, the ledger total in the text
is the total the ledger file actually holds, every §13 debt item is marked closed or open, and
the one thing code cannot decide (a human reading the comic) is named as the owner's call.
"""

import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import bench_f1  # noqa: E402

ROOT = os.path.realpath(os.path.join(HERE, "..", ".."))
DEVLOG = os.path.join(ROOT, "DEVLOG.md")
PROGRESS = os.path.join(ROOT, "PROGRESS.md")
HEADING = "Фаза 1 — итог"
STEPS = ("1.0", "1.1", "1.2a", "1.2b", "1.2c", "1.3", "1.4", "1.4b", "1.5", "Ф1")
DEBT = tuple("Д%d" % i for i in range(1, 13))
OWNER_LINE = "чтение человеком ≥ 3 (7б) — за хозяином"


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def summary(text):
    """The phase-result block: from its heading to the next heading of the same level."""
    i = text.find(HEADING)
    if i < 0:
        return ""

    rest = text[i:]
    nxt = re.search(r"\n## ", rest)
    return rest[:nxt.start()] if nxt else rest


def ledger_totals():
    rows = bench_f1.load_ledger(bench_f1.LEDGER)
    gated = sum(r.get("dollars") or 0 for r in rows if r.get("step") != bench_f1.SPIKE_STEP)
    spike = sum(r.get("dollars") or 0 for r in rows if r.get("step") == bench_f1.SPIKE_STEP)
    return round(gated, 4), round(spike, 4)


class PhaseSummaryTest(unittest.TestCase):
    def setUp(self):
        self.devlog = summary(read(DEVLOG))
        self.progress = summary(read(PROGRESS))
        self.assertTrue(self.devlog, "DEVLOG.md has no %r block" % HEADING)
        self.assertTrue(self.progress, "PROGRESS.md has no %r block" % HEADING)

    def test_every_step_has_a_row(self):
        for where, text in (("DEVLOG", self.devlog), ("PROGRESS", self.progress)):
            for step in STEPS:
                # a table row that starts with the step, not a passing mention ("1.2a" in Д3)
                row = re.search(r"(?m)^\| *" + re.escape(step) + r" [^\n]*\|$", text)
                self.assertTrue(row, "%s summary has no table row for step %s" % (where, step))

    def test_ledger_total_matches_the_ledger_file(self):
        gated, spike = ledger_totals()
        for where, text in (("DEVLOG", self.devlog), ("PROGRESS", self.progress)):
            money = [float(m) for m in re.findall(r"\$(\d+\.\d+)", text)]
            self.assertIn(gated, money,
                          "%s summary must state the ledger total $%.4f, found %s"
                          % (where, gated, money))
            self.assertIn(spike, money,
                          "%s summary must state the 1.5 spike $%.4f, found %s"
                          % (where, spike, money))

    def test_debt_items_are_closed_or_open(self):
        for item in DEBT:
            # the debt list, not a passing mention of the item inside the step table
            m = re.search(r"(?m)^[-*] +" + re.escape(item) + r"\b[^\n]*", self.devlog)
            self.assertTrue(m, "DEVLOG summary misses debt item %s" % item)
            line = m.group(0)
            self.assertTrue("закрыт" in line or "открыт" in line,
                            "%s is neither закрыт nor открыт: %r" % (item, line))

    def test_human_reading_is_the_owners_call(self):
        for where, text in (("DEVLOG", self.devlog), ("PROGRESS", self.progress)):
            self.assertIn(OWNER_LINE, text, "%s summary misses the 7б line" % where)

    def test_two_runs_of_f1_exceed_the_ceiling(self):
        """Why the paid Ф1 bench is not repeated: the median needs 2 runs and 2 more runs do
        not fit under the ceiling. Pure arithmetic over the ledger -- this test never buys anything."""
        gated, _ = ledger_totals()
        jobs = bench_f1.job_count(bench_f1.CANONICAL_SCENE, bench_f1.CANONICAL_TALK, 2)
        self.assertEqual(jobs, 2)
        self.assertGreater(gated + bench_f1.PER_RUN * jobs, bench_f1.CEILING,
                           "the ceiling now has room for 2 runs: run the Ф1 bench")
        self.assertIn("потолок", self.devlog,
                      "DEVLOG summary must say why the Ф1 bench was not repeated")
        for where, text in (("DEVLOG", self.devlog), ("PROGRESS", self.progress)):
            self.assertIn("Д12", text, "%s summary must name the open Ф1 gate as debt Д12" % where)


if __name__ == "__main__":
    unittest.main()
