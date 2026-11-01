"""Asset cache filler: Muse Image -> SAM3D, one lifecycle per key, in parallel.

The engine builds with `--assets cache`, so all this has to do is drop
`<key>.png` / `<key>.glb` into the cache directory before `build`. Every asset
runs on its own thread: the object's picture is submitted to the mesh provider
the moment it exists, without waiting for the room's other pictures.

Nothing here waits without an upper bound. v1 waited for mesh files to appear
and hung forever when SAM3D returned an empty GLB; here an asset is finished
when its file is written, its provider refused, or `mesh_timeout_s` has passed
on the injected clock - and a finished-but-failed asset simply means the engine
builds that object with its own placeholder.
"""

from __future__ import annotations

import base64
import json
import os
import threading
import time
import urllib.request
import zlib
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Callable

MUSE_URL = "https://api.meta.ai/v1/images/generations"
MUSE_MODEL = "muse-image-1.0"
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def png_complete(data: bytes) -> bool:
    """Every chunk whole with a matching CRC, IHDR first and IEND last: a cut-off
    download still starts with the PNG magic, so the magic alone proves nothing."""
    if data[:8] != PNG_MAGIC:
        return False
    at, first, kind = 8, True, b""
    while at + 12 <= len(data):
        size = int.from_bytes(data[at:at + 4], "big")
        kind = data[at + 4:at + 8]
        end = at + 12 + size
        if end > len(data) or (first and kind != b"IHDR"):
            return False
        crc = int.from_bytes(data[end - 4:end], "big")
        if zlib.crc32(data[at + 4:end - 4]) != crc:
            return False
        at, first = end, False
        if kind == b"IEND":
            return at == len(data)
    return False


def as_png(data: bytes) -> bytes:
    """The engine reads `<key>.png` with pngjs, but Muse Image answers WebP (seen Oct 30): a WebP under a .png
    name makes `build` exit 2, every shot goes missing and every room stays red. Whole PNG bytes pass untouched;
    B39: a truncated PNG is refused instead of reaching the cache."""
    if data[:8] == PNG_MAGIC:
        if not png_complete(data):
            raise ValueError("truncated or corrupt PNG")
        return data
    import io

    from PIL import Image  # the one non-stdlib import: only live pictures need it

    out = io.BytesIO()
    Image.open(io.BytesIO(data)).save(out, "PNG")
    return out.getvalue()


class MuseImage:
    """Live `ImageProvider`. The key is read per call, never at import."""

    def __init__(self, url: str = MUSE_URL, model: str = MUSE_MODEL, timeout: float = 180):
        self.url = url
        self.model = model
        self.timeout = timeout

    def generate(self, prompt: str, size: str) -> bytes:
        body = json.dumps({"model": self.model, "prompt": prompt, "n": 1, "size": size}).encode()
        request = urllib.request.Request(self.url, body, {
            "Authorization": f"Bearer {os.environ['META_MODEL_API_KEY']}",
            "Content-Type": "application/json",
        })
        with urllib.request.urlopen(request, timeout=self.timeout) as answer:
            payload = json.load(answer)
        return as_png(base64.b64decode(payload["data"][0]["b64_json"]))


class ModalHandle:
    """A spawned mesh call. `get` raises TimeoutError while it is still running."""

    def __init__(self, call):
        self.call = call

    def get(self, timeout: float) -> dict:
        return self.call.get(timeout=timeout)


#: `--mesh` -> deployed (app, class); both take `run(name, png, with_ply)` (h0/trellis_modal.py, h0/sam3d_modal.py)
MESH_APPS = {"trellis": ("dreamer-trellis", "Trellis"), "sam3d": ("dreamer-sam3d", "Sam3D")}
#: seconds from submit to GLB, cold start included: a cold TRELLIS 1024 cascade loads 4B weights first
MESH_TIMEOUT_S = {"trellis": 600, "sam3d": 330}


class ModalMesh:
    """Live `MeshProvider`: one spawn per PNG on a deployed mesh class (TRELLIS.2 1024 by default)."""

    def __init__(self, app: str = "dreamer-trellis", cls: str = "Trellis"):
        self.app = app
        self.cls = cls
        self._remote = None

    def _run(self):
        if self._remote is None:
            import modal

            self._remote = modal.Cls.from_name(self.app, self.cls)().run
        return self._remote

    def submit(self, name: str, png: bytes):
        return ModalHandle(self._run().spawn(name, png, with_ply=False))


class _Asset:
    """One key's state: which room asked first, and whether it is finished."""

    def __init__(self, spec: dict, room: str):
        self.spec = spec
        self.room = room
        self.finished = threading.Event()


