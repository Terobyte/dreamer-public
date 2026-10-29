"""Offline stand-ins for Spark and the engine CLI.

Both keep the shape of the real thing (`Spark.ask`, `Engine.check_full`/`build`/
`shots`/`asset_keys`) and answer from a scenario, so a pipeline test never opens a
socket nor starts node.
"""

import json
import threading
from pathlib import Path

from pipe2.room import shot_filenames
from pipe2.spark import Answer, parse_scene

GREEN = {"code": 0, "errors": [], "warnings": []}


class FakeLedger:
    """Only the `record` half of `Ledger`: events a pipeline emits are inspectable."""

    def __init__(self):
        self.events = []

    def record(self, event):
        self.events.append(event)


class FakeSpark:
    """`answers[role]` is consumed one text per `ask`; an exhausted role answers
    nothing, which the caller must treat as an invalid answer."""

    def __init__(self, answers=None):
        self.answers = {role: list(texts) for role, texts in (answers or {}).items()}
        self.calls = []
        self.ledger = FakeLedger()

    def ask(self, role: str, room: str, round_no: int, messages: list, effort: str) -> Answer:
        self.calls.append({"role": role, "room": room, "round_no": round_no,
                           "messages": messages, "effort": effort})
        queue = self.answers.get(role) or []
        if not queue:
            return Answer(valid=False, error="no answer")
        text = queue.pop(0)
        answer = Answer(text=text, finish_reason="stop")
        try:
            answer.scene = parse_scene(text)
        except ValueError as exc:
            answer.error = str(exc)
        else:
            answer.valid = True
        return answer


class FakeEngine:
    """Reports come from the scenario in order (green once exhausted); `build` writes a
    stub page and `shots` a png per camera of the scene last built."""

    def __init__(self, reports=None, *, shots=False):
        self.reports = list(reports or [])
        self.checks = []
        self.builds = []
        self.n_shots = 0
        self.max_builds = 0
        self.max_shots = 0
        self.shot_cameras = []
        self._scenes = {}
        self._lock = threading.Lock()
        self._live_builds = 0
        self._live_shots = 0

    # -- checks ---------------------------------------------------------------

    def check(self, scene, work, built=None):
        return self._report(scene)

    def check_full(self, scene, work):
        return self._report(scene)

    def _report(self, scene):
        with self._lock:
            self.checks.append(scene)
            return self.reports.pop(0) if self.reports else dict(GREEN)

    # -- assets ---------------------------------------------------------------

    def asset_keys(self, scene):
        out = []
        for name, spec in (scene.get("assets") or {}).items():
            prompt = spec.get("prompt") or ""
            out.append({"id": name, "kind": spec.get("kind") or "object",
                        "key": "%s:%s" % (name, prompt), "prompt": prompt,
                        "size": spec.get("size")})
        return out

    # -- build ----------------------------------------------------------------

    def build(self, scene, out, assets, cache):
        with self._lock:
            self._live_builds += 1
            self.max_builds = max(self.max_builds, self._live_builds)
            self.builds.append({"out": str(out), "assets": assets,
                                "cache": None if cache is None else str(cache)})
            self._scenes[str(out)] = scene
        try:
            where = Path(out)
            where.mkdir(parents=True, exist_ok=True)
            (where / "index.html").write_text("<!-- fake build -->")
            (where / "scene.json").write_text(json.dumps(scene))
        finally:
            with self._lock:
                self._live_builds -= 1

    def shots(self, dist, size="960x720"):
        with self._lock:
            self._live_shots += 1
            self.max_shots = max(self.max_shots, self._live_shots)
            self.n_shots += 1
            scene = self._scenes.get(str(dist)) or {}
        try:
            cameras = [c.get("id") for c in scene.get("cameras") or [] if c.get("id")]
            where = Path(dist) / "shots"
            where.mkdir(parents=True, exist_ok=True)
            for name in shot_filenames(cameras):
                (where / name).write_bytes(b"\x89PNG fake")
            with self._lock:
                self.shot_cameras = cameras
        finally:
            with self._lock:
                self._live_shots -= 1
