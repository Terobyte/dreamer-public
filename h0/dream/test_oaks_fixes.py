"""Fixes after the Twelve Oaks A/B (specs/dialogue-fixes-2026-10-30.md): a cast of
full names is still addressed by a first or last name, people-words are not
invented names, a played director note leaves the prompt, a loop is caught on
spoken words, and the author has a second method (r2) beside the default one.
usage: cd h0/dream && python3 -m unittest -q test_oaks_fixes
"""

import json
import os
import unittest

import author
import dialogue
import sim as sim_mod
from dialogue import ADDRESS_HOLD, lock_line, loop_items, loops_in, names_in
from fake import FakeTransport
from test_author import _scene

HERE = os.path.dirname(os.path.abspath(__file__))
CAST = ["Ashley Wilkes", "Rhett Butler", "Gerald O'Hara", "Charles Hamilton", "Scarlett O'Hara"]
OAKS = ["brandy decanter", "cigars", "Atlanta newspaper", "green velvet curtains",
        "library door", "riding crop", "china fan", "oil lamp"]


def _bare_sim(hero, actors):
    """A Sim with only the pressure state: enough for _note_line and the notes."""
    s = sim_mod.Sim.__new__(sim_mod.Sim)
    s.hero, s.actors = hero, list(actors)
    s._spoke_last = None
    s._silent_ticks, s._addressed, s._event_hits, s._said_count = {}, {}, {}, {}
    s._actor_streak = 0
    s._notes, s._notes_seen, s._notes_shown = {}, {}, {}
    return s


class NamesIn(unittest.TestCase):
    def test_part_of_a_full_name_addresses(self):
        self.assertEqual(names_in("Ashley, stop talkin' war and come out here!", CAST),
                         {"Ashley Wilkes"})
        self.assertEqual(names_in("Mr Butler, hush.", CAST), {"Rhett Butler"})
        self.assertEqual(names_in("Ashley Wilkes!", CAST), {"Ashley Wilkes"})
        self.assertEqual(names_in("CHARLES, sit down", CAST), {"Charles Hamilton"})

    def test_a_shared_part_names_nobody(self):
        self.assertEqual(names_in("the O'Hara girl is listening", CAST), set())
        self.assertEqual(names_in("Scarlett O'Hara, come in", CAST), {"Scarlett O'Hara"})

    def test_short_parts_and_substrings_do_not_count(self):
        cast = ["Al Gore", "Dan"]
        self.assertEqual(names_in("Al, wait", cast), set())      # 2 letters
        self.assertEqual(names_in("Danny boy", cast), set())     # not a whole word
        self.assertEqual(names_in("Dan, wait", cast), {"Dan"})

    def test_note_line_marks_the_addressed(self):
        s = _bare_sim("Scarlett O'Hara", CAST[:4])
        s._note_line("Scarlett O'Hara", "hero", "Ashley, stop talkin' war and come out here!")
        self.assertEqual(s._addressed, {"Ashley Wilkes": ADDRESS_HOLD})
        s._note_line("Ashley Wilkes", "actor", "Gentlemen, the North has factories.")
        self.assertEqual(s._addressed, {})
        # the speaker's own name does not address him; a whisper still limits the ears
        s._note_line("Gerald O'Hara", "actor", "Charles, Ashley, Rhett -- to supper!",
                     only=["Charles Hamilton"])
        self.assertEqual(s._addressed, {"Charles Hamilton": ADDRESS_HOLD})


class PeopleWords(unittest.TestCase):
    def test_nations_and_sides_pass_the_lock(self):
        for text in ("[loud] Factories be damned, one Georgian whips twelve Yankee clerks!",
                     "[loud] One Southerner on horseback's worth a dozen Yankee clerks!",
                     "[flat] Those Yankees and their Northern mills.",
                     "[flat] Every Confederate, Irish, English or French man here."):
            self.assertEqual(lock_line(text, OAKS, ["Gerald O'Hara"]), (text, None), text)

    def test_an_invented_name_is_still_refused(self):
        self.assertEqual(lock_line("[flat] Ask Tom about it.", OAKS, ["Gerald O'Hara"]),
                         (None, "name"))


