"""The dreamer CLI behind a Python interface: check, build, shots, asset keys.

Every call runs in its own temporary directory, so rooms can be checked in
parallel, and reports are memoised per scene: the same scene is never checked
twice. The engine tree itself is read-only here.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import threading
from pathlib import Path
from typing import Callable

from pipe2.merge import merge

#: a warning the engine never fails the run on, but a room must not ship with
#: (engine/src/report/codes.ts:44)
BLOCKING_WARNINGS = ("NAV_ROOM_CUT",)

KEYS_TS = Path(__file__).resolve().parent / "keys.ts"


class EngineError(RuntimeError):
    """The CLI failed as a program: a usage error or a crash, not findings."""

    def __init__(self, code: int, raw: str):
        super().__init__(f"dreamer exited with {code}:\n{raw}")
        self.code = code
        self.raw = raw


def blocking(report: dict) -> list[dict]:
    """Findings a room may not ship with: errors plus NAV_ROOM_CUT."""
    warnings = [w for w in report.get("warnings") or [] if w.get("code") in BLOCKING_WARNINGS]
    return list(report.get("errors") or []) + warnings


def green(report: dict) -> bool:
    return report.get("code") == 0 and not blocking(report)


def scene_for_room(skeleton: dict, partials: dict, plan: dict, room: str) -> dict:
    """The scene a single room is checked against: skeleton + that room only."""
    scene, _violations = merge(skeleton, {room: partials.get(room) or {}}, plan)
    return scene


def _scene_hash(scene: dict) -> str:
    return hashlib.sha256(json.dumps(scene, sort_keys=True).encode("utf-8")).hexdigest()


class _Inflight:
    """One running CLI call others wait on: the first thread owns the run."""

    def __init__(self):
        self._done = threading.Event()
        self.report = None
        self.error = None

    def finish(self, report, error) -> None:
        self.report = report
        self.error = error
        self._done.set()

    def result(self):
        self._done.wait()
        if self.error is not None:
            raise self.error
        return self.report


class Engine:
    def __init__(self, engine_dir: str | os.PathLike, *, shots: bool = True):
        self.engine_dir = Path(engine_dir)
        self._want_shots = shots
        self._lock = threading.Lock()
        self._reports: dict[tuple, dict] = {}
        # one in-flight CLI run per cache key: latecomers wait on it and
        # share its report instead of starting a second run
        self._inflight: dict[tuple, _Inflight] = {}

    # --- the CLI ---------------------------------------------------------

    def _run(self, args: list[str]) -> subprocess.CompletedProcess:
        return subprocess.run(
            ["node", "--import", "tsx", "bin/dreamer.ts", *args],
            cwd=self.engine_dir,
            capture_output=True,
            text=True,
        )

    def _room(self, work: str | os.PathLike) -> Path:
        """A private directory for one CLI call: never next to the engine."""
        Path(work).mkdir(parents=True, exist_ok=True)
        return Path(tempfile.mkdtemp(dir=str(work)))

    @staticmethod
    def _write_scene(where: Path, scene: dict) -> Path:
        path = where / "room.scene.json"
        path.write_text(json.dumps(scene), encoding="utf-8")
        return path

    def _report_of(self, done: subprocess.CompletedProcess, report_path: Path) -> dict:
        raw = (done.stdout or "") + (done.stderr or "")
        if done.returncode == 2 or not report_path.exists():
            raise EngineError(done.returncode or 2, raw)
        data = json.loads(report_path.read_text(encoding="utf-8"))
        return {
            "code": done.returncode,
            "errors": list(data.get("errors") or []),
            "warnings": list(data.get("warnings") or []),
            "raw": raw,
        }

    # --- the interface ---------------------------------------------------

    def check(self, scene: dict, work: str | os.PathLike, built: str | os.PathLike | None = None) -> dict:
        key = ("check", _scene_hash(scene), str(built) if built is not None else None)
        return self._once(key, lambda: self._check_uncached(scene, work, built))

    def _check_uncached(self, scene: dict, work: str | os.PathLike, built: str | os.PathLike | None) -> dict:
        here = self._room(work)
        try:
            scene_path = self._write_scene(here, scene)
            report_path = here / "report.json"
            args = ["check", str(scene_path), "--report", str(report_path)]
            if built is not None:
                args += ["--built", str(built)]
            return self._report_of(self._run(args), report_path)
        finally:
            shutil.rmtree(here, ignore_errors=True)

    def _once(self, key: tuple, run: Callable) -> dict:
        """Run once per key: cache hit returns at once, concurrent calls share."""
        with self._lock:
            hit = self._reports.get(key)
            if hit is not None:
                return hit
            mine = self._inflight.get(key)
            if mine is None:
                mine = self._inflight[key] = _Inflight()
                owner = True
            else:
                owner = False
        if not owner:
            return mine.result()
        try:
            report = run()
        except BaseException as exc:
            with self._lock:
                del self._inflight[key]
            mine.finish(None, exc)
            raise
        with self._lock:
            report = self._reports.setdefault(key, report)
            del self._inflight[key]
        mine.finish(report, None)
        return report

    def check_full(self, scene: dict, work: str | os.PathLike) -> dict:
        """`check`, and if the scene builds at all, `check --built` on its dist."""
        return self._once(("full", _scene_hash(scene)), lambda: self._check_full_uncached(scene, work))

    def _check_full_uncached(self, scene: dict, work: str | os.PathLike) -> dict:
        report = self.check(scene, work)
        if report["code"] == 0:
            here = self._room(work)
            dist = here / "dist"
            try:
                self.build(scene, dist, "none", None)
                # `check --built` wants a picture per camera (SHOT_MISSING is an error since engine block E):
                # shoot first, or, when this engine does not shoot, the missing pictures are not the scene's fault
                if self._want_shots:
                    shots_retry(self, dist)
                report = self.check(scene, work, built=dist)
            finally:
                shutil.rmtree(here, ignore_errors=True)
            if not self._want_shots:
                errors = [e for e in report["errors"] if e.get("code") != "SHOT_MISSING"]
                report = {**report, "errors": errors, "code": report["code"] if errors else 0}
        return report

    @staticmethod
    def _stage_scene(scene: dict, scene_dir: str | os.PathLike | None) -> Path:
        """A temp folder holding the scene plus its `refs/*`: the CLI resolves
        `ref.image` against the scene file, so frames copied next to another
        folder (attach_refs under run_dir) must travel with it."""
        here = Path(tempfile.mkdtemp())
        scene_path = Engine._write_scene(here, scene)
        if scene_dir is not None:
            root = Path(scene_dir)
            try:
                anchor = root.resolve()
            except OSError:
                anchor = None
            for spec in (scene.get("assets") or {}).values():
                if not isinstance(spec, dict):
                    continue
                ref = spec.get("ref")
                if not isinstance(ref, dict) or not isinstance(ref.get("image"), str):
                    continue
                rel = Path(ref["image"])
                if rel.is_absolute() or anchor is None:
                    continue
                try:
                    # `..` that normalizes back inside is fine; only a resolved
                    # path leaving the scene folder (a symlink escape, say) skips
                    inside = (root / rel).resolve().is_relative_to(anchor)
                except OSError:
                    continue
                if not inside:
                    continue
                try:
                    src_is_file = (root / rel).is_file()
                except OSError:
                    continue
                if not src_is_file:
                    continue
                dst = here / rel
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(root / rel, dst)
        return scene_path

    def build(self, scene: dict, out: str | os.PathLike, assets: str, cache: str | os.PathLike | None,
              scene_dir: str | os.PathLike | None = None) -> None:
        scene_path = self._stage_scene(scene, scene_dir)
        try:
            args = ["build", str(scene_path), "--out", str(out), "--assets", assets]
            if cache is not None:
                args += ["--cache", str(cache)]
            done = self._run(args)
        finally:
            shutil.rmtree(scene_path.parent, ignore_errors=True)
        if done.returncode != 0:
            raise EngineError(done.returncode, (done.stdout or "") + (done.stderr or ""))

    def shots(self, dist: str | os.PathLike, size: str = "960x720") -> None:
        if not self._want_shots:
            return
        done = self._run(["shots", str(dist), "--size", size])
        if done.returncode != 0:
            raise EngineError(done.returncode, (done.stdout or "") + (done.stderr or ""))

    def asset_keys(self, scene: dict, scene_dir: str | os.PathLike | None = None) -> list[dict]:
        """`{id, kind, key, prompt, size[, ref]}` per referenced asset, from the engine.

        With `scene_dir`, `ref.image` files are staged next to the temp scene so
        `keys.ts` folds the frame bytes into the key, exactly as the build will."""
        scene_path = self._stage_scene(scene, scene_dir)
        try:
            done = subprocess.run(
                ["node", "--import", "tsx", str(KEYS_TS), str(scene_path)],
                cwd=self.engine_dir,
                capture_output=True,
                text=True,
            )
        finally:
            shutil.rmtree(scene_path.parent, ignore_errors=True)
        if done.returncode != 0:
            raise EngineError(done.returncode, (done.stdout or "") + (done.stderr or ""))
        return json.loads(done.stdout)


class Gated:
    """Same interface, but `build` and `shots` share `n` slots: they eat the box."""

    def __init__(self, engine, n: int = 2):
        self.engine = engine
        self._slots = threading.Semaphore(n)

    def check(self, scene, work, built=None):
        return self.engine.check(scene, work, built)

    def check_full(self, scene, work):
        # check_full builds internally too; share the same heavy-work slots.
        with self._slots:
            return self.engine.check_full(scene, work)

    def asset_keys(self, scene, scene_dir=None):
        if scene_dir is None:
            return self.engine.asset_keys(scene)
        return self.engine.asset_keys(scene, scene_dir)

    def build(self, scene, out, assets, cache, scene_dir=None):
        with self._slots:
            if scene_dir is None:
                return self.engine.build(scene, out, assets, cache)
            return self.engine.build(scene, out, assets, cache, scene_dir)

    def shots(self, dist, size="960x720"):
        with self._slots:
            return self.engine.shots(dist, size)


def shots_retry(engine, dist, size="960x720"):
    """One retry for a CLI usage/runtime failure; leave failure reporting to caller."""
    for attempt in range(2):
        try:
            return engine.shots(dist, size)
        except EngineError as exc:
            if exc.code != 2 or attempt:
                raise
