"""Wonder writes the whole opening scene (author.py, Oct 29): the scene, the casting,
and the shape sim.py --scene plays. Offline: a fake transport and a fake library.
usage: cd h0/dream && python3 -m unittest -q test_author
"""

import json
import unittest
from unittest import mock

import author
import sim
from fake import FakeTransport

IDS = {"a": "a" * 32, "b": "b" * 32, "c": "c" * 32, "d": "d" * 32}


def _person(name, search, fallback="man"):
    return {"name": name, "look": "a person in a coat",
            "voice": {"sound": "low and slow", "search": search, "fallback": fallback}}


def _scene(**over):
    d = {
        "question": "sell the farm or not",
        "place": "a farmhouse kitchen at night, 1931",
        "hero": dict(_person("Ruth", ["southern woman"], "woman"), soul={
            "diary": "Today the bank man came again.",
            "wants": ["keep the farm", "make her brother stay"],
            "fears": ["the bank", "being alone", "the shouting tonight"],
            "past_dream": "I dreamed the wheat was on fire.",
            "facts": [{"text": "her brother signed already", "hidden_from_hero": True},
                      {"text": "the loan is due Friday", "hidden_from_hero": False}]}),
        "situation_hero": "you are at the stove while the men argue behind you",
        "actors": [dict(_person("Abe", ["old man"], "old_man"),
                        persona="Wants to sell: the dust took three harvests."),
                   dict(_person("Cal", ["cowboy"]),
                        persona="Will not sell: his father is buried by the well.")],
        "events": [{"t": 0, "what": "Abe puts the bank letter on the table",
                    "who": "all", "kind": "world"},
                   {"t": 200, "what": "a truck stops outside", "who": "all", "kind": "world"},
                   {"t": 420, "what": "the lights go out", "who": "all", "kind": "world"}],
        "objects": ["stove", "table", "bank letter", "lamp", "window"],
    }
    d.update(over)
    return d


def _library(term):
    return {"southern woman": [{"id": IDS["a"], "title": "Southern", "about": "warm"}],
            "old man": [{"id": IDS["b"], "title": "Old man", "about": "raspy"}],
            "cowboy": [{"id": IDS["c"], "title": "Cowboy", "about": "gruff"},
                       {"id": IDS["d"], "title": "Cowboy 2", "about": "calm"}]}.get(term, [])


def _picks(**names):
    return json.dumps(names)


