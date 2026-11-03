# gate wiring: runs under tools/ptest.py (unittest) with cwd h0/dream
"""B92: the actor sanitizer damages allowed LOOK tags containing '='."""

import unittest
from inputs import sanitize


def check_look_tag_with_equals_is_kept_intact():
    source = "See [[LOOK: target=Alice]] here"
    actual = sanitize(source, "actor")
    expected = (source, [])
    assert actual == expected, f"expected {expected!r}; actual {actual!r}"


def check_look_tag_without_equals_control():
    source = "See [[LOOK:Alice]] here"
    assert sanitize(source, "actor") == (source, [])


class BughuntB92(unittest.TestCase):
    def test_look_tag_with_equals_is_kept_intact(self):
        check_look_tag_with_equals_is_kept_intact()

    def test_look_tag_without_equals_control(self):
        check_look_tag_without_equals_control()
