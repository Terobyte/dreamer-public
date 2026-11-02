from types import SimpleNamespace

import pytest

import pipe2.floor as floor_mod


class FakeLedger:
    path = None
    capped = False
    spent = 0.0
    events = []


class FakeAssets:
    """Queue stand-in: meshes finish at the given fake-clock times."""
    mesh_timeout_s = 330
    poll_s = 2
    cache = None

    def __init__(self, now, finish_times):
        self.now = now
        self.finish_times = finish_times

    def put(self, *a, **k):
        pass

    def close(self):
        pass

    def finished(self):
        return sum(1 for t in self.finish_times if self.now[0] >= t)

    def idle(self):
        # stalled queue: no finish times at all -> never idle
        return bool(self.finish_times) and self.finished() == len(self.finish_times)


class FakeEngine:
    def __init__(self, now):
        self.now = now
        self.build_at = []

    def asset_keys(self, *a, **k):
        return {}

    def build(self, *a, **k):
        self.build_at.append(self.now[0])


def _run_floor(tmp_path, monkeypatch, finish_times):
    now = [0.0]
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    assets = FakeAssets(now, finish_times)
    assets.cache = tmp_path / "cache"
    engine = FakeEngine(now)

    def sleep(s):
        now[0] += s

    deps = {"spark": object(), "engine": engine, "assets": assets, "ledger": FakeLedger(),
            "clock": lambda: now[0], "sleep": sleep}
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

    fl.run()
    return now, engine


def test_floor_queue_waits_for_idle_per_mesh_not_total_timeout(tmp_path, monkeypatch):
    # two meshes finish at t=200 and t=400: each within its own 330 s budget, 400 s in total
    now, engine = _run_floor(tmp_path, monkeypatch, [200.0, 400.0])
    assert len(engine.build_at) == 1
    assert engine.build_at[0] >= 400.0, (
        f"build started at t={engine.build_at[0]} while the queue was still busy (idle at 400)")


def test_floor_queue_stall_gives_up_after_mesh_timeout(tmp_path, monkeypatch):
    # nothing ever finishes and the queue is never idle: bounded wait of ~330 s of no progress
    now, engine = _run_floor(tmp_path, monkeypatch, [])
    assert len(engine.build_at) == 1, "build must still run after a stalled wait"
    assert 330.0 <= engine.build_at[0] <= 340.0, f"stall wait not bounded: t={engine.build_at[0]}"
