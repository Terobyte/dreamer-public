import json
import pytest
from types import SimpleNamespace
import pipe2.floor as floor_mod
from pipe2.test_bughunt_b15 import FakeLedger, FakeAssets, FakeEngine


class BadWarmth:
    def start(self):
        pass

    def close(self):
        raise RuntimeError("modal api timeout")


def test_warmth_close_failure_marks_run_failed(tmp_path, monkeypatch):
    ledger = FakeLedger()
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    assets = FakeAssets()
    assets.cache = tmp_path / "cache"
    deps = {"spark": object(), "engine": FakeEngine(), "assets": assets, "ledger": ledger,
            "warmth": BadWarmth(), "sleep": lambda s: None}
    fl = floor_mod.Floor(task_dir=tmp_path, run_dir=run_dir, deps=deps)
    monkeypatch.setattr(floor_mod.Floor, "_architect", lambda self: ({"rooms": []}, {}, [], True))
    monkeypatch.setattr(floor_mod.Floor, "_build_rooms", lambda self, rids, ctx: {})
    monkeypatch.setattr(floor_mod.Floor, "_post_defects", lambda self, *a, **k: [])
    monkeypatch.setattr(floor_mod.Floor, "_final_shots", lambda self, *a, **k: {})
    monkeypatch.setattr(floor_mod, "RoomStore", lambda rd: object())
    monkeypatch.setattr(floor_mod, "Ctx", lambda **kw: SimpleNamespace(**kw))
    monkeypatch.setattr(floor_mod, "repair_seams",
                        lambda ctx, partials: SimpleNamespace(partials={}, rounds=0, rolled_back=[]))
    monkeypatch.setattr(floor_mod, "degrade", lambda *a, **k: ({"props": []}, []))
    monkeypatch.setattr(floor_mod, "attach_refs", lambda scene, plan, d, warnings=None: scene)

    result = fl.run()

    assert any(e.get("kind") == "warmth_close_failed" for e in result.final_errors)
    assert result.status == "failed", f"expected status 'failed' after warmth close error, got {result.status!r}"
