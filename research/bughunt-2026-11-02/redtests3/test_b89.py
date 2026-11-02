"""B89: an empty but parseable casting reply skips the remaining attempt."""
import json

import author
from fake import FakeTransport


ID = "a" * 32


def _person(name):
    return {"name": name, "voice": {"sound": "warm", "search": ["warm voice"]}}


def _search(_term):
    return [{"id": ID, "title": "Warm", "about": "warm voice"}]


def _scene():
    return {"hero": _person("Rae"), "actors": [_person("Sol")]}


def test_empty_pick_reply_retries_and_uses_next_valid_reply():
    t = FakeTransport(["{}", json.dumps({"Rae": ID, "Sol": ID})])
    got = author.cast(_scene(), search=_search, transport=t)
    assert got == ({"Rae": ID}, "partial") and t.calls == 2, (
        f"expected second attempt to be used (2 calls), actual {got!r} after {t.calls} call(s)"
    )


def test_valid_pick_reply_control_does_not_need_retry():
    t = FakeTransport([json.dumps({"Rae": ID})])
    got = author.cast(_scene(), search=_search, transport=t)
    assert got == ({"Rae": ID}, "partial") and t.calls == 1
