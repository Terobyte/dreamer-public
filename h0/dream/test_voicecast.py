"""Voice casting by measured facts (voicecast.py, L177). Offline: fake judge, fake library, fake ears.
usage: cd h0/dream && python3 -m unittest -q test_voicecast
"""
import json
import os
import tempfile
import unittest

import ears
import voicecast as vc

H = "h" * 32
W = "w" * 32
N = "n" * 32
RU = "r" * 32
GIRL = "f" * 32
OLD = "0" * 32


def rd(p):
    with open(p) as f:
        return json.load(f)


def wr(p, d):
    with open(p, "w") as f:
        json.dump(d, f)


def facts(vid, sex="male", age=35, f0=120, pace=2.7, wer=0.0, ru=0.0, cy=0.0, uses=1000, langs=("en",)):
    lp = {l: 0.0 for l in ears.LANGS}
    lp.update({"en": 1.0, "ru": ru, "cy": cy, "es": 1e-4})
    ne, rs, cs = ears.shares(lp)
    return {"id": vid, "title": "voice " + vid[:2], "langs": list(langs), "tags": [], "uses": uses,
            "age": age, "sex": {"female": 1.0 if sex == "female" else 0.0, "male": 1.0 if sex == "male" else 0.0,
                                "child": 0.0},
            "f0": f0, "pace_wps": pace, "wer": wer, "lang_p": lp, "p_nonen": ne, "ru_share": rs, "cy_share": cs}


FAN = "c" * 32
LIB = {FAN: dict(facts(FAN, age=33, f0=120, cy=5e-3), title="franchise hero dub"), H: facts(H, age=32, f0=140, pace=3.1, cy=2e-3), W: facts(W, age=31, f0=112, cy=1e-3),
       N: facts(N, age=42, f0=103, pace=2.3, cy=3e-3), RU: facts(RU, age=40, f0=100, ru=4.6e-3),
       GIRL: facts(GIRL, sex="female", f0=220), OLD: facts(OLD, age=70, f0=73, pace=2.2)}


def judge(brief_by_name, pick=None):
    def call(role, system, user):
        if system == vc.BRIEF:
            for name, b in brief_by_name.items():
                if "Character: %s\n" % name in user:
                    return json.dumps(b)
        if system == vc.IP:
            return json.dumps({"flagged": [k for k, line in enumerate(user.split("\n")) if "franchise" in line]})
        return json.dumps(pick or {})
    return call


BRIEF = {"sex": "male", "age": 33, "accent": "British RP", "pitch": "mid", "pace": "fast", "texture": ["dry"],
         "search": ["british", "detective"]}


