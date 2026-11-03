# gate wiring: runs under tools/ptest.py (unittest) with cwd h0/dream
"""B83: the human book line drops the current beat's stage and delivery metadata."""
from contextlib import ExitStack
from unittest import mock

from bughunt_fix import make_sim


class _Case:
    def __init__(self):
        self.stack = ExitStack()

    def enterContext(self, context):
        return self.stack.enter_context(context)

    def addCleanup(self, fn, *args):
        self.stack.callback(fn, *args)


def _book_sim(beat):
    case = _Case()
    sim = make_sim(case)
    sim.hero_owner = "human"
    sim.book = {"beats": [beat], "cursor": 0, "wait_since": sim.clock.now(),
                "over": False, "scenes": [{"beats": [beat]}], "i": 0}
    return case, sim


def test_human_book_line_keeps_current_beat_metadata():
    beat = {"kind": "line", "who": "Hero", "text": "Come here.",
            "stage": [{"who": "Hero", "action": "goto", "place": "door"}],
            "gesture": "waves", "remarks": "warm", "shot": "close-up", "tone": "soft"}
    case, sim = _book_sim(beat)
    try:
        sent = []
        emitted = []
        with mock.patch.object(sim, "_start_line", side_effect=lambda line: sent.append(line) or {"type": "line"}), \
                mock.patch.object(sim, "_emit", side_effect=emitted.append):
            sim.human_say("Come here.")

        # Control: ordinary human book line still takes the expected playback path.
        assert sent[0]["text"] == "Come here."
        assert sent[0]["owner"] == "human"
        expected = {key: beat[key] for key in ("stage", "gesture", "remarks", "shot", "tone")}
        actual = {key: sent[0].get(key) for key in expected}
        stage_events = [event for event in emitted if event.get("type") == "stage"]
        expected_stage_events = [{"type": "stage", **item} for item in beat["stage"]]
        observed = {"line_metadata": actual, "stage_events": stage_events}
        expected_observed = {"line_metadata": expected, "stage_events": expected_stage_events}
        assert observed == expected_observed, (
            f"expected beat metadata and stage events {expected_observed!r}; actual {observed!r}")
    finally:
        case.stack.close()


def test_human_book_line_without_metadata_remains_supported():
    case, sim = _book_sim({"kind": "line", "who": "Hero", "text": "Hello."})
    try:
        sent = []
        with mock.patch.object(sim, "_start_line", side_effect=lambda line: sent.append(line) or {"type": "line"}):
            sim.human_say("Hello.")
        assert sent[0]["text"] == "Hello."
        assert sent[0]["beat"] == 0
    finally:
        case.stack.close()


from bughunt_fix import as_testcase  # noqa: E402

B83 = as_testcase(globals(), "B83")
