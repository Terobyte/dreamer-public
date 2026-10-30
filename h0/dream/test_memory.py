"""Offline contract tests for director memory (spec sections 7, 13).
usage: cd h0/dream && python3 -m unittest -q
"""

import json
import math
import os
import tempfile
import unittest
from unittest import mock

import llm
from fake import FakeTransport
from memory import EVENT_KEEP, FACT_BUDGET, HARD_CAP, Memory


def make_mem():
    m = Memory(root=tempfile.mkdtemp(), transport=FakeTransport())
    m.set_core(desire="wants quiet after the fight",
               anxiety="fears the boss shouting again",
               scene="squidward living room",
               objects=["clarinet", "old radio"],
               bridge="none yet")
    return m


def total_of(text):
    return math.ceil(len(text) / 3.5)


class BudgetTest(unittest.TestCase):
    def test_budget_300_lines(self):
        m = make_mem()
        for i in range(300):
            who = "hero" if i % 2 == 0 else "actor"
            m.add_line(who, "line %d about the quiet evening and the clarinet song " % i
                       + "x" * 40)
        for i in range(10):
            m.record_decision({"bridge": "obj%d" % i,
                               "destination": "place %d" % i,
                               "why": "test decision %d" % i})
        for i in range(50):
            m.add_event({"type": "input", "source": "dart",
                         "value": "throw %d at the moon" % i,
                         "outcome": "missed"})
        for _ in range(300):
            text, sizes = m.build_prompt({})
            self.assertTrue(text)
            self.assertLessEqual(sizes["total"], 5800)
            self.assertLessEqual(total_of(text), 5800)

    def test_core_always_present(self):
        m = make_mem()
        m.set_core(desire="wants quiet after the fight",
                   anxiety="fears the boss shouting again",
                   scene="squidward living room",
                   objects=["clarinet", "old radio"], bridge="clarinet")
        for i in range(300):
            m.add_line("hero", "filler line %d " % i + "y" * 40)
        for i in range(10):
            m.record_decision({"bridge": "b%d" % i, "destination": "d%d" % i,
                               "why": "w%d" % i})
        m.save_episode_raw("ep1", "raw one first line\n" + "raw one rest " * 200)
        m.save_episode_raw("ep2", "raw two first line\n" + "raw two rest " * 200)
        m.merge_from_raw()
        m.apply_facts([{"op": "ADD",
                        "fact": {"title": "t", "text": "some fact"}}])
        for _ in range(3):
            text, _ = m.build_prompt({"events": ["event %d " % j + "e" * 60
                                                 for j in range(50)]})
            self.assertIn("wants quiet after the fight", text)
            self.assertIn("fears the boss shouting again", text)
            self.assertIn("squidward living room", text)
            self.assertIn("bridge: clarinet", text)
            self.assertIn("TAIL summary", text)

    def test_merge_from_raw(self):
        m = make_mem()
        m.save_episode_raw("ep1", "RAW ONE about the lullaby evening")
        m.save_episode_raw("ep2", "RAW TWO about the bus station goodbye")
        m.episodes = [{"id": "stale",
                       "text": "STALE SUMMARY that must not be used"}]
        m.merge_from_raw()
        text, _ = m.build_prompt({})
        self.assertIn("RAW ONE", text)
        self.assertIn("RAW TWO", text)
        self.assertNotIn("STALE SUMMARY", text)

    def test_trim_without_llm(self):
        fake = FakeTransport(script=["should never be consumed"])
        m = Memory(root=tempfile.mkdtemp(), transport=fake)
        m.set_core(desire="wants quiet after the fight",
                   anxiety="fears the boss shouting again",
                   scene="squidward living room",
                   objects=["clarinet", "old radio"], bridge="none yet")
        for i in range(300):
            m.add_line("actor", "overflow line %d " % i
                       + "z" * 60)
        for i in range(50):
            m.add_event("burst event %d " % i + "z" * 60)
        text, sizes = m.build_prompt({})
        self.assertEqual(fake.calls, 0)
        self.assertIn("TAIL summary", text)
        self.assertLessEqual(sizes["total"], HARD_CAP)
        self.assertLessEqual(total_of(text), HARD_CAP)

    def test_facts_supersede(self):
        m = make_mem()
        m.apply_facts([{"op": "ADD",
                        "fact": {"title": "calm",
                                 "text": "hero relaxes when music is mentioned"}}])
        text, _ = m.build_prompt({})
        self.assertIn("relaxes when music", text)
        fid = m.facts[0]["id"]
        m.apply_facts([{"op": "UPDATE", "id": fid, "supersedes_id": fid,
                        "fact": {"title": "calm",
                                 "text": "hero hates loud music now"}}])
        text, _ = m.build_prompt({})
        self.assertIn("hates loud music", text)
        self.assertNotIn("relaxes when music", text)
        m.set_scene("porch at dusk", ["rocking chair", "old radio"])
        m.apply_facts([{"op": "ADD",
                        "fact": {"title": "porch",
                                 "text": "porch fact fresh"}}])
        text, _ = m.build_prompt({})
        self.assertIn("porch fact fresh", text)