class AuthorTest(unittest.TestCase):

    def setUp(self):
        self.enterContext(mock.patch("urllib.request.urlopen",
                                     side_effect=AssertionError("network forbidden")))
        self.addCleanup(sim.use_scene, "start")

    def test_scene_and_casting_make_a_playable_scene(self):
        t = FakeTransport([json.dumps(_scene()),
                           _picks(Ruth=IDS["a"], Abe=IDS["b"], Cal=IDS["c"])])
        scene = author.author_scene("sell the farm", transport=t, search=_library)
        self.assertEqual(t.calls, 2)
        self.assertEqual(scene["hero"]["voice"], "cast_ruth")
        self.assertEqual([a["voice"] for a in scene["actors"]], ["cast_abe", "cast_cal"])
        self.assertEqual(scene["voice_ids"], {"cast_ruth": IDS["a"], "cast_abe": IDS["b"],
                                              "cast_cal": IDS["c"]})
        self.assertEqual(scene["author"]["craft"], author.CRAFT_VERSION)
        self.assertEqual(scene["author"]["cast"], "ok")
        # the method rides as the system prompt, the shape as the user turn
        self.assertEqual(t.sent[0]["system"], author.CRAFT)
        sim.use_scene(scene)
        self.assertEqual(sim.START_SCENE["actors"], ["Abe", "Cal"])
        self.assertEqual(sim.START_SCENE["events"][0]["who"], ["Ruth"])
        self.assertEqual(len(sim.START_SCENE["events"]), 4)
        self.assertEqual(sim.START_VOICE_IDS["cast_cal"], IDS["c"])
        prof = sim.load_profile(None)
        self.assertEqual(prof["hero"], "Ruth")
        self.assertEqual(prof["hero_voice"], "cast_ruth")
        self.assertEqual(prof["wants"], ["keep the farm", "make her brother stay"])

    def test_a_bad_pick_keeps_the_pool_voice(self):
        # Cal's id is not one of his candidates, Abe's repeats Ruth's: both fall back
        t = FakeTransport([json.dumps(_scene()),
                           _picks(Ruth=IDS["a"], Abe=IDS["a"], Cal="f" * 32)])
        scene = author.author_scene("sell the farm", transport=t, search=_library)
        self.assertEqual([a["voice"] for a in scene["actors"]], ["old_man", "man"])
        self.assertEqual(scene["voice_ids"], {"cast_ruth": IDS["a"]})
        self.assertEqual(scene["author"]["cast"], "partial")

    def test_a_broken_casting_reply_is_retried_then_noted(self):
        t = FakeTransport([json.dumps(_scene()), "", _picks(Ruth=IDS["a"])])
        scene = author.author_scene("x", transport=t, search=_library)
        self.assertEqual(t.calls, 3)
        self.assertEqual(scene["voice_ids"], {"cast_ruth": IDS["a"]})
        t = FakeTransport([json.dumps(_scene()), "", "nope"])
        scene = author.author_scene("x", transport=t, search=_library)
        self.assertEqual(scene["voice_ids"], {})
        self.assertTrue(scene["author"]["cast"].startswith("bad_reply"))

    def test_no_library_no_casting_call(self):
        t = FakeTransport([json.dumps(_scene())])
        scene = author.author_scene("sell the farm", transport=t, search=lambda term: [])
        self.assertEqual(t.calls, 1)
        self.assertEqual(scene["hero"]["voice"], "woman")
        self.assertEqual(scene["voice_ids"], {})
        self.assertEqual(scene["author"]["cast"], "no_candidates")

    def test_two_bad_scenes_then_none(self):
        bad = json.dumps(_scene(objects=["stove", "table"]))
        t = FakeTransport([bad, "not json", json.dumps(_scene())])
        self.assertIsNone(author.author_scene("x", transport=t, search=_library))
        self.assertEqual(t.calls, 2)

    def test_fenced_reply_is_read(self):
        t = FakeTransport(["```json\n" + json.dumps(_scene()) + "\n```", "{}"])
        self.assertIsNotNone(author.author_scene("x", transport=t, search=_library))

    def test_checks(self):
        ok = _scene()
        self.assertIsNone(author.check_authored(ok))
        no_soul = _scene()
        no_soul["hero"] = dict(no_soul["hero"])
        no_soul["hero"].pop("soul")
        cases = {
            "soul": no_soul,
            "cast": _scene(actors=ok["actors"][:1]),
            "names": _scene(actors=[ok["actors"][0], dict(ok["actors"][1], name="Abe")]),
            "persona": _scene(actors=[ok["actors"][0], dict(ok["actors"][1], persona="")]),
            "person": _scene(actors=[ok["actors"][0], dict(
                ok["actors"][1], voice={"search": [], "fallback": "robot"})]),
            "bad_size": _scene(events=ok["events"][:2]),
            "situation_hero": _scene(situation_hero=" "),
        }
        for want, d in cases.items():
            self.assertEqual(author.check_authored(d), want, want)

    def test_source_goes_into_the_ask(self):
        t = FakeTransport([json.dumps(_scene()), "{}"])
        author.author_scene("x", source="EXCERPT TEXT", transport=t, search=_library)
        self.assertIn("EXCERPT TEXT", t.sent[0]["messages"][0]["content"])

    def test_scene_voice_ids_take_only_real_ids(self):
        scene = author.to_scene(_scene(), {"Abe": IDS["b"]}, "x", "x", "partial")
        scene["voice_ids"]["cast_evil"] = "../../etc"
        sim.use_scene(scene)
        self.assertEqual(sim.START_VOICE_IDS, {"cast_abe": IDS["b"]})

    def test_fish_search_keeps_english_voices(self):
        class R:
            def __init__(self, body):
                self.body = body

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read(self):
                return self.body

        items = {"items": [
            {"_id": IDS["a"], "title": "A", "languages": ["en"], "description": "x"},
            {"_id": IDS["b"], "title": "B", "languages": ["es"]},
            {"_id": "bad", "title": "C", "languages": ["en"]}]}
        with mock.patch("urllib.request.urlopen",
                        return_value=R(json.dumps(items).encode())) as op:
            got = author.fish_search("old man")
        self.assertEqual([c["id"] for c in got], [IDS["a"]])
        self.assertNotIn("Authorization", op.call_args[0][0].headers)

    def test_craft_version(self):
        self.assertRegex(author.CRAFT_VERSION, r"^[0-9a-f]{8}$")


if __name__ == "__main__":
    unittest.main()
