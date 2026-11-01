"""Floor stage: an architect call builds the skeleton+plan once; every room then builds
in parallel. A skeleton that cannot pass checks within the fix-round limit stops the run
before any builder starts. A floor-owned finding seen only after builders have started is
reported, never sent back to the architect: the skeleton is frozen the moment they start.
"""

import base64
import json
import math
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field
from pathlib import Path

from pipe2.blame import SKELETON, blame_global
from pipe2.engine import EngineError, Gated, blocking, green
from pipe2.geom import in_room
from pipe2.merge import merge
from pipe2.room import Ctx, RoomPipeline, RoomResult, RoomStore, engine_spec
from pipe2.spark import Answer
from pipe2.seams import repair_seams
from pipe2.degrade import degrade

HERE = Path(__file__).parent
PROMPTS = HERE / "prompts"
REPO = HERE.parent.parent

MAX_ARCHITECT_FIX_ROUNDS = 2
ROOM_ID_RE = re.compile(r"^[A-Za-z0-9-]+$")


@dataclass
class FloorResult:
    status: str
    rooms: dict = field(default_factory=dict)
    skeleton_defects: list = field(default_factory=list)
    rounds: int = 0
    timeline: list = field(default_factory=list)
    total_usd: float = 0.0
    stopped_by_cap: bool = False
    reason: str = ""
    removed: list = field(default_factory=list)
    seam_rounds: int = 0
    rolled_back: list = field(default_factory=list)
    sheets: dict = field(default_factory=dict)
    final_errors: list = field(default_factory=list)


def _contains(room: dict, x: float, z: float) -> bool:
    """`in_room` that never raises: malformed geometry is the engine's to report."""
    try:
        return bool(in_room(room, x, z))
    except (TypeError, ValueError, KeyError, AttributeError):
        return False