class FactsContractTest(unittest.TestCase):
    def test_add_string_fact(self):
        # Spec section 8 example passes fact as a plain string.
        m = make_mem()
        m.apply_facts([{"op": "ADD",
                        "fact": "hero relaxes when music is mentioned"}])
        text, _ = m.build_prompt({})
        self.assertIn("relaxes when music", text)

    def test_supersedes_id_persisted(self):
        m = make_mem()
        m.apply_facts([{"op": "ADD",
                        "fact": {"title": "calm",
                                 "text": "hero relaxes when music"}}])
        fid = m.facts[0]["id"]
        m.apply_facts([{"op": "UPDATE", "id": fid, "supersedes_id": fid,
                        "fact": {"title": "calm",
                                 "text": "hero hates loud music now"}}])
        with open(m.facts_path, encoding="utf-8") as f:
            rows = [json.loads(l) for l in f if l.strip()]
        self.assertTrue(rows)
        for row in rows:
            self.assertIn("supersedes_id", row)
        self.assertEqual(rows[-1]["supersedes_id"], fid)

    def test_same_scene_add_keeps_prior_picks(self):
        # Selection is once per scene; a same-scene ADD must append
        # the new fact without replacing previously picked old ones.
        m = make_mem()
        for i in range(6):
            m.apply_facts([{"op": "ADD",
                            "fact": {"title": "old%d" % i,
                                     "text": "x" * 600}}])
        m.set_scene("porch at dusk", ["rocking chair"])
        before, _ = m.build_prompt({})
        picked = ["old%d" % i for i in range(6) if "old%d" % i in before]
        self.assertTrue(picked)
        m.apply_facts([{"op": "ADD",
                        "fact": {"title": "fresh",
                                 "text": "y" * 60}}])
        after, _ = m.build_prompt({})
        self.assertIn("fresh", after)
        for title in picked:
            self.assertIn(title, after)