class Gates(unittest.TestCase):
    def test_measured_facts_reject_with_a_reason(self):
        self.assertIn("russian", vc.gate(BRIEF, LIB[RU]))
        self.assertEqual(vc.gate(BRIEF, LIB[GIRL]), "sex female")
        self.assertIn("age", vc.gate(BRIEF, LIB[OLD]))
        self.assertIn("wer", vc.gate(BRIEF, facts("x" * 32, wer=0.5)))
        self.assertIn("langs", vc.gate(BRIEF, facts("x" * 32, langs=("ru",))))
        self.assertIsNone(vc.gate(BRIEF, LIB[H]))

    def test_a_boy_may_sound_like_a_child(self):
        # John Reed, 14: the ears call "Boy" and "Teen" child, the sex gate kept only men of 20-30 (Jane Eyre run)
        boy = dict(BRIEF, age=14)
        kid = facts("k" * 32, sex="male", age=14, f0=230)
        kid["sex"] = {"female": 0.0, "male": 0.1, "child": 0.9}
        self.assertIsNone(vc.gate(boy, kid))
        self.assertEqual(vc.gate(BRIEF, kid), "sex child")          # a grown man is not a child's voice
        self.assertEqual(vc.gate(boy, dict(LIB[GIRL], title="girl voice")), "sex female")

    def test_a_boy_the_ears_call_female_is_kept(self):
        # John Reed design #6 (d2_s0): the ears said female 0.97, the user picked it by ear; a library
        # voice titled as a woman is still out
        boy = dict(BRIEF, age=14)
        unbroken = dict(facts("u" * 32, sex="female", age=34, f0=239, cy=3e-4))
        self.assertIsNone(vc.gate(boy, unbroken))
        self.assertEqual(vc.gate(boy, dict(unbroken, title="Young Woman Soft")), "sex female")
        self.assertEqual(vc.gate(BRIEF, unbroken), "sex female")             # a grown man is still not a woman
        self.assertEqual(vc.gate(dict(boy, sex="female"), facts("m" * 32)), "sex male")

    def test_a_boy_s_age_is_trusted_only_on_a_sure_man(self):
        # John Reed design run 2, row 3: ears "female 0.53, age 50", the user: "охуенный, не female"
        boy = dict(BRIEF, age=14, pitch="low")
        unsure = dict(facts("u" * 32, age=50, f0=165), sex={"female": 0.53, "male": 0.47, "child": 0.0})
        sure_man = dict(facts("m" * 32, age=50, f0=120), sex={"female": 0.01, "male": 0.98, "child": 0.0})
        self.assertIsNone(vc.gate(boy, unsure))
        self.assertIn("age", vc.gate(boy, sure_man))
        self.assertGreater(vc.score(boy, unsure), vc.score(boy, dict(unsure, age=20)) - 0.01)   # no age penalty
        self.assertIn("age", vc.gate(BRIEF, dict(unsure, sex=sure_man["sex"], age=70)))           # men: as before
        # on-demand run, row 5: "male 0.96, age 37" but f0 176 -- the user: "5 голос!"; the real men sat at 95-111 Hz
        light = dict(sure_man, age=37, f0=176)
        self.assertIsNone(vc.gate(boy, light))

    def test_a_child_s_gender_is_kept_by_title(self):
        # Wee Jamie, 8, Glasgow: "e girl" passed for a boy, a child brief had no sex gate
        kid = dict(facts("k" * 32, age=10, f0=290), sex={"female": 0.4, "male": 0.0, "child": 0.6})
        boy = dict(BRIEF, sex="child", gender="boy", age=8)
        self.assertEqual(vc.gate(boy, dict(kid, title="e girl ")), "a girl's voice by title")
        self.assertIsNone(vc.gate(boy, dict(kid, title="Energetic Child")))
        self.assertEqual(vc.gate(dict(boy, gender="girl"), dict(kid, title="Boy ")), "a boy's voice by title")

    def test_a_low_boy_is_low_for_a_child(self):
        # the brief said pitch "low" for John Reed, 14: f0 246 lost ~5 points to men at 115 Hz
        boy = dict(BRIEF, age=14, pitch="low", pace="medium")
        kid = dict(facts("k" * 32, age=13, f0=246, cy=2e-3), sex={"female": 0.0, "male": 0.1, "child": 0.9})
        man = facts("m" * 32, age=22, f0=115, cy=2e-3)
        self.assertGreater(vc.score(boy, kid), vc.score(boy, man))

    def test_a_noisy_sample_is_not_a_russian_accent(self):
        # ashley: p(ru) 4.6e-4 but ru is 3% of the non-English mass; gavrilov@ru: 8e-4 and 22%
        noisy = facts("n" * 32, ru=4.6e-4, cy=1e-2)
        self.assertIsNone(vc.gate(BRIEF, noisy))
        self.assertIn("russian", vc.gate(BRIEF, facts("g" * 32, ru=8e-4, cy=2e-3)))

    def test_a_british_voice_is_not_a_foreign_accent(self):
        # British English leaks into Welsh, not Russian: the old 1-p(en) gate threw these out
        brit = facts("b" * 32, cy=7.7e-3)
        self.assertIsNone(vc.gate(BRIEF, brit))
        self.assertGreater(vc.score(BRIEF, brit), vc.score(BRIEF, facts("a" * 32)))

    def test_shares_do_not_divide_by_a_rounded_english(self):
        ne, ru, cy = ears.shares({"en": 1.0, "ru": 1e-4, "cy": 3e-4})
        self.assertAlmostEqual(ne, 4e-4)
        self.assertEqual((ru, cy), (0.25, 0.75))


