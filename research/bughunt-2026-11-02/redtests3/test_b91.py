"""B91: a string-valued voice search is iterated one character at a time."""

import author


def test_string_search_is_passed_as_one_query():
    terms = []

    def search(term):
        terms.append(term)
        return []

    person = {"voice": {"search": "old man, cowboy"}}
    author.candidates(person, search)
    assert terms == ["old man, cowboy"], (
        f"expected one whole search query; actual calls were {terms!r}"
    )


def test_list_search_control_preserves_each_query():
    terms = []
    author.candidates({"voice": {"search": ["old man", "cowboy"]}},
                      lambda term: terms.append(term) or [])
    assert terms == ["old man", "cowboy"]
