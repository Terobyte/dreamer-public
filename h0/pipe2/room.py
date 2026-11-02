"""One room's pipeline: builder -> fix rounds -> layout critic -> assets critic.

Every Spark call is a fresh request; nothing is a continuation of a chat. A room that
cannot reach a green `check` keeps its last green fragment (or none at all), so one bad
answer can never take the floor down with it.
"""

import base64
import json
import re
import shutil
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from pipe2.blame import blame_room
from pipe2.engine import blocking, green, shots_retry
from pipe2.merge import PARTIAL_KEYS, merge

DROPPABLE = {"DECAL_OVERLAP", "DECAL_OFF_WALL", "DECAL_ON_OPENING"}

HERE = Path(__file__).parent
PROMPTS = HERE / "prompts"
REPO = HERE.parent.parent
SPEC_PATH = REPO / "specs/engine-scene.md"
#: open yards, facades, roofs, sky: engine-scene.md does not cover them, so every spec reader gets this too
STREET_PATH = REPO / "engine/docs/street.md"
SCHEMA_PATH = REPO / "engine/schema/engine-scene.schema.json"

_UNSAFE_SHOT_CHARS = re.compile(r"[/\\\x00-\x1f]")


def shot_filenames(camera_ids: list) -> list:
    """The engine's `shots/<camera id>.png` names, for the whole camera list of one
    build (`shotFileNames` in `engine/src/build/shots.ts`): path separators and control
    characters become `_`, and because two distinct ids can sanitize to the same base
    (`A_g/left` and `A_g_left`), every base shared by more than one camera gets its
    index appended, growing further `-<index>` suffixes until the name is free. The
    lookup side has to repeat this over the same list or it reads the wrong file."""
    base = []
    for camera_id in camera_ids:
        safe = _UNSAFE_SHOT_CHARS.sub("_", str(camera_id))
        base.append("_" + safe if safe in ("", ".", "..") else safe)
    counts = {}
    for name in base:
        counts[name] = counts.get(name, 0) + 1
    used = set()
    out = []
    for i, name in enumerate(base):
        chosen = "%s-%d" % (name, i) if counts[name] > 1 else name
        while chosen in used:
            chosen = "%s-%d" % (chosen, i)
        used.add(chosen)
        out.append(chosen + ".png")
    return out

def room_path(root: Path, room: str) -> Path:
    """`root/<room>`, refusing ids that would land anywhere else: the scene schema allows
    any string as a room id, and `../x` or an absolute path must never become a file."""
    room = str(room)
    if room in ("", ".", "..") or "/" in room or "\\" in room or "\x00" in room:
        raise ValueError("unsafe room id: %r" % room)
    root = Path(root)
    here = root / room
    if here.resolve().parent != root.resolve():
        raise ValueError("unsafe room id: %r" % room)
    return here


MAX_FIX_ROUNDS = 2
REISSUE_SUFFIX = " #v2"
#: said to both critics, verbatim: a neighbour's chair is not a finding
NOT_YOURS = "Objects of another room seen through an opening are not yours."


@dataclass
class Ctx:
    """Everything a room needs; shared read-only across rooms except `assets`/`store`."""

    skeleton: dict
    plan: dict
    spark: Any
    engine: Any
    assets: Any
    store: Any
    work: Path
    effort: dict
    flags: Any = None
    spec: str | None = None
    schema: str | None = None
    cache: Path | None = None

    def doc(self, which: str) -> str:
        """Engine spec and schema: injected by the caller, else read from the repo."""
        given = self.spec if which == "spec" else self.schema
        if given is not None:
            return given
        if which != "spec":
            return SCHEMA_PATH.read_text() if SCHEMA_PATH.exists() else ""
        return engine_spec()


def engine_spec() -> str:
    """specs/engine-scene.md plus engine/docs/street.md: the whole format a model writes in."""
    return "\n\n".join(p.read_text() for p in (SPEC_PATH, STREET_PATH) if p.exists())


@dataclass
class RoomResult:
    room: str
    status: str
    rounds: int = 0
    partial: dict = field(default_factory=dict)


