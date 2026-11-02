import json
from types import SimpleNamespace

import pipe2.floor as floor_mod


class FakeLedger:
    path = None
    capped = False

    def __init__(self):
        self.events = []

    @property
    def spent(self):
        return sum(float(e.get("cost_usd") or 0.0) for e in self.events)


class FakeWarmth:
    """Like GpuWarmth: the h100_s charge lands in the ledger at close()."""
    def __init__(self, ledger, cost):
        self.ledger, self.cost = ledger, cost

    def start(self):
        pass

    def close(self):
        self.ledger.events.append({"kind": "h100_s", "cost_usd": self.cost})


class FakeAssets:
    mesh_timeout_s = 0
    poll_s = 0
    cache = None

    def put(self, *a, **k):
        pass

    def close(self):
        pass

    def idle(self):
        return True


class FakeEngine:
    def asset_keys(self, *a, **k):
        return {}

    def build(self, *a, **k):
        pass


def test_warmth_cost_included_in_result_and_report(tmp_path, monkeypatch):
    ledger = FakeLedger()
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    assets = FakeAssets()
    assets.cache = tmp_path / "cache"
    deps = {"spark": object(), "engine": FakeEngine(), "assets": assets, "ledger": ledger,
            "warmth": FakeWarmth(ledger, 5.0), "sleep": lambda s: None}
    fl = floor_mod.Floor(task_dir=tmp_path, run_dir=run_dir, deps=deps)

    # stub only the heavy collaborators; Floor.run / _run / _report_fields / _finish / _write_report are real
    monkeypatch.setattr(floor_mod.Floor, "_architect", lambda self: ({"rooms": []}, {}, [], True))
    monkeypatch.setattr(floor_mod.Floor, "_build_rooms", lambda self, rids, ctx: {})
    monkeypatch.setattr(floor_mod.Floor, "_post_defects", lambda self, *a, **k: [])
    monkeypatch.setattr(floor_mod.Floor, "_final_shots", lambda self, *a, **k: {})
    monkeypatch.setattr(floor_mod, "RoomStore", lambda rd: object())
    monkeypatch.setattr(floor_mod, "Ctx", lambda **kw: SimpleNamespace(**kw))
    monkeypatch.setattr(floor_mod, "repair_seams",
                        lambda ctx, partials: SimpleNamespace(partials={}, rounds=0, rolled_back=[]))
    monkeypatch.setattr(floor_mod, "degrade", lambda *a, **k: ({"props": []}, []))
    monkeypatch.setattr(floor_mod, "attach_refs", lambda scene, plan, d: scene)

    result = fl.run()

    # expected: GPU-warm cost (5.0) is in the ledger by the time the report is written
    report = json.loads((run_dir / "report.json").read_text())
    assert ledger.spent == 5.0
    assert result.total_usd == 5.0, f"total_usd lost warmth cost: {result.total_usd}"
    assert report["total_usd"] == 5.0, f"report.json lost warmth cost: {report['total_usd']}"