class MemoryOpenBugsTest(unittest.TestCase):
    """B1/B6/B7/B8: offline regressions for memory integration and archives."""

    def setUp(self):
        root = tempfile.TemporaryDirectory()
        self.addCleanup(root.cleanup)
        self.root = root.name
        guard = mock.patch.object(llm.urllib.request, "urlopen",
                                  side_effect=AssertionError("network forbidden"))
        guard.start()
        self.addCleanup(guard.stop)

    def _episodes(self, transport=None):
        memory = Memory(self.root, transport=transport)
        memory.save_episode_raw("ep1", "first episode")
        memory.save_episode_raw("ep2", "second episode")
        return memory

    def _overflow_facts(self, transport=None):
        memory = Memory(self.root, transport=transport)
        memory.apply_facts([
            {"op": "ADD", "fact": {"title": "fact%d" % i, "text": "x" * 800}}
            for i in range(6)
        ])
        memory.set_scene("new scene", ["radio"])
        self.assertGreater(memory._facts_cost(memory.facts), FACT_BUDGET)
        return memory

    def test_b1_background_merge_uses_real_wrapper_without_injected_transport(self):
        memory = self._episodes()
        reply = llm.LlmResult("merged episodes", {}, 0, 0)
        with mock.patch.object(llm, "call", return_value=reply) as call:
            worker = memory.merge_background()
            worker.join(timeout=1)
            self.assertFalse(worker.is_alive())
        call.assert_called_once()
        self.assertFalse(call.call_args.kwargs.get("fake", False))
        self.assertEqual(memory.episodes[0]["text"], "merged episodes")

    def test_b1_background_fact_selection_uses_real_wrapper_without_transport(self):
        memory = self._overflow_facts()
        reply = llm.LlmResult("f6", {}, 0, 0)
        with mock.patch.object(llm, "call", return_value=reply) as call:
            worker = memory.select_facts_background()
            worker.join(timeout=1)
            self.assertFalse(worker.is_alive())
        call.assert_called_once()
        self.assertFalse(call.call_args.kwargs.get("fake", False))
        self.assertEqual([f["id"] for f in memory._facts_for_prompt()], ["f6"])

    def test_b6_failed_merge_is_logged_and_keeps_raw_episodes(self):
        memory = self._episodes(FakeTransport())
        with mock.patch.object(llm, "call", side_effect=OSError("merge unavailable")):
            with self.assertLogs(level="WARNING") as captured:
                memory.merge_from_raw()
        self.assertIn("merge unavailable", "\n".join(captured.output))
        self.assertEqual([e["text"] for e in memory.episodes],
                         ["first episode", "second episode"])

    def test_b6_failed_fact_selection_is_logged(self):
        memory = self._overflow_facts(FakeTransport())
        with mock.patch.object(llm, "call", side_effect=OSError("selection unavailable")):
            with self.assertLogs(level="WARNING") as captured:
                memory._select_facts()
        self.assertIn("selection unavailable", "\n".join(captured.output))
        self.assertEqual(len(memory.facts), 6)

    def test_b7_all_memory_state_exists_before_first_operation(self):
        memory = Memory(self.root)
        initial_fields = set(vars(memory))
        self.assertIn("_merge_groups", initial_fields)
        self.assertIn("_merge_summaries", initial_fields)
        memory.save_episode_raw("ep1", "first episode")
        memory.merge_from_raw()
        memory.set_scene("porch", ["chair"])
        memory.apply_facts([{"op": "ADD", "fact": "fresh fact"}])
        memory._select_facts()
        memory.add_line("hero", "hello")
        memory.add_event("door opens")
        memory.record_decision({"bridge": "chair"})
        memory.build_prompt({})
        self.assertEqual(set(vars(memory)), initial_fields,
                         "Memory created state outside __init__")

    def test_b8_merge_uses_two_oldest_archives_in_chronological_order(self):
        transport = FakeTransport(["merged oldest episodes"])
        memory = Memory(self.root, transport=transport)
        memory._archive_working([{"who": "hero", "text": "OLDEST dialogue"}])
        for i in range(2 * EVENT_KEEP + 1):
            memory.add_event("NEWER event %d" % i)
        self.assertGreaterEqual(len(memory._read_raws()), 3)
        memory.merge_from_raw()
        self.assertEqual(transport.calls, 1)
        self.assertEqual(memory.episodes[0]["raw_ids"],
                         ["working_archive_001", "events_archive_002"])
        self.assertTrue(transport.sent[0]["messages"][0]["content"].startswith(
            "hero: OLDEST dialogue"))


