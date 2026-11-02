"""Critic partial acceptance: one retry, then drop the offending decals, then roll back."""

import json
import unittest

from pipe2.test_room import GREEN, RoomCase, answer, partial


def decal(did, x=1.0):
    return {"id": did, "room": "A", "on": {"room": "A", "wall": 0}, "asset": "A_t",
            "at": [x, 1.5], "size": [0.5, 0.5]}


def with_decals(*decals, prompt="oak planks"):
    out = partial(prompt=prompt)
    out["decals"] = list(decals)
    return out


def red(code, path):
    return {"code": 1, "errors": [{"code": code, "path": path, "id": "x"}], "warnings": []}


def events(ctx):
    ledger = getattr(ctx.spark, "ledger", None)
    return ledger


class TestCriticPartial(RoomCase):
    def ctx_with_events(self, answers, reports):
        ctx = self.ctx(answers, reports=reports)
        self.events = []

        class L:
            def record(_self, event):
                self.events.append(event)

        ctx.spark.ledger = L()
        return ctx

    def kinds(self):
        return [e["kind"] for e in self.events]

    def run_room(self, ctx):
        from pipe2.room import RoomPipeline
        return RoomPipeline("A", ctx).run()

    # reports: builder check, layout critic checks..., assets critic checks...
    def test_retry_fixes_overlap(self):
        base = with_decals(decal("A_d1"))
        bad = with_decals(decal("A_d1"), decal("A_dUNIQUE", 2.0), prompt="oak planks")
        fixed = with_decals(decal("A_d1"), decal("A_dUNIQUE", 3.0))
        ctx = self.ctx_with_events(
            {"builder": [answer(base)], "critic_layout": [answer(base)],
             "critic_assets": [answer(bad), answer(fixed)]},
            [GREEN, GREEN, red("DECAL_OVERLAP", "/decals/1"), GREEN])
        result = self.run_room(ctx)
        self.assertEqual("green", result.status)
        self.assertEqual(fixed["decals"], result.partial["decals"])
        self.assertIn("critic_retry", self.kinds())
        self.assertNotIn("critic_rejected", self.kinds())
        self.assertEqual(2, len(self.asked("critic_assets")))

    def test_retry_message_has_rejected_partial_and_findings(self):
        import re
        base = with_decals(decal("A_d1"))
        bad = with_decals(decal("A_d1"), decal("A_dUNIQUE", 2.0))
        both = {"code": 1, "warnings": [], "errors": [
            {"code": "DECAL_OVERLAP", "path": "/decals/1", "id": "x"},
            {"code": "DECAL_OFF_WALL", "path": "/decals/0/at", "id": "y"}]}
        ctx = self.ctx_with_events(
            {"builder": [answer(base)], "critic_layout": [answer(base)],
             "critic_assets": [answer(bad), answer(bad)]},
            [GREEN, GREEN, both, GREEN])
        self.run_room(ctx)
        retry = self.asked("critic_assets")[1]
        body = self.texts(retry)
        m = re.search(r"```json\n(.*?)\n```", body, re.S)
        self.assertIsNotNone(m, "PARTIAL block not found")
        partial_text = m.group(1)
        self.assertIn("A_dUNIQUE", partial_text, "retry PARTIAL must be rejected candidate")
        first = self.texts(self.asked("critic_assets")[0])
        m0 = re.search(r"```json\n(.*?)\n```", first, re.S)
        self.assertIsNotNone(m0)
        self.assertNotIn("A_dUNIQUE", m0.group(1))
        self.assertIn("DECAL_OVERLAP", body)
        self.assertIn("/decals/1", body)
        self.assertIn("DECAL_OFF_WALL", body)
        self.assertIn("/decals/0/at", body)
        tail = body.split("Your previous answer was refused")[1] if "Your previous answer was refused" in body else body
        paras = [p.strip() for p in tail.split("\n\n") if p.strip()]
        overlap_paras = [p for p in paras if "DECAL_OVERLAP" in p and "/decals/1" in p]
        offwall_paras = [p for p in paras if "DECAL_OFF_WALL" in p and "/decals/0/at" in p]
        self.assertEqual(1, len(overlap_paras))
        self.assertEqual(1, len(offwall_paras))
        self.assertNotEqual(overlap_paras[0], offwall_paras[0], "each finding must be its own paragraph")

    def test_second_overlap_drops_decal(self):
        base = with_decals(decal("A_d1"))
        bad = with_decals(decal("A_d1"), decal("A_dUNIQUE", 2.0))
        ctx = self.ctx_with_events(
            {"builder": [answer(base)], "critic_layout": [answer(base)],
             "critic_assets": [answer(bad), answer(bad)]},
            [GREEN, GREEN, red("DECAL_OVERLAP", "/decals/1"),
             red("DECAL_OVERLAP", "/decals/1"), GREEN])
        result = self.run_room(ctx)
        self.assertEqual("green", result.status)
        self.assertEqual([d["id"] for d in base["decals"]],
                         [d["id"] for d in result.partial["decals"]])
        self.assertIn("critic_dropped", self.kinds())
        dropped = [e for e in self.events if e["kind"] == "critic_dropped"][0]
        self.assertEqual(["/decals/1"], dropped["paths"])
        self.assertNotIn("critic_rejected", self.kinds())

    def test_other_code_rolls_back(self):
        base = with_decals(decal("A_d1"))
        bad = with_decals(decal("A_d1"), decal("A_dUNIQUE", 2.0))
        ctx = self.ctx_with_events(
            {"builder": [answer(base)], "critic_layout": [answer(base)],
             "critic_assets": [answer(bad), answer(bad)]},
            [GREEN, GREEN, red("PROP_HITS_WALL", "/props/0"),
             red("PROP_HITS_WALL", "/props/0")])
        result = self.run_room(ctx)
        self.assertEqual("rolled_back", result.status)
        self.assertIn("critic_rejected", self.kinds())
        self.assertNotIn("critic_dropped", self.kinds())

    def test_overlap_with_skeleton_decal_rolls_back(self):
        base = with_decals(decal("A_d1"))
        bad = with_decals(decal("A_d1"))
        ctx = self.ctx_with_events(
            {"builder": [answer(base)], "critic_layout": [answer(base)],
             "critic_assets": [answer(bad), answer(bad)]},
            [GREEN, GREEN, red("DECAL_OVERLAP", "/decals/0"),
             red("DECAL_OVERLAP", "/decals/0")])
        # make the skeleton own decal 0 so the finding points outside the critic's fragment
        ctx.skeleton["decals"] = [{"id": "S_dec", "room": "A", "on": {"room": "A", "wall": 1},
                                   "asset": "A_t", "at": [1, 1], "size": [0.5, 0.5]}]
        result = self.run_room(ctx)
        self.assertEqual("rolled_back", result.status)
        self.assertIn("critic_rejected", self.kinds())
        self.assertNotIn("critic_dropped", self.kinds())

    def test_mixed_after_retry_rolls_back(self):
        base = with_decals(decal("A_d1"))
        bad = with_decals(decal("A_d1"), decal("A_dUNIQUE", 2.0))
        both = {"code": 1, "warnings": [], "errors": [
            {"code": "DECAL_OVERLAP", "path": "/decals/1", "id": "x"},
            {"code": "PROP_HITS_WALL", "path": "/props/0", "id": "A_sofa"}]}
        ctx = self.ctx_with_events(
            {"builder": [answer(base)], "critic_layout": [answer(base)],
             "critic_assets": [answer(bad), answer(bad)]},
            [GREEN, GREEN, red("DECAL_OVERLAP", "/decals/1"), both])
        result = self.run_room(ctx)
        self.assertEqual("rolled_back", result.status)
        self.assertIn("critic_rejected", self.kinds())
        self.assertNotIn("critic_dropped", self.kinds())

    def test_off_wall_with_subpath_is_dropped(self):
        base = with_decals(decal("A_d1"))
        bad = with_decals(decal("A_d1"), decal("A_dUNIQUE", 2.0))
        ctx = self.ctx_with_events(
            {"builder": [answer(base)], "critic_layout": [answer(base)],
             "critic_assets": [answer(bad), answer(bad)]},
            [GREEN, GREEN, red("DECAL_OFF_WALL", "/decals/1/at"),
             red("DECAL_OFF_WALL", "/decals/1/at"), GREEN])
        result = self.run_room(ctx)
        self.assertEqual("green", result.status)
        self.assertEqual(["A_d1"], [d["id"] for d in result.partial["decals"]])
        self.assertIn("critic_dropped", self.kinds())

    def test_deep_path_does_not_drop(self):
        base = with_decals(decal("A_d1"))
        bad = with_decals(decal("A_d1"), decal("A_dUNIQUE", 2.0))
        ctx = self.ctx_with_events(
            {"builder": [answer(base)], "critic_layout": [answer(base)],
             "critic_assets": [answer(bad), answer(bad)]},
            [GREEN, GREEN, red("DECAL_OVERLAP", "/decals/1/at/deeper"),
             red("DECAL_OVERLAP", "/decals/1/at/deeper")])
        result = self.run_room(ctx)
        self.assertEqual("rolled_back", result.status)
        self.assertIn("critic_rejected", self.kinds())
        self.assertNotIn("critic_dropped", self.kinds())


if __name__ == "__main__":
    unittest.main()
