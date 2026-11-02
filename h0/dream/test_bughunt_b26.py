# gate wiring: runs under tools/ptest.py (unittest) with cwd h0/dream
import unittest
import threading
import dialogue as dlg


class TrackedLock:
    def __init__(self):
        self._lock = threading.Lock()
        self.depth = 0

    def acquire(self, *a, **k):
        r = self._lock.acquire(*a, **k)
        if r:
            self.depth += 1
        return r

    def release(self):
        self.depth -= 1
        return self._lock.release()

    def __enter__(self):
        self.acquire()
        return self

    def __exit__(self, *exc):
        self.release()
        return False


def _make_dialogue():
    d = dlg.Dialogue.__new__(dlg.Dialogue)
    d._mind_lock = TrackedLock()
    d._mind_threads = []
    d.background = False
    d.on_memory = None
    d.hero = "Hero"
    d.n_actors = 1
    d.scene_mind = dlg.Mind()
    d.minds = {}
    d.log = []
    # stub llm call used by _fold
    d._call = lambda role, system, user: "SO FAR: x\nKNOWS: y"
    return d


def test_fold_mutates_mind_under_lock():
    d = _make_dialogue()
    m = dlg.Mind()
    lines = [("A", "hello"), ("B", "world")]
    m.cursor = 0

    seen_depth = {}

    orig_update = m.update

    def checked_update(reply, lines=None, actors=(), names=None):
        # record lock depth at the moment memory is mutated
        seen_depth["depth"] = d._mind_lock.depth
        return orig_update(reply, lines=lines, actors=actors, names=names)

    m.update = checked_update.__get__(m, type(m)) if hasattr(checked_update, "__get__") else checked_update
    # ensure instance attribute shadows class method
    import types
    m.update = types.MethodType(lambda self_, reply, lines=None, actors=(), names=None: (
        seen_depth.__setitem__("depth", d._mind_lock.depth),
        orig_update(reply, lines=lines, actors=actors, names=names),
    )[1], m)

    d._fold("SomeActor", m, lines, 2, None)

    assert "depth" in seen_depth, "m.update was never called"
    assert seen_depth["depth"] >= 1, (
        "m.update() mutated Mind without holding _mind_lock "
        f"(depth={seen_depth['depth']})"
    )


class BughuntB26(unittest.TestCase):
    def test_b26(self):
        test_fold_mutates_mind_under_lock()
