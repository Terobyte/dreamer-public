"""B94: _ab_order should accept numeric pair identifiers."""

from types import SimpleNamespace

import server


def test_ab_order_accepts_numeric_pair_id():
    handler = SimpleNamespace(viewer=SimpleNamespace(ab_salt="test-salt"))
    runs = {"bank/run_1": "v1", "bank/run_2": "v2"}

    # Control: the same runs work when the pair id is a string.
    control = server.ViewerHandler._ab_order(handler, {"id": "pair-1", "runs": runs})
    assert len(control) == 2 and set(control) == set(runs)

    pair = {"id": 1, "runs": runs}
    try:
        actual = server.ViewerHandler._ab_order(handler, pair)
    except Exception as exc:
        actual = f"{type(exc).__name__}: {exc}"

    assert isinstance(actual, list) and len(actual) == 2 and set(actual) == set(runs), (
        f"expected randomized ordering of {sorted(runs)!r}; actual {actual!r}"
    )