class RoomStore:
    """The run's files are the truth: a resumed run reads them instead of asking again."""

    def __init__(self, root):
        self.root = Path(root)

    def _dir(self, room: str) -> Path:
        here = room_path(self.root / "rooms", room)
        here.mkdir(parents=True, exist_ok=True)
        return here

    @staticmethod
    def _write(path: Path, payload) -> None:
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=1))

    def save(self, room: str, role: str, round_no: int, partial: dict) -> None:
        self._write(self._dir(room) / ("%s_%d.json" % (role, round_no)), partial)

    def save_messages(self, room: str, role: str, round_no: int, messages: list) -> None:
        base = "%s_%d" % (role, round_no)
        stored, images = _sidecar_images(messages, base)
        if images:
            folder = self._dir(room) / (base + ".images")
            folder.mkdir(parents=True, exist_ok=True)
            for name, data_url in images:
                (folder / name).write_bytes(_decode_data_url(data_url))
        self._write(self._dir(room) / (base + ".messages.json"), stored)

    def keep_green(self, room: str, role: str, round_no: int, partial: dict,
                   report: dict | None = None, reissued: bool = False) -> None:
        self._write(self._dir(room) / "green.json",
                    {"role": role, "round": round_no, "partial": partial,
                     "report": report or {}, "reissued": bool(reissued)})

    def green_state(self, room: str) -> dict:
        """The last accepted fragment and its check: what a resumed run continues from."""
        path = room_path(self.root / "rooms", room) / "green.json"
        if not path.exists():
            return {}
        try:
            data = json.loads(path.read_text())
        except ValueError:
            return {}
        return data if isinstance(data, dict) else {}

    def last_green(self, room: str) -> dict | None:
        return self.green_state(room).get("partial")

    def last_report(self, room: str) -> dict:
        return self.green_state(room).get("report") or {}

    def done_state(self, room: str) -> dict | None:
        """The finished result, if this room already ran to completion."""
        path = room_path(self.root / "rooms", room) / "done.json"
        if not path.exists():
            return None
        try:
            data = json.loads(path.read_text())
        except ValueError:
            return None
        return data if isinstance(data, dict) else None

    def taken(self, room: str) -> dict:
        """Next free round per role, so a resumed run continues numbering, never overwrites."""
        out: dict[str, int] = {}
        here = room_path(self.root / "rooms", room)
        if not here.exists():
            return out
        for path in here.glob("*.json"):
            stem = path.name[:-len(".json")]
            if stem.endswith(".messages"):
                stem = stem[:-len(".messages")]
            role, sep, num = stem.rpartition("_")
            if sep and num.isdigit() and role:
                out[role] = max(out.get(role, 0), int(num) + 1)
        return out

    def finish(self, room: str, result: RoomResult) -> None:
        self._write(self._dir(room) / "done.json", asdict(result))


def _sidecar_images(messages: list, base: str) -> tuple[list, list]:
    """The stored call input keeps every image, but as a sidecar file next to the json
    instead of a repeated base64 blob: `.messages.json` plus `<base>.images/<name>` is the
    whole Spark call input, reconstructible byte-for-byte."""
    out = []
    images = []
    for message in messages:
        content = message.get("content")
        if isinstance(content, str):
            out.append(message)
            continue
        parts = []
        for part in content or ():
            if part.get("type") != "image_url":
                parts.append(part)
                continue
            name = part.get("name") or ("image_%d" % len(images))
            # indexed so two refs sharing a basename never collide on disk
            safe = "%d_%s" % (len(images), name)
            url = (part.get("image_url") or {}).get("url") or ""
            images.append((safe, url))
            parts.append({"type": "image_url", "name": name,
                          "path": "%s.images/%s" % (base, safe)})
        out.append({"role": message.get("role"), "content": parts})
    return out, images


def _decode_data_url(data_url: str) -> bytes:
    _, _, encoded = data_url.partition(",")
    return base64.b64decode(encoded) if encoded else b""


def _image(path: Path) -> dict:
    kind = "png" if path.suffix.lower() == ".png" else "jpeg"
    url = "data:image/%s;base64,%s" % (kind, base64.b64encode(path.read_bytes()).decode())
    return {"type": "image_url", "image_url": {"url": url}, "name": path.name}


def _prompt(name: str, **fields) -> str:
    text = (PROMPTS / (name + ".md")).read_text()
    for key, value in fields.items():
        text = text.replace("{{%s}}" % key, value)
    return text