class Cast(unittest.TestCase):
    def run_cast(self, pick=None, pool=None):
        briefs = {"Holmes": BRIEF, "Watson": dict(BRIEF, age=31, pace="medium"),
                  "Narrator": dict(BRIEF, age=45, pace="slow", pitch="low")}
        lib = lambda term, n=12: [{"id": i} for i in (FAN, H, W, N, RU, GIRL)]
        people = [{"name": "Holmes", "look": "lean"}, {"name": "Watson", "look": "sturdy"},
                  {"name": "Narrator", "narrator": True}]
        return vc.cast_voices(people, "A Study in Scarlet", call=judge(briefs, pick), search=lib,
                              measure=lambda i: LIB[i], pool=pool if pool is not None else {}, log=lambda *_: None)

    def test_first_choices_are_distinct_even_when_the_judge_repeats_one(self):
        res = self.run_cast(pick={"Holmes": [N], "Watson": [N], "Narrator": [N]})
        firsts = [v["pick"][0] for v in res.values()]
        self.assertEqual(len(set(firsts)), 3)
        self.assertEqual(firsts[0], N)

    def test_a_book_keeps_its_briefs_across_runs(self):
        # the Glasgow narrator: "Scottish" on one run, "British RP" on the next, a different voice each time
        with tempfile.TemporaryDirectory() as d:
            bp = os.path.join(d, "briefs.json")
            lib = lambda term, n=12: [{"id": i} for i in (H, W, N)]
            people = [{"name": "Narrator", "narrator": True}]
            run = lambda accent: vc.cast_voices(people, "The Stair", call=judge({"Narrator": dict(BRIEF, accent=accent)}),
                                                search=lib, measure=lambda i: LIB[i], pool={}, log=lambda *_: None,
                                                briefs_path=bp)
            first, second = run("Scottish"), run("British RP")
            other = vc.cast_voices(people, "Another Book", call=judge({"Narrator": dict(BRIEF, accent="American")}),
                                   search=lib, measure=lambda i: LIB[i], pool={}, log=lambda *_: None, briefs_path=bp)
        self.assertEqual(first["Narrator"]["brief"]["accent"], "Scottish")
        self.assertEqual(second["Narrator"]["brief"]["accent"], "Scottish")
        self.assertEqual(other["Narrator"]["brief"]["accent"], "American")

    def test_a_voice_already_in_the_cast_is_not_picked_again(self):
        res = vc.distinct({"Murray": {"pick": [N, W], "ok": [{"id": N}, {"id": W}]}}, taken=[N])
        self.assertEqual(res["Murray"]["pick"][0], W)

    def test_a_franchise_title_is_rejected_whatever_the_judge_picks(self):
        res = self.run_cast(pick={"Holmes": [FAN]})
        row = {r["id"]: r for r in res["Holmes"]["rows"]}[FAN]
        self.assertIn("franchise", row["gate"])
        self.assertNotIn(FAN, res["Holmes"]["pick"])

    def test_rejected_never_picked(self):
        res = self.run_cast(pick={"Holmes": [RU, GIRL]})
        for v in res.values():
            self.assertFalse({RU, GIRL} & set(v["pick"]))
            self.assertTrue(any(r["id"] == RU and "russian" in r["gate"] for r in v["rows"]))

    def test_a_narrator_is_not_gated_by_age(self):
        res = self.run_cast(pool={"old_man": OLD})
        old = {r["id"]: r for r in res["Narrator"]["rows"]}[OLD]
        self.assertIsNone(old["gate"])
        self.assertIn("age", {r["id"]: r for r in res["Holmes"]["rows"]}[OLD]["gate"])

    def test_project_voices_are_candidates(self):
        res = self.run_cast(pool={"old_man": OLD, "gentle@ru": RU})
        rows = {r["id"]: r for r in res["Narrator"]["rows"]}
        self.assertEqual(rows[OLD]["label"], "old_man")
        self.assertNotIn("label", rows[RU])   # @ru labels are not English voices

    def test_listen_page(self):
        res = self.run_cast()
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "listen.html")
            vc.page(res, p, cache=d)
            with open(p) as f:
                s = f.read()
        self.assertIn("PICK 1", s)
        self.assertIn("russian accent", s)


class Apply(unittest.TestCase):
    def test_choice_lands_in_pool_cast_and_stage(self):
        res = Cast().run_cast(pool={})
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, "cast"))
            os.makedirs(os.path.join(d, "stage"))
            wr(os.path.join(d, "cast", "cast.json"), {"Holmes": {"voice": "ashley"}, "Watson": {"voice": "man"}})
            wr(os.path.join(d, "stage", "stage.json"), {"narrator_voice": "gentle"})
            pool_p = os.path.join(d, "voices.json")
            wr(pool_p, {"old_man": OLD, "man": "m" * 32})
            vc_load = vc.load_pool
            vc.load_pool = lambda path=pool_p: rd(pool_p)
            try:
                chosen = vc.choose(res, {"Watson": "2", "Narrator": "old_man"})
            finally:
                vc.load_pool = vc_load
            heard_p = os.path.join(d, "heard.json")
            labels = vc.apply(d, "A Study in Scarlet", chosen, pool_path=pool_p, heard_path=heard_p)
            ear = vc.heard("A Study in Scarlet", heard_p)
            pool = rd(pool_p)
            cast = rd(os.path.join(d, "cast", "cast.json"))
            stage = rd(os.path.join(d, "stage", "stage.json"))
        self.assertEqual(labels["Holmes"], "vc_a_study_in_scarlet_holmes")
        self.assertEqual(pool["vc_a_study_in_scarlet_holmes"], res["Holmes"]["pick"][0])
        self.assertEqual(labels["Narrator"], "old_man")          # a project voice keeps its label
        self.assertEqual(stage["narrator_voice"], "old_man")
        self.assertEqual(cast["Watson"]["voice"], labels["Watson"])
        self.assertEqual(pool[labels["Watson"]], res["Watson"]["pick"][1])
        self.assertEqual(ear, labels)                             # a choice by ear is remembered for re-casts

    def test_a_character_with_no_voice_is_left_out_not_fatal(self):
        # John Reed: no library voice passed, choose() raised and the whole cast fell back to sex/age labels
        res = Cast().run_cast()
        res["Holmes"]["pick"], res["Holmes"]["ok"] = [], []
        got = vc.choose(res)
        self.assertNotIn("Holmes", got)
        self.assertIn("Watson", got)

    def test_bad_choice_says_so(self):
        res = Cast().run_cast()
        with self.assertRaises(ValueError):
            vc.choose(res, {"Holmes": "nobody"})


if __name__ == "__main__":
    unittest.main()
