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

    def asset_keys(self, scene, scene_dir=None):
        import base64
        import hashlib

        out = []
        for name, spec in (scene.get("assets") or {}).items():
            prompt = spec.get("prompt") or ""
            row: dict = {"id": name, "kind": spec.get("kind") or "object",
                         "key": "%s:%s" % (name, prompt), "prompt": prompt,
                         "size": spec.get("size")}
            ref = spec.get("ref") if isinstance(spec, dict) else None
            if ((spec.get("kind") or "object") == "object" and isinstance(ref, dict)
                    and scene_dir is not None and isinstance(ref.get("image"), str)
                    and isinstance(ref.get("what"), str)):
                rel = Path(ref["image"])
                if rel.is_absolute():
                    continue
                try:
                    # `..` that normalizes back inside is fine; only a resolved
                    # path leaving the scene folder skips the frame
                    inside = (Path(scene_dir) / rel).resolve().is_relative_to(Path(scene_dir).resolve())
                except OSError:
                    continue
                if inside:
                    src = Path(scene_dir) / rel
                    try:
                        raw = src.read_bytes() if src.is_file() else None
                    except OSError:
                        raw = None
                    if raw is not None:
                        # тот же ключ, что считает движок (cacheKey в engine/src/assets/cache.ts
                        # через keys.ts): promptFor без имени ассета, затем |ref|sha256(байтов)|what|mode
                        framed = ("single object, front view facing the camera, whole object, "
                                  "plain white background, no shadow. %s" % prompt)
                        mode = ref.get("mode") if isinstance(ref.get("mode"), str) else None
                        mode = "redraw" if mode == "redraw" else "mask"
                        subject = "%s|ref|%s|%s|%s" % (framed, hashlib.sha256(raw).hexdigest(), ref["what"], mode)
                        row["key"] = hashlib.sha256(subject.encode()).hexdigest()
                        row["ref"] = {"bytes": base64.b64encode(raw).decode(), "what": ref["what"], "mode": mode}
            out.append(row)
        return out

    # -- build ----------------------------------------------------------------

    def build(self, scene, out, assets, cache, scene_dir=None):
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


class FailedImages:
    def generate(self, prompt, size):
        raise RuntimeError('offline image provider')


class FailedMeshes:
    def submit(self, name, png):
        raise RuntimeError('offline mesh provider')


class FakeSegmenter:
    """Stand-in for SAM 3 (`SEG_APP`): remembers the frame and `what`; `fail` by what: error | empty."""

    def __init__(self, fail=None):
        self.fail = dict(fail or {})
        self.calls = []

    def mask(self, png, what):
        self.calls.append({"png": bytes(png), "what": what})
        mode = self.fail.get(what)
        if mode == "error":
            raise RuntimeError("fake SAM 3 app is down")
        if mode == "empty":
            from pipe2.assets import MaskEmpty

            raise MaskEmpty(what)
        return b"mask:" + what.encode()


class _FakeHandle:
    def __init__(self, call):
        self.call = call

    def get(self, timeout):
        return self.call()


class FakeSam3D:
    """Stand-in for `Sam3D.run(name, png, with_ply, mask=None)`: remembers the mask it got."""

    def __init__(self, fail=False, pose=None):
        self.fail = fail
        self.pose = pose
        self.calls = []

    def run(self, name, png, with_ply=True, mask=None):
        self.calls.append({"name": name, "png": bytes(png), "mask": mask})
        if self.fail:
            raise RuntimeError("fake SAM3D failed")
        return {"name": name, "glb": b"glb", "ply": b"", "sec": 1.0, "baked": True, "pose": self.pose}

    def handle(self, name, png, mask=None):
        return _FakeHandle(lambda: self.run(name, png, False, mask))


class FakeSceneMeshes:
    """Fake `MeshProvider` with the mask path: segmenter first, then SAM3D with `mask=`."""

    def __init__(self, segmenter=None, sam3d=None):
        self.segmenter = segmenter or FakeSegmenter()
        self.sam3d = sam3d or FakeSam3D()

    def submit(self, name, png):
        return self.sam3d.handle(name, png)

    def from_scene(self, name, frame, what):
        mask = self.segmenter.mask(frame, what)
        return self.sam3d.handle(name, frame, mask)


class FakeAutoscaler:
    def __init__(self):
        self.calls = []

    def set(self, min_containers, buffer_containers, scaledown_window):
        self.calls.append((min_containers, buffer_containers, scaledown_window))


def synthetic_task():
    """Two connected empty rooms; generated entirely here, never from hidden runs."""
    skeleton = {
        'version': 0, 'name': 'offline-two-rooms', 'levels': [{'id': 'L0', 'y': 0}],
        'rooms': [{'id': rid, 'level': 'L0', 'height': 3,
                   'shape': [[x, 0], [x + 4, 0], [x + 4, 4], [x, 4]],
                   'floor': 'grey', 'ceiling': 'white',
                   'walls': {'material': 'white', 'thickness': .12}}
                  for rid, x in [('A', 0), ('B', 4)]],
        'openings': [{'id': 'door', 'kind': 'door', 'at': [4, 2], 'width': .9, 'height': 2.1, 'sill': 0}],
        'spawn': {'room': 'A', 'at': [1, 1], 'yaw': 0}, 'style': {'ambient': 1},
        'materials': {'grey': {'color': '#888888'}, 'white': {'color': '#eeeeee'}},
        'assets': {}, 'props': [], 'stairs': [], 'routes': [],
    }
    plan = {'rooms': {r: {'refs': [], 'max_points': 2, 'cues': ''} for r in ('A', 'B')},
            'openings': {'door': {'owner': 'A'}}}
    return skeleton, plan


class ScenarioSpark:
    """Deterministic offline replies using the real ledger and token-cap code."""
    def __init__(self, ledger):
        self.ledger = ledger
        self.calls = []

    def ask(self, role, room, round_no, messages, effort):
        from pipe2.spark import Spark
        self.calls.append((role, room))
        if role in ('architect', 'architect_fix'):
            skeleton, plan = synthetic_task()
            scene = {'skeleton': skeleton, 'plan': plan}
        else:
            x = 0 if room == 'A' else 4
            scene = {'props': [{'id': room + '_table', 'room': room, 'asset': room + '_wood',
                                'cat': 'table', 'at': [x + 2, 2], 'size': {'w': .6, 'd': .6, 'h': .7},
                                'yaw': 0, 'mount': 'floor', 'solid': True}],
                     'assets': {room + '_wood': {'kind': 'object', 'prompt': 'small wooden table'}}}
        class Transport:
            def post(self, body, timeout):
                return {'choices': [{'message': {'content': json.dumps(scene)}, 'finish_reason': 'stop'}],
                        'usage': {'prompt_tokens': 100, 'completion_tokens': 100}}
        return Spark(Transport(), self.ledger).ask(role, room, round_no, messages, effort)
