"""B75: the story stage adds cumulative Spark spend more than once."""
from types import SimpleNamespace

from make import story


def _director(monkeypatch, tmp_path):
    from pipe2 import spark as spark_mod

    class FakeSpark:
        def __init__(self, transport, ledger):
            self.ledger = ledger

        def ask(self, *args):
            self.ledger.spent += 0.25
            return SimpleNamespace(valid=True, scene={"stage": []})

    monkeypatch.setattr(spark_mod, "Spark", FakeSpark)
    ctx = SimpleNamespace(out=tmp_path, usd=0.0, spend=lambda amount: setattr(ctx, "usd", ctx.usd + amount))
    return story._spark_director(ctx), ctx


def test_director_spend_matches_actual_ledger_after_staging_and_tones(monkeypatch, tmp_path):
    director, ctx = _director(monkeypatch, tmp_path)
    director("staging")
    director("tones")
    assert ctx.usd == 0.5, f"expected story spend $0.50 for two calls, got ${ctx.usd:.2f}"


def test_single_director_call_is_accounted_once(monkeypatch, tmp_path):
    director, ctx = _director(monkeypatch, tmp_path)
    director("staging")
    assert ctx.usd == 0.25
