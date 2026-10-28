"""Offline contract tests for llm wrapper rules (spec sections 6, 13).
usage: cd h0/dream && python3 -m unittest -q
"""

import unittest

import llm
from fake import FakeTransport


def _msgs():
    return [{"role": "user", "content": "hi"}]


class LlmRulesTest(unittest.TestCase):
    def test_retry_empty_with_bigger_limit(self):
        tr = FakeTransport(script=["", "clarinet bridge"])
        llm.reset_spent()
        r = llm.call("director", "sys", _msgs(), max_tokens=500,
                     fake=True, _transport=tr)
        self.assertEqual(r.text, "clarinet bridge")
        self.assertEqual(tr.calls, 2)
        self.assertGreater(tr.sent[1]["max_tokens"], tr.sent[0]["max_tokens"])

    def test_spark_floor_300(self):
        tr = FakeTransport(script=["hero line"])
        llm.reset_spent()
        llm.call("hero", "sys", _msgs(), max_tokens=120,
                 fake=True, _transport=tr)
        # hero is Spark Open now: its floor is higher, Spark 1.3 keeps 300
        self.assertGreaterEqual(tr.sent[0]["max_tokens"], 1500)
        self.assertEqual(tr.sent[0]["max_tokens"], 1500)
        self.assertEqual(llm._min_tokens(llm.SPARK_MODEL), 300)

    def test_spark_never_low(self):
        for role in ("hero", "actor", "compress", "judge"):
            model, effort = llm.resolve(role)
            self.assertEqual(model, "meta-models/muse-spark-open-1026")
            self.assertNotEqual(effort, "low")

    def test_money_sums(self):
        llm.reset_spent()
        t1 = FakeTransport(script=["a"])
        r1 = llm.call("hero", "sys", _msgs(), max_tokens=300,
                      fake=True, _transport=t1)
        t2 = FakeTransport(script=["a" * 100, "b" * 100])
        r2 = llm.call("director", "sys", _msgs(), max_tokens=500,
                      fake=True, _transport=t2)
        self.assertEqual(r1.dollars, 0)  # Spark Open on Baseten is free
        self.assertGreater(r2.dollars, 0)
        self.assertAlmostEqual(llm.get_spent(), r1.dollars + r2.dollars)

    def test_money_covers_fish_and_image(self):
        llm.reset_spent()
        t1 = FakeTransport(script=["a"])
        r1 = llm.call("hero", "sys", _msgs(), max_tokens=300,
                      fake=True, _transport=t1)
        fish = llm.charge_fish(1000)
        img = llm.charge_image(1)
        self.assertGreater(fish, 0)
        self.assertGreater(img, 0)
        self.assertAlmostEqual(llm.get_spent(),
                               r1.dollars + fish + img)


if __name__ == "__main__":
    unittest.main()
