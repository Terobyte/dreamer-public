"""B75: the story stage must account Spark spend once (ledger.spent is cumulative)."""
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from make import story


class DirectorSpend(unittest.TestCase):
    def _director(self, tmp_path):
        from pipe2 import spark as spark_mod

        class FakeSpark:
            def __init__(self, transport, ledger):
                self.ledger = ledger

            def ask(self, *args):
                self.ledger.spent += 0.25
                return SimpleNamespace(valid=True, scene={"stage": []})

        patch = mock.patch.object(spark_mod, "Spark", FakeSpark)
        patch.start()
        self.addCleanup(patch.stop)
        ctx = SimpleNamespace(out=tmp_path, usd=0.0, spend=lambda amount: setattr(ctx, "usd", ctx.usd + amount))
        return story._spark_director(ctx), ctx

    def test_director_spend_matches_actual_ledger_after_staging_and_tones(self):
        with tempfile.TemporaryDirectory() as t:
            director, ctx = self._director(Path(t))
            director("staging")
            director("tones")
            self.assertAlmostEqual(ctx.usd, 0.5)

    def test_single_director_call_is_accounted_once(self):
        with tempfile.TemporaryDirectory() as t:
            director, ctx = self._director(Path(t))
            director("staging")
            self.assertAlmostEqual(ctx.usd, 0.25)


if __name__ == "__main__":
    unittest.main()