def _plan_ref(ref, refs: list):
    """The plan's absolute path for a camera ref, or None. Builders copy the architect's spelling
    (`refs/living.png`) while the plan holds resolved paths, so a ref matches by whole path suffix."""
    if not isinstance(ref, str) or not ref:
        return None
    if ref in refs:
        return ref
    tail = "/" + ref.lstrip("./")
    hits = [r for r in refs if r.endswith(tail)]
    return hits[0] if len(hits) == 1 else None


def _ref_cameras(room: str, n_refs: int) -> str:
    """One camera id per attached reference, so every ref gets its own screenshot back."""
    names = ["`%s_ref%d`" % (room, i + 1) for i in range(max(n_refs, 1))]
    return ", ".join(names)


def _pretty(payload) -> str:
    return json.dumps(payload, ensure_ascii=False, indent=1)


class RoomPipeline:
    def __init__(self, room: str, ctx: Ctx):
        self.room = room
        self.ctx = ctx
        self.prefix = room + "_"
        saved = ctx.store.green_state(room)
        self.partial: dict = saved.get("partial") or {}
        self.rounds = 0
        self.status = "green" if self.partial else "empty"
        self.reissued = bool(saved.get("reissued", False))
        #: the role whose answer the green file holds: a resume skips the critics it covers
        self.green_role = saved.get("role") if self.partial else None
        #: the report of the last check, shown to the critics instead of a fresh run
        self.report: dict = saved.get("report") or {}
        self._counts: dict[str, int] = ctx.store.taken(room)
        #: per preview stage, camera id -> the file the engine wrote for it
        self._shot_names: dict[str, dict] = {}

    # -- the run --------------------------------------------------------------

    def run(self) -> RoomResult:
        if self.ctx.store.done_state(self.room) is not None:
            done = self.ctx.store.done_state(self.room)
            return RoomResult(self.room, done.get("status", "empty"), done.get("rounds", 0),
                              done.get("partial") or {})
        if self._author():
            done_role = self.green_role
            self._queue(self.partial.get("assets") or {})
            if done_role != "critic_assets":
                if done_role != "critic_layout":
                    self._preview("layout", "none")
                    self._critic("critic_layout")
                self.ctx.assets.wait(self.room)
                self._preview("assets", "cache")
                self._critic("critic_assets", allow_reissue=True)
        result = RoomResult(self.room, self.status, self.rounds, self.partial)
        # only a run that got here is done: a crash leaves the green file to resume from.
        # B17: an empty room (a capped or interrupted Spark answered nothing) stays
        # resumable instead of being sealed as finished
        if self.status != "empty":
            self.ctx.store.finish(self.room, result)
        return result

    # -- builder and fix rounds ----------------------------------------------

    def _author(self) -> bool:
        """Builder, then up to two fix rounds. True once a round is green."""
        if self.partial:
            # resumed on the last green fragment: the builder's turn is already stored
            self.status = "green"
            return True
        answer = self._ask("builder", self._builder_messages())
        findings = None
        candidate: dict | None = None
        for _attempt in range(MAX_FIX_ROUNDS + 1):
            if answer is not None and answer.valid:
                candidate = answer.scene
                ok, findings = self._accept("builder" if _attempt == 0 else "fix", answer.scene)
                if ok:
                    self.status = "green"
                    return True
            elif answer is not None:
                candidate = candidate if isinstance(candidate, dict) else self.partial
                # nothing of ours to quote: the next round is told the answer was unusable
                findings = findings or None
            if _attempt == MAX_FIX_ROUNDS:
                break
            answer = self._ask("fix", self._fix_messages(
                candidate if isinstance(candidate, dict) else self.partial, findings))
        self.partial = {}
        self.status = "empty"
        return False

    def _accept(self, role: str, candidate: dict) -> tuple[bool, list]:
        """Merge + check a candidate fragment; keep it only if the room is green."""
        refs = ((self.ctx.plan.get("rooms") or {}).get(self.room) or {}).get("refs") or []
        for camera in candidate.get("cameras") or []:
            if camera.get("ref"):
                path = _plan_ref(camera["ref"], refs)
                if path is None:
                    return False, [{"code": "OWN_REF", "msg": "camera ref must be a task-provided room image"}]
                camera["ref"] = path
        scene, violations, report = self._check(candidate)
        if not green(report):
            return False, self._findings(scene, violations, report)
        findings = self._findings(scene, violations, report)
        if findings:
            return False, findings
        self.partial = candidate
        self.ctx.store.keep_green(self.room, role, self._counts[role] - 1, candidate,
                                  self.report, self.reissued)
        return True, []

    def _check(self, candidate: dict) -> tuple[dict, list, dict]:
        scene, violations = merge(self.ctx.skeleton, {self.room: candidate}, self.ctx.plan)
        self.report = self.ctx.engine.check_full(scene, self.ctx.work)
        return scene, violations, self.report

    def _findings(self, scene: dict, violations: list, report: dict) -> list:
        """This room's blocking findings: the linter's, blamed on us, plus merge refusals."""
        mine = blame_room(scene, blocking(report), self.room).get(self.room, [])
        return mine + [v for v in violations if v.get("owner") == self.room]

    # -- critics --------------------------------------------------------------

    def _critic(self, role: str, allow_reissue: bool = False) -> None:
        if role == "critic_layout" and self._skip_layout():
            return
        answer = self._ask(role, self._critic_messages(role, self.report))
        if not answer.valid:
            self._rollback()
            return
        candidate = answer.scene
        reissued0 = self.reissued
        fresh = self._freeze(candidate, allow_reissue)
        ok, findings = self._accept(role, candidate)
        if not ok:
            # one retry: the critic gets its own rejected fragment and the findings
            self._record({"kind": "critic_retry", "room": self.room, "role": role,
                          "findings": findings})
            retry = self._ask(role, self._critic_messages(
                role, self.report, partial=candidate, findings=findings))
            if retry.valid:
                candidate = retry.scene
                self.reissued = reissued0
                fresh = self._freeze(candidate, allow_reissue)
                ok, findings = self._accept(role, candidate)
                if not ok:
                    ok, findings = self._drop_decals(role, candidate, findings)
        if not ok:
            # B28: the engine's reasons for refusing the critic are kept, not dropped
            self._record({"kind": "critic_rejected", "room": self.room, "role": role,
                          "findings": findings, "errors": blocking(self.report)})
            self._rollback()
            return
        # B28: an accepted later revision is green again, not stuck at rolled_back
        self.status = "green"
        if fresh:
            self._queue(fresh)

    def _drop_decals(self, role: str, candidate: dict, findings: list) -> tuple[bool, list]:
        """Remove the decals a retried critic still overlaps, if every finding is a droppable
        decal finding and every decal is the critic's own. (ok, findings) of the new check."""
        indexes: list[int] = []
        paths: list[str] = []
        for f in findings:
            parts = str(f.get("path") or "").split("/")
            if f.get("code") not in DROPPABLE or len(parts) not in (3, 4) or parts[0] != "" \
                    or parts[1] != "decals" or not parts[2].isdigit():
                return False, findings
            if len(parts) == 4 and not parts[3]:
                return False, findings
            if int(parts[2]) not in indexes:
                indexes.append(int(parts[2]))
                paths.append("/decals/%d" % int(parts[2]))
        if not indexes:
            return False, findings
        scene, _violations = merge(self.ctx.skeleton, {self.room: candidate}, self.ctx.plan)
        merged = scene.get("decals") or []
        own = candidate.get("decals") or []
        drop: set[int] = set()
        for i in indexes:
            if i >= len(merged):
                return False, findings
            found = _find_decal(merged[i], own)
            if found is None:
                return False, findings
            drop.add(found)
        candidate["decals"] = [d for j, d in enumerate(own) if j not in drop]
        ok, new = self._accept(role, candidate)
        if ok:
            self._record({"kind": "critic_dropped", "room": self.room, "role": role,
                          "paths": paths})
        return ok, new

    def _skip_layout(self) -> bool:
        """Production shortcut only: skip the layout critic when the meshes already landed."""
        flag = getattr(self.ctx.flags, "skip_layout_critic_if_meshes_ready", False)
        return bool(flag) and self.ctx.assets.done(self.room)

    def _rollback(self) -> None:
        saved = self.ctx.store.green_state(self.room)
        self.partial = saved.get("partial") or {}
        self.report = saved.get("report") or {}
        self.reissued = bool(saved.get("reissued", False))
        self.status = "rolled_back" if self.partial else "empty"

    def _freeze(self, candidate: dict, allow_reissue: bool) -> dict:
        """Give every known asset its old prompt back. A critic with assets may spend the
        room's single reissue: that one gets ` #v2` and is queued again. Returns what the
        queue has not seen yet: the reissue and any key the critic added."""
        old = (self.partial.get("assets") or {})
        fresh = {}
        for key, spec in (candidate.get("assets") or {}).items():
            if not isinstance(spec, dict):
                continue
            wants = bool(spec.pop("reissue", False))
            if key not in old:
                # a key the critic introduced has never been queued: it goes now
                fresh[key] = spec
                continue
            was = (old[key] or {}).get("prompt")
            if not (wants and allow_reissue):
                spec["prompt"] = was
                continue
            if self.reissued:
                spec["prompt"] = was
                self._record({"kind": "reissue_ignored", "room": self.room, "asset": key})
                continue
            self.reissued = True
            spec["prompt"] = (was or "") + REISSUE_SUFFIX
            self._record({"kind": "reissue", "room": self.room, "asset": key})
            fresh[key] = spec
        return fresh

    def _record(self, event: dict) -> None:
        ledger = getattr(self.ctx.spark, "ledger", None)
        if ledger is not None:
            ledger.record(event)

    # -- engine side ----------------------------------------------------------

    def _queue(self, assets: dict) -> None:
        """Hand the engine's keys for `assets` to the queue; it generates in parallel.

        Refs are attached first, so the queued key already folds in the frame
        bytes and the queue paints from the picture (H2), not from text."""
        if not assets:
            return
        scene, _violations = merge(self.ctx.skeleton, {self.room: self.partial}, self.ctx.plan)
        from pipe2.floor import attach_refs
        attach_refs(scene, self.ctx.plan, self.ctx.store.root)
        keys = [k for k in self.ctx.engine.asset_keys(scene, self.ctx.store.root) if k.get("id") in assets]
        self.ctx.assets.put(self.room, keys)

    def _preview(self, stage: str, assets: str) -> None:
        """Build and screenshot the room. A failing build only costs us the pictures."""
        scene, _violations = merge(self.ctx.skeleton, {self.room: self.partial}, self.ctx.plan)
        dist = self._dist(stage)
        cache = self.ctx.cache or (self.ctx.work / "cache")
        ids = [c.get("id") for c in scene.get("cameras") or []]
        # a previous run's pictures are not this scene's: start from an empty folder, and
        # expose shots only once this build and these shots both succeeded
        self._shot_names.pop(stage, None)
        shutil.rmtree(dist, ignore_errors=True)
        try:
            from pipe2.floor import attach_refs
            attach_refs(scene, self.ctx.plan, self.ctx.store.root)
            self.ctx.engine.build(scene, dist, assets, None if assets == "none" else cache,
                                  self.ctx.store.root)
            shots_retry(self.ctx.engine, dist)
            # the whole scene's camera list decides our own cameras' filenames
            self._shot_names[stage] = dict(zip(ids, shot_filenames(ids)))
        except Exception as exc:
            # B42 (lesson #35): failed shots stop the room with their cause, never
            # a silent run on without pictures; the green file stays to resume from
            shutil.rmtree(dist / "shots", ignore_errors=True)
            self._record({"kind": "preview_failed", "room": self.room, "stage": stage,
                          "error": "%s: %s" % (type(exc).__name__, exc)})
            raise

    def _dist(self, stage: str) -> Path:
        return room_path(self.ctx.work / "rooms", self.room) / ("dist_" + stage)

    def _shots(self) -> list[dict]:
        """Our own cameras' screenshots, newest build first; never a neighbour's camera."""
        mine = [c.get("id") for c in self.partial.get("cameras") or []
                if str(c.get("id") or "").startswith(self.prefix)]
        out = []
        for stage in ("assets", "layout"):
            names = self._shot_names.get(stage) or {}
            for camera in mine:
                name = names.get(camera)
                if name is None:
                    continue
                shot = self._dist(stage) / "shots" / name
                if shot.exists():
                    out.append(_image(shot))
            if out:
                break
        return out

    # -- prompts --------------------------------------------------------------

    def _ask(self, role: str, messages: list):
        round_no = self._counts.get(role, 0)
        self._counts[role] = round_no + 1
        self.ctx.store.save_messages(self.room, role, round_no, messages)
        answer = self.ctx.spark.ask(role, self.room, round_no, messages,
                                    self.ctx.effort.get(role, "high"))
        self.rounds += 1
        if not answer.valid:
            # every step keeps both files: an invalid answer still stores what was sent
            self.ctx.store.save(self.room, role, round_no,
                                {"invalid": True, "error": answer.error or "no answer"})
        else:
            self.ctx.store.save(self.room, role, round_no, answer.scene)
        return answer

    def _builder_messages(self) -> list:
        row = (self.ctx.plan.get("rooms") or {}).get(self.room) or {}
        openings = [oid for oid, spec in (self.ctx.plan.get("openings") or {}).items()
                    if (spec or {}).get("owner") == self.room]
        text = _prompt("builder",
                       ROOM=self.room,
                       BRIEF=_pretty(row) if row else "",
                       CUES=str(self.ctx.plan.get("cues") or ""),
                       REF_CAMERAS=_ref_cameras(self.room, len(row.get("refs") or [])),
                       PARTIAL_KEYS=", ".join(PARTIAL_KEYS),
                       OPENINGS=", ".join(openings) or "none",
                       SKELETON=_pretty(self.ctx.skeleton),
                       SPEC=self.ctx.doc("spec"),
                       SCHEMA=self.ctx.doc("schema"))
        return [_user(text, self._refs(row))]

    def _refs(self, row: dict) -> list:
        return [_image(Path(p)) for p in row.get("refs") or [] if Path(p).exists()]

    def _fix_messages(self, candidate, findings) -> list:
        text = _prompt("fix",
                       ROOM=self.room,
                       PARTIAL=_pretty(candidate if isinstance(candidate, dict) else self.partial),
                       FINDINGS=_pretty(_findings_note(findings)),
                       SKELETON=_pretty(self.ctx.skeleton),
                       SPEC=self.ctx.doc("spec"))
        return [_user(text, [])]

    def _critic_messages(self, role: str, report: dict, partial: dict | None = None,
                         findings: list | None = None) -> list:
        text = _prompt(role,
                       ROOM=self.room,
                       PARTIAL=_pretty(self.partial if partial is None else partial),
                       REPORT=_pretty(report),
                       SKELETON=_pretty(self.ctx.skeleton))
        assert NOT_YOURS in text
        if findings is not None:
            lines = ["- code: %s, path: %s" % (f.get("code"), f.get("path")) for f in findings]
            text += ("\n\nYour previous answer was refused by the check. Fix only this, "
                     "return everything else as it was:\n\n" + "\n\n".join(lines))
        # references first, then our shots: without them the critic judges a picture against nothing
        # (Twelve Oaks: "green" on a scene that looked nothing like its references)
        row = (self.ctx.plan.get("rooms") or {}).get(self.room) or {}
        return [_user(text, self._refs(row) + self._shots())]


def _find_decal(decal, own: list):
    """Index in `own` of the critic's decal equal to a merged one (by id, else by content)."""
    if isinstance(decal, dict) and decal.get("id") is not None:
        for j, d in enumerate(own):
            if isinstance(d, dict) and d.get("id") == decal["id"]:
                return j
        return None
    key = json.dumps(decal, sort_keys=True, default=str)
    for j, d in enumerate(own):
        if json.dumps(d, sort_keys=True, default=str) == key:
            return j
    return None


def _findings_note(findings) -> list:
    """`None` means the answer itself was unusable; an empty list means the check was red
    but every finding belongs to the skeleton or another room - never call that bad json."""
    if findings is None:
        return [{"msg": "your answer was not one valid json object"}]
    if not findings:
        return [{"msg": "the check refused the scene, but no finding is owned by your room; "
                        "send your fragment again, corrected where you can"}]
    return findings


def _user(text: str, images: list) -> dict:
    return {"role": "user", "content": [{"type": "text", "text": text}] + images}