class PlayedNotes(unittest.TestCase):
    def test_a_played_note_leaves_the_prompt(self):
        s = _bare_sim("Max", ["Dan"])
        s._notes["Dan"] = ["ask for a light"]
        self.assertEqual(s._notes_for("Dan"), ["ask for a light"])
        s._note_line("Dan", "actor", "Got a light?")
        self.assertEqual(s._notes_for("Dan"), [])
        # the history itself stays (the safety soft note is counted there)
        self.assertEqual(s._notes["Dan"], ["ask for a light"])

    def test_two_notes_before_a_line_give_only_the_last(self):
        s = _bare_sim("Max", ["Dan"])
        s._notes["Dan"] = ["first", "second"]
        self.assertEqual(s._notes_for("Dan"), ["second"])

    def test_actor_system_shows_one_note(self):
        d = dialogue.Dialogue.__new__(dialogue.Dialogue)
        d.hero = "Max"
        text = d.actor_system("Dan", {"place": "a roof"}, ["first", "second"])
        self.assertIn("- second", text)
        self.assertNotIn("first", text)

    def test_a_note_that_lands_during_the_line_is_kept(self):
        s = _bare_sim("Max", ["Dan"])
        s._notes["Dan"] = ["first"]
        s._notes_shown["Dan"] = 1          # the prompt in flight saw one note
        s._notes["Dan"].append("second")   # the director adds one meanwhile
        s._note_line("Dan", "actor", "Got a light?")
        self.assertEqual(s._notes_for("Dan"), ["second"])

    def test_a_hero_line_plays_no_actor_note(self):
        s = _bare_sim("Max", ["Dan"])
        s._notes["Dan"] = ["n"]
        s._note_line("Max", "hero", "hi")
        self.assertEqual(s._notes_for("Dan"), ["n"])


class SpokenLoops(unittest.TestCase):
    GERALD = ["[blustering, loud] Fort Sumter fallen! Atlanta cries war! [scoff] Come lads "
              "-- no Wilkes guest out-volunteers O'Hara neighbours!",
              "[booming loudly] Atlanta says Sumter fallen! [pause] War come at last! To "
              "supper now! No Wilkes guest out-volunteers my hospitality!",
              "[booming jovially] Sumter's fallen! Drink, lads, drink [pause] to Georgia! "
              "Charles, Ashley, Rhett -- to supper! That's three already!"]
    ASHLEY = ["[quietly measured] Gentlemen, the North has factories. [pause] We have cotton.",
              "[quietly even] Gentlemen, we have cotton -- they have factories, railroads and ships.",
              "[quietly even] Gentlemen, the North has foundries -- [pause] we have fields.",
              "[quietly tired] Go on to supper, gentlemen [pause] I need a moment here."]

    def test_a_repeated_spoken_word_is_a_loop(self):
        sets = [loop_items(t, OAKS, CAST, spoken=True) for t in self.GERALD]
        self.assertEqual(loops_in(sets), {"sumter", "fallen"})
        sets = [loop_items(t, OAKS, CAST, spoken=True) for t in self.ASHLEY]
        self.assertEqual(loops_in(sets), {"gentlemen"})

    def test_names_short_and_common_words_are_not_items(self):
        items = loop_items("[flat] Ashley, there is nothing we could do about it.", OAKS, CAST, spoken=True)
        self.assertEqual(items, set())
        items = loop_items("[flat] Factories be damned!", OAKS, CAST, spoken=True)
        self.assertEqual(items, {"factories", "damned"})

    def test_objects_and_remarks_as_before(self):
        self.assertEqual(loop_items("[flat] I hold the brandy decanter. [taps the lamp]", OAKS),
                         {"brandy decanter", "oil lamp", "taps"})


class CraftR2(unittest.TestCase):
    def test_default_prompt_is_unchanged(self):
        t = FakeTransport([json.dumps(_scene())])
        author.write_scene("sell the farm", transport=t)
        self.assertEqual(t.sent[0]["system"], author.CRAFT)

    def test_r2_rides_as_the_system_prompt_and_is_recorded(self):
        t = FakeTransport([json.dumps(_scene())])
        d = author.write_scene("sell the farm", transport=t, craft="r2")
        system = t.sent[0]["system"]
        self.assertEqual(system, author.load_craft("r2"))
        self.assertNotEqual(system, author.CRAFT)
        for word in ("one person", "the obstacle, not the centre", "word for word"):
            self.assertIn(word, system, word)
        scene = author.to_scene(d, {}, "sell the farm", "s", "ok", craft="r2")
        self.assertEqual(scene["author"]["craft"], author.craft_version("r2"))
        self.assertEqual(scene["author"]["craft_file"], "scene_writing_r2.md")
        self.assertNotEqual(scene["author"]["craft"], author.CRAFT_VERSION)

    def test_unknown_craft_is_an_error(self):
        with self.assertRaises(FileNotFoundError):
            author.load_craft("r9")


if __name__ == "__main__":
    unittest.main()