class AssetQueue:
    """Fills `cache` for the rooms that `put` their engine asset keys here.

    `put` returns at once; `done`/`wait` tell a room whether it may build.
    """

    def __init__(self, cache, images, meshes, ledger, *, mesh_timeout_s: float = 330,
                 poll_s: float = 2, clock: Callable[[], float] = time.time,
                 sleep: Callable[[float], None] = time.sleep, workers: int = 16):
        self.cache = Path(cache)
        self.cache.mkdir(parents=True, exist_ok=True)
        self.images = images
        self.meshes = meshes
        self.ledger = ledger
        self.mesh_timeout_s = mesh_timeout_s
        self.poll_s = poll_s
        self.clock = clock
        self.sleep = sleep
        self.closed = False
        self._pool = ThreadPoolExecutor(workers, thread_name_prefix="asset")
        self._lock = threading.RLock()
        self._assets: dict[str, _Asset] = {}
        self._rooms: dict[str, set[str]] = {}

    # -- queue ----------------------------------------------------------------

    def put(self, room: str, keys: list[dict]) -> None:
        """Queue a room's keys. Already cached keys and keys arriving after
        `close()` are not generated; late ones are reported as `asset_late`."""
        fresh = []
        with self._lock:
            mine = self._rooms.setdefault(room, set())
            for spec in keys:
                key = spec["key"]
                if self.closed:
                    self.ledger.record({"kind": "asset_late", "room": room, "asset": key})
                    continue
                if self._cached(spec):
                    continue
                mine.add(key)
                if key in self._assets:
                    continue
                asset = _Asset(spec, room)
                self._assets[key] = asset
                fresh.append(asset)
        for asset in fresh:
            self._pool.submit(self._run, asset)

    def done(self, room: str) -> bool:
        """True once every key this room asked for is written, failed or timed out."""
        with self._lock:
            assets = [self._assets[k] for k in self._rooms.get(room, ()) if k in self._assets]
        return all(a.finished.is_set() for a in assets)

    def wait(self, room: str) -> None:
        while not self.done(room):
            self.sleep(self.poll_s)

    def close(self) -> None:
        """No more keys will be accepted; assets already in flight still finish."""
        with self._lock:
            self.closed = True

    def idle(self) -> bool:
        with self._lock:
            assets = list(self._assets.values())
        return all(a.finished.is_set() for a in assets)

    # -- one asset ------------------------------------------------------------

    def _cached(self, spec: dict) -> bool:
        return self._output(spec).exists()

    def _output(self, spec: dict) -> Path:
        key = spec["key"]
        return self.cache / (f"{key}.glb" if spec["kind"] == "object" else f"{key}.png")

    def _write(self, name: str, blob: bytes) -> None:
        """Write through a temporary name: the engine must never see half a file."""
        temporary = self.cache / f".{name}.part"
        temporary.write_bytes(blob)
        temporary.replace(self.cache / name)

    def _failed(self, asset: _Asset, reason: str) -> None:
        self.ledger.record({"kind": "asset_failed", "room": asset.room,
                            "asset": asset.spec["key"], "reason": reason})

    def _run(self, asset: _Asset) -> None:
        try:
            png = self._picture(asset)
            if png is not None and asset.spec["kind"] == "object":
                self._mesh(asset, png)
        finally:
            asset.finished.set()

    def _picture(self, asset: _Asset) -> bytes | None:
        spec = asset.spec
        if spec["kind"] == "object":
            # B27: a resumed run whose mesh failed already paid for this picture
            src = self.cache / f"{spec['key']}.src.png"
            if src.exists():
                png = src.read_bytes()
                if png[:8] == PNG_MAGIC:
                    return png
        estimate = self.ledger.cost_of("image", 1)
        if not self.ledger.allow("image", estimate):
            self._failed(asset, "cap")
            return None
        try:
            png = self.images.generate(spec["prompt"], spec["size"])
        except Exception as problem:
            self.ledger.charge("image", 1, reserved=estimate)
            self._failed(asset, type(problem).__name__)
            return None
        self.ledger.charge("image", 1, reserved=estimate)
        key = spec["key"]
        try:
            self._write(f"{key}.src.png" if spec["kind"] == "object" else f"{key}.png", png)
        except OSError as problem:
            self._failed(asset, type(problem).__name__)
            return None
        return png

    def _mesh(self, asset: _Asset, png: bytes) -> None:
        """Submit, poll, and allow exactly one retry for a refusal or an empty GLB.
        A timeout is not retried: the budget for this asset is already spent."""
        key = asset.spec["key"]
        estimate = self.ledger.cost_of("h100_s", self.mesh_timeout_s)
        for attempt in (0, 1):
            if not self.ledger.allow("h100_s", estimate):
                self._failed(asset, "cap")
                return
            started = self.clock()
            try:
                handle = self.meshes.submit(key, png)
            except Exception as problem:
                self.ledger.charge("h100_s", self.mesh_timeout_s, reserved=estimate)
                if attempt:
                    self._failed(asset, type(problem).__name__)
                    return
                continue
            answer, reason = self._poll(handle, started)
            sec = answer.get("sec") if isinstance(answer, dict) else None
            units = sec if isinstance(sec, (int, float)) else self.mesh_timeout_s
            self.ledger.charge("h100_s", units, reserved=estimate)
            if reason is None:
                try:
                    self._write(f"{key}.glb", answer["glb"])
                except OSError as problem:
                    self._failed(asset, type(problem).__name__)
                return
            if reason == "timeout" or attempt:
                self._failed(asset, reason)
                return

    def _poll(self, handle, started: float) -> tuple[dict, str | None]:
        """`get` is only ever called with `timeout <= poll_s`, so a stuck provider
        cannot hold a thread past the deadline measured on our own clock."""
        while True:
            try:
                answer = handle.get(self.poll_s)
            except TimeoutError:
                if self.clock() - started >= self.mesh_timeout_s:
                    return {}, "timeout"
                self.sleep(self.poll_s)
                continue
            except Exception as problem:
                return {}, type(problem).__name__
            if not isinstance(answer, dict) or not answer.get("glb"):
                return answer if isinstance(answer, dict) else {}, "empty_glb"
            return answer, None
