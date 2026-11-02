"""B92: the actor sanitizer damages allowed LOOK tags containing '='."""

from inputs import sanitize


def test_look_tag_with_equals_is_kept_intact():
    source = "See [[LOOK: target=Alice]] here"
    actual = sanitize(source, "actor")
    expected = (source, [])
    assert actual == expected, f"expected {expected!r}; actual {actual!r}"


def test_look_tag_without_equals_control():
    source = "See [[LOOK:Alice]] here"
    assert sanitize(source, "actor") == (source, [])
