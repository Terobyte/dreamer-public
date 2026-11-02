"""B48: hero_line returns a repeated line when both attempts repeat."""
from dialogue import Dialogue
from fake import FakeTransport
from sim import START_SCENE, load_profile

WORLD = {"place": "Squidward's living room", "objects": list(START_SCENE["objects"]),
         "actors": ["Squidward"]}


def test_hero_line_rejects_line_that_repeats_on_both_attempts():
    t = FakeTransport(["[softly] Can we just stay quiet here a little longer?",
                       "[softly] Can we just stay quiet here a little longer?"])
    tr = [("SpongeBob", "[whispers] Can we just stay quiet here a little longer, please?")]
    line = Dialogue(load_profile("A"), transport=t).hero_line(WORLD, tr)
    assert t.calls == 2
    assert line is None, "expected None after two repeats, got forbidden line: %r" % (line and line["text"],)
