"""Red tests for blocking findings (spec sections 6, 7, 13).
usage: cd h0/dream && python3 -m unittest -q
"""

import io
import json
import os
import tempfile
import unittest
import urllib.request

import llm
from fake import FakeTransport
from memory import BudgetError, Memory


def make_mem(**kw):
    m = Memory(root=tempfile.mkdtemp(), **kw)
    m.set_core(desire="wants quiet after the fight",
               anxiety="fears the boss shouting again",
               scene="squidward living room",
               objects=["clarinet", "old radio"], bridge="none yet")
    return m


class FixesTest(unittest.TestCase):
    def test_provider_usage_kept_and_summed(self):
        tr = FakeTransport(script=[
            {"content": "", "usage": {"prompt_tokens": 10, "completion_tokens": 0}},
            {"content": "ok", "usage": {"prompt_tokens": 123, "completion_tokens": 7}}])
        llm.reset_spent()
        r = llm.call("director", "s", [{"role": "user", "content": "hi"}],
                     max_tokens=500, fake=True, _transport=tr)
        self.assertEqual(r.usage["prompt_tokens"], 133)
        self.assertEqual(r.usage["completion_tokens"], 7)
        self.assertAlmostEqual(r.dollars, (133 * llm.WONDER_IN_PER_M
                                            + 7 * llm.WONDER_OUT_PER_M) / 1e6)

    def test_real_call_via_meta_api_not_missing_module(self):
        class Resp(io.BytesIO):
            def __enter__(self): return self
            def __exit__(self, *a): return False
        body = json.dumps({"choices": [{"message": {"content": "real ok"}}],
                           "usage": {"prompt_tokens": 5, "completion_tokens": 2}}).encode()
        seen = {}
        orig = urllib.request.urlopen
        os.environ["META_MODEL_API_KEY"] = "test-key"
        urllib.request.urlopen = lambda req, timeout=0: (seen.update(url=req.full_url), Resp(body))[1]
        try:
            r = llm.call("director", "s", [{"role": "user", "content": "hi"}], fake=False)
        finally:
            urllib.request.urlopen = orig
            del os.environ["META_MODEL_API_KEY"]
        self.assertEqual(r.text, "real ok")
        self.assertIn("api.meta.ai", seen["url"])
        self.assertEqual(r.usage["prompt_tokens"], 5)

    def test_merge_two_raw_becomes_one_from_raw(self):
        fake = FakeTransport(script=["A raw episode B raw episode merged"])
        m = make_mem(transport=fake)
        m.save_episode_raw("a", "A raw episode")
        m.save_episode_raw("b", "B raw episode")
        m.merge_from_raw()
        self.assertEqual(fake.calls, 1)
        self.assertEqual(len(m.episodes), 1)
        self.assertIn("A raw episode", m.episodes[0]["text"])
        self.assertIn("B raw episode", m.episodes[0]["text"])
        self.assertTrue(os.path.exists(os.path.join(m.raw_dir, "a.txt")))

    def test_state_tail_present(self):
        m = make_mem()
        text, sizes = m.build_prompt({"scene": "porch", "build_state": "building",
                                      "build": 45, "requirement": "bridge required",
                                      "nudged": True, "forced": False,
                                      "bridge_locked": True,
                                      "events": ["dart missed"]})
        for marker in ("build_state", "45", "bridge required", "nudged",
                       "bridge_locked", "dart missed"):
            self.assertIn(marker, text)
        self.assertIn("tail", sizes)

    def test_working_layer_budget_and_archive(self):
        m = make_mem()
        m.add_line("hero", "x" * 14000)
        text, sizes = m.build_prompt({})
        self.assertLessEqual(sizes["working"], 1000)
        archived = ""
        for f in os.listdir(m.raw_dir):
            with open(os.path.join(m.raw_dir, f)) as fh:
                archived += fh.read()
        self.assertIn("x" * 500, archived)

    def test_trim_tail_summary_before_working_cut(self):
        m = make_mem()
        for i in range(20):
            m.add_line("hero", "keepme line %d " % i + "y" * 100)
        for i in range(50):
            m.add_event("jamevent %d " % i + "z" * 900)
        text, sizes = m.build_prompt({})
        self.assertLessEqual(sizes["total"], 5800)
        self.assertIn("keepme line 0", text)
        self.assertIn("summary", text.lower())

    def test_oldest_episode_first_line_only(self):
        m = make_mem()
        m.episodes = [
            {"id": "old", "text": "OLDFIRST unique line\n" + "oldrest " * 3000},
            {"id": "new", "text": "NEWFULL first line\nnewrest stays whole"}]
        for i in range(50):
            m.add_event("ev %d " % i + "q" * 300)
        text, _ = m.build_prompt({})
        self.assertIn("OLDFIRST unique line", text)
        self.assertNotIn("oldrest oldrest oldrest oldrest oldrest", text)
        self.assertIn("NEWFULL", text)
        self.assertIn("newrest stays whole", text)

    def test_facts_selected_by_titles_via_spark(self):
        # Selection is background-only: build_prompt must not call Spark.
        fake = FakeTransport(script=["old1, old3"])
        m = make_mem(transport=fake)
        for i in range(6):
            m.facts.append({"id": "f%d" % i, "title": "old%d" % i,
                            "text": "factbody%d " % i + "x" * 600,
                            "supersedes_id": None, "scene_epoch": -1})
        m._sel_cache = None
        m.select_facts_background().join(timeout=5)
        self.assertGreaterEqual(fake.calls, 1)
        calls = fake.calls
        text, _ = m.build_prompt({})
        self.assertEqual(fake.calls, calls)  # cached per scene, no LLM here
        self.assertIn("factbody1", text)
        self.assertIn("factbody3", text)
        m.build_prompt({})
        self.assertEqual(fake.calls, calls)

    def test_hard_cap_raises_budget_error_type(self):
        m = make_mem()
        m.set_core(desire="D" * 30000)
        with self.assertRaises(BudgetError):
            m.build_prompt({})


if __name__ == "__main__":
    unittest.main()
