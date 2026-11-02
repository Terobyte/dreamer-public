# gate wiring: runs under tools/ptest.py (unittest) with cwd h0/dream
import unittest
import pytest
from stage_director import validate_and_merge_staging


def test_nondict_model_output_does_not_crash():
    warnings = []
    caught = None
    result = None
    try:
        result = validate_and_merge_staging(
            123, ["p0"], ["Alice"], {"hall": {"room": "r", "poses": ["stand"]}},
            None, {}, warnings,
        )
    except TypeError as e:
        caught = e
    # Expected: non-dict output is rejected gracefully with a warning, no exception
    assert caught is None, f"raised TypeError instead of graceful handling: {caught}"
    assert result is not None
    assert result[0] == [] and result[1] == {}
    assert any("start" in w.lower() or "dict" in w.lower() or "invalid" in w.lower() or "ignored" in w.lower() for w in warnings), f"expected warning, got {warnings}"


class BughuntB22(unittest.TestCase):
    def test_b22(self):
        test_nondict_model_output_does_not_crash()
