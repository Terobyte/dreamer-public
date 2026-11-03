# gate wiring: runs under tools/ptest.py (unittest) with cwd h0/dream
"""B91: a string-valued voice search is iterated one character at a time."""

import unittest
import author


def check_string_search_is_passed_as_one_query():
    terms = []

    def search(term):
        terms.append(term)
        return []

    person = {"voice": {"search": "old man, cowboy"}}
    author.candidates(person, search)
    assert terms == ["old man, cowboy"], (
        f"expected one whole search query; actual calls were {terms!r}"
    )


def check_list_search_control_preserves_each_query():
    terms = []
    author.candidates({"voice": {"search": ["old man", "cowboy"]}},
                      lambda term: terms.append(term) or [])
    assert terms == ["old man", "cowboy"]


class BughuntB91(unittest.TestCase):
    def test_string_search_is_passed_as_one_query(self):
        check_string_search_is_passed_as_one_query()

    def test_list_search_control_preserves_each_query(self):
        check_list_search_control_preserves_each_query()