def _is_num(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _on_circle(cx: float, cz: float, radius: float, az) -> tuple:
    """Point at spec angle `az` (degrees, 0 = +Z, 90 = +X) on a circle."""
    rad = math.radians(float(az))
    return (cx + radius * math.sin(rad), cz + radius * math.cos(rad))


def _edge_center(room: dict, edge, pos: dict):
    """Center point of an `on` opening on the named room's edge, or None when the
    spec or the edge geometry is malformed (the engine reports that instead) or uses the circle-only `az` form."""
    if not isinstance(edge, int) or isinstance(edge, bool):
        return None
    circle = room.get("circle") if isinstance(room, dict) else None
    if isinstance(circle, dict) and edge == 0 and _is_num(pos.get("az")):
        try:
            return _on_circle(float(circle["c"][0]), float(circle["c"][1]), float(circle["r"]), pos["az"])
        except (TypeError, ValueError, KeyError, IndexError):
            return None
    shape = room.get("shape") if isinstance(room, dict) else None
    if not isinstance(shape, list) or not 0 <= edge < len(shape):
        return None
    try:
        ax, az = float(shape[edge][0]), float(shape[edge][1])
        nxt = shape[(edge + 1) % len(shape)]
        bx, bz = float(nxt[0]), float(nxt[1])
    except (TypeError, ValueError, IndexError):
        return None
    length = math.hypot(bx - ax, bz - az)
    if length <= 0:
        return (ax, az)
    bulge = shape[edge][2].get("bulge", 0) if len(shape[edge]) > 2 else 0
    if not isinstance(bulge, (int, float)) or not math.isfinite(bulge):
        return None
    if bulge:
        pts = [(float(v[0]), float(v[1])) for v in shape]
        area = sum(x * zz - xx * z for (x, z), (xx, zz) in zip(pts, pts[1:] + pts[:1]))
        sign = 1 if area >= 0 else -1
        sag = bulge * length / 2
        radius_signed = ((length / 2) ** 2 + sag ** 2) / (2 * sag)
        radius = abs(radius_signed)
        ux, uz = sign * (bz - az) / length, -sign * (bx - ax) / length
        mx, mz = (ax + bx) / 2, (az + bz) / 2
        ox, oz = mx + ux * (sag - radius_signed), mz + uz * (sag - radius_signed)
        a0 = math.atan2(az - oz, ax - ox)
        span = (math.atan2(bz - oz, bx - ox) - a0) % math.tau
        apex = (math.atan2(mz + uz * sag - oz, mx + ux * sag - ox) - a0) % math.tau
        sweep = span if apex <= span else span - math.tau
        length = radius * abs(sweep)
    if bulge and _is_num(pos.get("az")):
        return _on_circle(ox, oz, radius, pos["az"])
    if isinstance(pos.get("t"), (int, float)) and not isinstance(pos.get("t"), bool):
        frac = float(pos["t"])
    elif isinstance(pos.get("m"), (int, float)) and not isinstance(pos.get("m"), bool):
        frac = float(pos["m"]) / length
    else:
        return None
    if bulge:
        return (ox + radius * math.cos(a0 + sweep * frac),
                oz + radius * math.sin(a0 + sweep * frac))
    return (ax + frac * (bx - ax), az + frac * (bz - az))


def _opening_rooms(opening: dict, rooms: dict) -> list:
    """Rooms the opening can plausibly connect, in skeleton order.

    `at` openings touch every room whose footprint contains the point. `on`
    openings ride one room's edge, which may be a wall shared with a neighbour
    (the engine joins both sides of the interval), so the candidates are the
    named room plus every room containing the edge point."""
    on = opening.get("on")
    if isinstance(on, dict):
        rooms_on = on.get("rooms")
        if isinstance(rooms_on, list):
            hit = [r for r in rooms_on if isinstance(r, str) and r in rooms]
            if hit:
                return hit
        named = on.get("room")
        if not isinstance(named, str) or named not in rooms:
            return []
        point = _edge_center(rooms[named], on.get("edge"), on)
        if point is None:
            return [named]
        return [rid for rid, room in rooms.items()
                if rid == named or _contains(room, point[0], point[1])]
    at = opening.get("at")
    if (isinstance(at, (list, tuple)) and len(at) >= 2
            and isinstance(at[0], (int, float)) and isinstance(at[1], (int, float))):
        return [rid for rid, room in rooms.items()
                if _contains(room, float(at[0]), float(at[1]))]
    return []


def skeleton_defects(skeleton, plan) -> list:
    """Code-side checks on the architect's answer: well-formed scene and plan
    objects, room ids matching the builder's prefix shape, a plan entry per
    room, and exactly one cosmetic owner per opening - one of the (at most
    two) rooms the opening connects."""
    if not isinstance(skeleton, dict) or not isinstance(plan, dict):
        return [{"msg": "architect answer must hold two json objects"}]
    defects = []
    for section in ("props", "decals", "cameras", "fixtures"):
        if skeleton.get(section):
            defects.append({"msg": "skeleton must not contain builder objects", "section": section})
    lights = skeleton.get("lights", [])
    if not isinstance(lights, list):
        defects.append({"msg": "skeleton lights must be a list"})
    elif any(isinstance(light, dict) and light.get("kind") != "hemi" for light in lights):
        defects.append({"msg": "skeleton lights must be hemi only"})
    raw_rooms = skeleton.get("rooms")
    raw_openings = skeleton.get("openings")
    rooms = raw_rooms if isinstance(raw_rooms, list) else None
    by_id = {}
    if rooms is None:
        defects.append({"msg": "skeleton rooms must be a list"})
        rooms = []
    for room in rooms:
        rid = room.get("id") if isinstance(room, dict) else None
        if not isinstance(rid, str) or not ROOM_ID_RE.fullmatch(rid):
            defects.append({"msg": "bad room id", "id": rid})
        elif rid in by_id:
            defects.append({"msg": "duplicate room id", "id": rid})
        else:
            by_id[rid] = room if isinstance(room, dict) else {}
    planned = plan.get("rooms")
    if not isinstance(planned, dict):
        defects.append({"msg": "plan rooms must be an object", "rooms": planned})
        planned = {}
    for rid in by_id:
        row = planned.get(rid)
        if row is None:
            defects.append({"msg": "room has no plan entry", "id": rid})
            continue
        if not isinstance(row, dict):
            defects.append({"msg": "plan room entry must be an object", "id": rid})
            continue
        refs = row.get("refs")
        budget = row.get("max_points")
        cues = row.get("cues")
        if (not isinstance(refs, list)
                or not isinstance(cues, str)
                or isinstance(budget, bool) or not isinstance(budget, int)):
            defects.append({"msg": "plan room entry lacks refs, max_points, cues",
                            "id": rid})
    for rid in planned:
        if rid not in by_id:
            defects.append({"msg": "plan has entry for unknown room", "id": rid})
    if raw_openings is None:
        openings = []
    elif isinstance(raw_openings, list):
        openings = raw_openings
    else:
        defects.append({"msg": "skeleton openings must be a list"})
        openings = []
    planned_openings = plan.get("openings")
    if not isinstance(planned_openings, dict):
        defects.append({"msg": "plan openings must be an object"})
        planned_openings = {}
    for opening in openings:
        if not isinstance(opening, dict):
            defects.append({"msg": "opening must be an object", "opening": opening})
            continue
        oid = opening.get("id")
        if not isinstance(oid, str) or not oid:
            defects.append({"msg": "opening has no id", "opening": opening})
            continue
        entry = planned_openings.get(oid)
        owner = entry.get("owner") if isinstance(entry, dict) else None
        if not isinstance(owner, str) or owner not in by_id:
            defects.append({"msg": "opening has no single owner", "id": oid})
            continue
        sides = _opening_rooms(opening, by_id)
        if sides and owner not in sides:
            defects.append({"msg": "opening owner is not one of its rooms", "id": oid})
    return defects


def _prompt(name: str, **fields) -> str:
    text = (PROMPTS / (name + ".md")).read_text()
    for key, value in fields.items():
        text = text.replace("{{%s}}" % key, value)
    return text


def _pretty(payload) -> str:
    return json.dumps(payload, ensure_ascii=False, indent=1)


def _image(path: Path) -> dict:
    kind = "png" if path.suffix.lower() == ".png" else "jpeg"
    url = "data:image/%s;base64,%s" % (kind, base64.b64encode(path.read_bytes()).decode())
    return {"type": "image_url", "image_url": {"url": url}, "name": path.name}


def _user(text: str, images: list) -> dict:
    return {"role": "user", "content": [{"type": "text", "text": text}] + images}


class Floor:
    def __init__(self, task_dir: Path, run_dir: Path, deps: dict, *, resume=False):
        self.task_dir = Path(task_dir)
        self.run_dir = Path(run_dir)
        self.deps = dict(deps)
        self.resume = resume
        self.interrupted = threading.Event()
        self.rounds = 0
        self.spark = _InterruptibleSpark(deps["spark"], self.interrupted)

    def interrupt(self):
        self.interrupted.set()
        close = getattr(self.deps.get("ledger"), "close", None)
        if close:
            close()
        self.deps["assets"].close()


    def run(self) -> FloorResult:
        try:
            return self._run()
        finally:
            self.deps["assets"].close()
            warmth = self.deps.get("warmth")
            if warmth is not None:
                warmth.close()

    # -- top level ----------------------------------------------------------

    def _report_fields(self) -> dict:
        ledger = self.deps.get("ledger")
        if ledger is None:
            return {"timeline": [], "total_usd": 0.0,
                    "stopped_by_cap": False}
        events = getattr(ledger, "events", None)
        if events is None:
            events = self._read_ledger_file(getattr(ledger, "path", None))
        else:
            events = list(events)
        spent = getattr(ledger, "spent", None)
        if spent is None:
            spent = sum(float(e.get("cost_usd") or 0.0) for e in events
                        if isinstance(e, dict))
        return {"timeline": events, "total_usd": float(spent),
                "stopped_by_cap": bool(getattr(ledger, "capped", False))}

    @staticmethod
    def _read_ledger_file(path) -> list:
        if path is None:
            return []
        try:
            lines = Path(path).read_text().splitlines()
        except OSError:
            return []
        out = []
        for line in lines:
            if not line.strip():
                continue
            try:
                out.append(json.loads(line))
            except ValueError:
                continue
        return out

    def _run(self) -> FloorResult:
        if self.resume:
            skeleton = json.loads((self.run_dir / "skeleton.json").read_text())
            plan = json.loads((self.run_dir / "plan.json").read_text())
            defects = skeleton_defects(skeleton, plan)
            if not defects:
                defects.extend(self._plan_refs(plan, skeleton))
            ok = not defects and green(self.deps["engine"].check_full(skeleton, self.run_dir / "work"))
        else:
            skeleton, plan, defects, ok = self._architect()
        if not ok:
            return self._finish(FloorResult(status="interrupted" if self.interrupted.is_set() else "stopped", reason="skeleton_red",
                                            skeleton_defects=defects, rounds=self.rounds,
                                            **self._report_fields()))
        self.run_dir.mkdir(parents=True, exist_ok=True)
        (self.run_dir / "skeleton.json").write_text(_pretty(skeleton))
        (self.run_dir / "plan.json").write_text(_pretty(plan))

        engine = Gated(self.deps["engine"], 2)
        work = self.run_dir / "work"
        ctx = Ctx(skeleton=skeleton, plan=plan, spark=self.spark, engine=engine,
                  assets=self.deps["assets"], store=RoomStore(self.run_dir), work=work,
                  effort=self.deps.get("effort") or {}, flags=self.deps.get("flags"),
                  cache=getattr(self.deps["assets"], "cache", self.run_dir / "cache"))
        self.deps["assets"].put("skeleton", engine.asset_keys(skeleton))
        # B25: the GPUs are warmed once the skeleton is green, not before the architect
        warmth = self.deps.get("warmth")
        if warmth is not None:
            warmth.start()

        room_ids = [r.get("id") for r in skeleton.get("rooms") or []]
        room_results = self._build_rooms(room_ids, ctx)
        self.deps["assets"].close()

        post_defects = self._post_defects(skeleton, plan, engine, work, room_results)
        partials = {rid: res.partial for rid, res in room_results.items() if res.partial}
        seam = repair_seams(ctx, partials)
        scene, removed = degrade(engine, work, skeleton, seam.partials, plan)
        clock = self.deps.get("clock", time.monotonic)
        sleep = self.deps.get("sleep", time.sleep)
        assets = self.deps["assets"]
        started = clock()
        while not getattr(assets, "idle", lambda: True)():
            if clock() - started >= getattr(assets, "mesh_timeout_s", 330):
                break
            sleep(getattr(assets, "poll_s", 2))
        dist = self.run_dir / "dist"
        final_errors, sheets = [], {}
        try:
            engine.build(scene, dist, "cache", ctx.cache)
            sheets = self._final_shots(engine, dist, room_ids)
        except EngineError as exc:
            final_errors.append({"kind": "build_failed", "code": exc.code})
        (self.run_dir / "scene.json").write_text(_pretty(scene))
        result = FloorResult(
            status="interrupted" if self.interrupted.is_set() else ("failed" if final_errors else "done"),
            rooms=room_results, skeleton_defects=defects + post_defects,
            rounds=self.rounds, removed=removed, seam_rounds=seam.rounds,
            rolled_back=seam.rolled_back, sheets=sheets, final_errors=final_errors,
            **self._report_fields())
        return self._finish(result)

    def _final_shots(self, engine, dist, rooms):
        for attempt in range(2):
            try:
                engine.shots(dist)
                sheet = dist / "sheet.html"
                return {"floor": str(sheet) if sheet.exists() else None,
                        "rooms": {r: str(sheet) if sheet.exists() else None for r in rooms}}
            except EngineError as exc:
                if exc.code != 2 or attempt == 1:
                    return {"floor": None, "rooms": {r: None for r in rooms},
                            "error": "shots_failed", "code": exc.code}
        return {}

    def _write_report(self, result: FloorResult, report_rooms=None) -> None:
        self.run_dir.mkdir(parents=True, exist_ok=True)
        payload = asdict(result)
        rooms = payload["rooms"] if report_rooms is None else report_rooms
        payload["rooms"] = {rid: (asdict(res) if hasattr(res, "__dataclass_fields__")
                                  else res) for rid, res in rooms.items()}
        (self.run_dir / "report.json").write_text(_pretty(payload))

    def _finish(self, result: FloorResult) -> FloorResult:
        self._write_report(result)
        return result

    # -- architect ------------------------------------------------------------

    def _architect(self) -> tuple[dict, dict, list, bool]:
        skeleton, plan, defects = {}, {}, []
        for attempt in range(MAX_ARCHITECT_FIX_ROUNDS + 1):
            if self.interrupted.is_set():
                break
            answer = self._ask_architect(attempt, skeleton, plan, defects)
            self.rounds += 1
            if not (answer.valid and isinstance(answer.scene, dict)):
                defects = [{"msg": "architect answer was not one valid json object"}]
                continue
            skeleton = answer.scene.get("skeleton") or {}
            plan = answer.scene.get("plan") or {}
            defects = skeleton_defects(skeleton, plan)
            if not defects:
                defects.extend(self._plan_refs(plan, skeleton))
            if defects:
                continue
            report = self.deps["engine"].check_full(skeleton, self.run_dir / "work")
            if green(report):
                return skeleton, plan, [], True
            defects = blocking(report)
        return skeleton, plan, defects, False

    def _ask_architect(self, attempt: int, skeleton: dict, plan: dict, defects: list):
        role = "architect" if attempt == 0 else "architect_fix"
        text = _prompt(role, TASK=self._task_text(), CUES=self._cues_text(),
                       SKELETON=_pretty(skeleton) if skeleton else "",
                       PLAN=_pretty(plan) if plan else "", DEFECTS=_pretty(defects),
                       SPEC=engine_spec(),
                       SCHEMA=self._doc("engine/schema/engine-scene.schema.json"))
        images = [_image(p) for p in self._refs()]
        effort = (self.deps.get("effort") or {}).get(role, "high")
        return self.spark.ask(role, "floor", attempt, [_user(text, images)], effort)

    def _task_text(self) -> str:
        path = self.task_dir / "TASK.md"
        return path.read_text() if path.exists() else ""

    def _cues_text(self) -> str:
        path = self.task_dir / "cues.md"
        return path.read_text() if path.exists() else ""

    def _refs(self) -> list:
        refs = (self.task_dir / "refs").resolve()
        if not refs.exists():
            return []
        return [p for p in sorted(refs.rglob("*")) if p.is_file()
                and p.suffix.lower() in (".png", ".jpg", ".jpeg")
                and p.resolve().is_relative_to(refs)]

    def _plan_refs(self, plan, skeleton):
        """Only task-supplied images may be sent back by the model as refs."""
        root = (self.task_dir / "refs").resolve()
        room_ids = {r.get("id") for r in skeleton.get("rooms") or [] if isinstance(r, dict)}
        defects = []
        for rid, row in plan["rooms"].items():
            if rid not in room_ids or not isinstance(row, dict) or not isinstance(row.get("refs"), list):
                continue
            resolved = []
            for name in row["refs"]:
                if not isinstance(name, str):
                    defects.append({"msg": "reference must be an image path", "room": rid})
                    continue
                path = Path(name)
                if not path.is_absolute():
                    path = (self.task_dir / path) if path.parts and path.parts[0] == "refs" else root / path
                path = path.resolve()
                if not path.is_relative_to(root) or path.suffix.lower() not in (".png", ".jpg", ".jpeg") or not path.is_file():
                    defects.append({"msg": "reference must be an existing image inside task refs", "room": rid})
                else:
                    resolved.append(str(path))
            row["refs"] = resolved
        return defects

    def _doc(self, rel: str) -> str:
        path = REPO / rel
        return path.read_text() if path.exists() else ""

    # -- builders ---------------------------------------------------------

    def _build_rooms(self, room_ids: list, ctx: Ctx) -> dict:
        if not room_ids:
            return {}
        with ThreadPoolExecutor(max_workers=len(room_ids)) as pool:
            futures = {pool.submit(RoomPipeline(room, ctx).run): room for room in room_ids}
            results = {}
            for future, room in futures.items():
                try:
                    results[room] = future.result()
                except Exception as exc:
                    # B23: a crash after a green round keeps that green fragment
                    kept = ctx.store.last_green(room)
                    if kept:
                        results[room] = RoomResult(room, "green", 0, kept)
                    else:
                        results[room] = RoomResult(room, "empty", 0,
                                                   {"crashed": type(exc).__name__})
        return results

    # -- joint findings -----------------------------------------------------

    def _post_defects(self, skeleton: dict, plan: dict, engine, work: Path,
                      room_results: dict) -> list:
        """Everything the floor is blamed for in the merged scene, now that the rooms
        cannot be sent back to the architect: the skeleton is already frozen."""
        partials = {rid: res.partial for rid, res in room_results.items() if res.partial}
        if not partials:
            return []
        scene, _violations = merge(skeleton, partials, plan)
        report = engine.check_full(scene, work)
        if green(report):
            return []
        grouped = blame_global(engine, work, skeleton, partials, plan, blocking(report))
        return grouped.get(SKELETON, [])


class _InterruptibleSpark:
    """Guard every stage, including parallel rooms, against new calls after SIGINT."""
    def __init__(self, spark, interrupted):
        self.spark, self.interrupted = spark, interrupted
        self.ledger = getattr(spark, "ledger", None)

    def ask(self, *args, **kwargs):
        if self.interrupted.is_set() or getattr(self.ledger, "capped", False):
            return Answer(valid=False, error="interrupted" if self.interrupted.is_set() else "cap")
        return self.spark.ask(*args, **kwargs)