class MemoryConcurrencyTest(unittest.TestCase):
    def setUp(self):
        self.root = self.enterContext(tempfile.TemporaryDirectory())
        self.enterContext(mock.patch('urllib.request.urlopen', side_effect=AssertionError('network forbidden')))

    def test_archive_order_and_sequence_survive_reload(self):
        first = Memory(self.root, transport=FakeTransport(['summary']))
        first._archive_working([{'who': 'hero', 'text': 'first'}])
        first.save_episode_raw(first._next_archive_id('events_archive'), 'second')
        # Filename timestamps cannot change an explicitly saved chronology.
        os.utime(os.path.join(first.raw_dir, 'working_archive_001.txt'), (100, 100))
        os.utime(os.path.join(first.raw_dir, 'events_archive_002.txt'), (0, 0))
        restored = Memory(self.root, transport=FakeTransport(['summary']))
        self.assertEqual([r['id'] for r in restored._read_raws()],
                         ['working_archive_001', 'events_archive_002'])
        self.assertEqual(restored._next_archive_id('working_archive'), 'working_archive_003')
        restored.merge_from_raw()
        self.assertEqual(restored.episodes[0]['raw_ids'],
                         ['working_archive_001', 'events_archive_002'])

    def test_slow_merge_does_not_block_inputs_or_lose_appended_archives(self):
        import threading
        entered, release, written = threading.Event(), threading.Event(), threading.Event()

        class Slow(FakeTransport):
            def complete(self, **kwargs):
                entered.set()
                if not release.wait(2):
                    raise TimeoutError('test did not release provider')
                return super().complete(**kwargs)

        memory = Memory(self.root, transport=Slow(['summary']))
        memory.save_episode_raw('a', 'oldest')
        memory.save_episode_raw('b', 'second')
        worker = memory.merge_background()
        self.addCleanup(worker.join, 2)
        self.addCleanup(release.set)
        self.assertTrue(entered.wait(1))
        self.assertIs(memory.merge_background(), worker)

        def write():
            memory.add_line('human', 'input during compression')
            memory.save_episode_raw('c', 'newest')
            memory.build_prompt({})
            written.set()

        writer = threading.Thread(target=write)
        writer.start()
        try:
            self.assertTrue(written.wait(1), 'provider call held the memory state lock')
        finally:
            release.set()
            writer.join(2)
            worker.join(2)
        self.assertFalse(worker.is_alive())
        self.assertEqual([e['raw_ids'] for e in memory.episodes], [['a', 'b'], ['c']])
        self.assertIn('input during compression', memory.build_prompt({})[0])

    def test_changed_raw_rejects_in_flight_summary(self):
        events = []
        memory = Memory(self.root, event_sink=events.append)

        class Replacing(FakeTransport):
            def complete(self, **kwargs):
                memory.save_episode_raw('a', 'updated original')
                return super().complete(**kwargs)

        memory.transport = Replacing(['obsolete summary'])
        memory.save_episode_raw('a', 'original')
        memory.save_episode_raw('b', 'second')
        with self.assertLogs('memory', level='WARNING'):
            memory.merge_from_raw()
        self.assertEqual(events[-1]['type'], 'memory_merge_stale')
        memory.transport = FakeTransport(['updated summary'])
        memory.merge_from_raw()
        self.assertIn('updated original', memory.transport.sent[0]['messages'][0]['content'])
        self.assertEqual(memory.episodes[0]['text'], 'updated summary')

    def test_fact_edit_during_selection_cannot_restore_deleted_fact(self):
        memory = Memory(self.root)
        memory.apply_facts([{'op': 'ADD', 'fact': {'title': 'old%d' % i, 'text': 'x' * 800}}
                            for i in range(6)])
        memory.set_scene('next', [])

        class Editing(FakeTransport):
            def complete(self, **kwargs):
                memory.apply_facts([{'op': 'DELETE', 'id': 'f1'},
                                    {'op': 'ADD', 'fact': 'new fact during request'}])
                return super().complete(**kwargs)

        memory.transport = Editing(['f1'])
        memory._select_facts()
        text, _ = memory.build_prompt({})
        self.assertNotIn('old0', text)
        self.assertIn('new fact during request', text)
        self.assertNotEqual(memory._sel_done_epoch, memory._scene_epoch)

    def test_failed_selection_retains_facts_and_can_retry_same_scene(self):
        memory = Memory(self.root)
        memory.apply_facts([{'op': 'ADD', 'fact': {'title': 'old%d' % i, 'text': 'x' * 800}}
                            for i in range(6)])
        memory.set_scene('next', [])
        with mock.patch.object(llm, 'call', side_effect=OSError('temporary outage')):
            with self.assertLogs('memory', level='WARNING'):
                memory._select_facts()
        self.assertTrue(memory._facts_for_prompt())
        memory.transport = FakeTransport(['f6'])
        memory.select_facts_background().join(1)
        self.assertEqual([f['id'] for f in memory._facts_for_prompt()], ['f6'])


if __name__ == "__main__":
    unittest.main()
