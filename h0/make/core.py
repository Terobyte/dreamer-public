"""Оркестратор make: DAG, манифест, хэш входов, лок, потолки денег. Код, не LLM."""
import concurrent.futures as cf
import dataclasses
import hashlib
import json
import math
import os
import shutil
import threading
import time
import uuid
from pathlib import Path
from typing import Callable, Optional

DEFAULT_SPLIT = {"brief": 2, "refs": 3, "world": 70, "cast": 15, "story": 10}
OPTIONAL_PARAMS = {"book", "scene"}  # в хэше только если заданы
KEEP_TMP = {"world"}  # упавший world остаётся для --resume
STUB_SLEEP = 0.3


class MissingInput(Exception):
    pass


class LockError(Exception):
    pass


@dataclasses.dataclass(frozen=True)
class Stage:
    id: str
    deps: tuple
    version: int
    fn: Callable
    params: tuple = ("fake",)  # ключи opts, влияющие на стадию
    marker: str = "marker.txt"
    optional: bool = False  # включается только флагом


@dataclasses.dataclass
class Ctx:
    run_dir: Path
    out: Path
    params: dict
    resume: bool
    budget_usd: Optional[float]
    opts: dict
    usd: float = 0.0  # фактические траты, известные до конца стадии

    def spend(self, usd):
        self.usd += float(usd)


def _slow_stub(ctx):
    start = time.time()
    time.sleep(STUB_SLEEP)
    (ctx.out / "marker.txt").write_text(json.dumps({"start": start, "end": time.time()}))
    return 0.0


def _fast_stub(ctx):
    (ctx.out / "marker.txt").write_text(json.dumps({"start": time.time(), "end": time.time()}))
    return 0.0


def _seed_brief(prompt):
    """Minimal valid seed brief from the prompt (offline; live Spark wiring is 11-01)."""
    title = (prompt or 'untitled').strip().splitlines()[0][:80] if (prompt or '').strip() else 'untitled'
    want = (prompt or '').strip() or 'look around'
    return {'title': title, 'mode': 'seed', 'book': None, 'style': 'warm gouache',
            'places': [{'id': 'room1', 'type': 'room', 'size_m': [5, 4], 'level': 0, 'next_to': [],
                        'query': title, 'provider_hint': 'commons', 'fandom_wiki': None}],
            'cast': [{'who': 'Anna', 'sex': 'female', 'age': 'adult', 'look': 'tall',
                      'voice': 'woman', 'query': 'woman'}],
            'scene': {'where': 'room1', 'who': ['Anna'], 'want': want}}


def _spark_transport():
    """Live Spark transport (pipe2). Tests patch this; nothing here reads the key."""
    from pipe2.spark import HttpTransport
    return HttpTransport()


def _run_brief(ctx):
    """Stage `brief`: prompt (+ book scene) -> brief/brief.json. One Spark call via pipe2 in
    JSON mode, checked against make/schema/brief.json; scripted Spark when --fake."""
    from . import brief as _brief
    prompt = (ctx.opts.get('prompt') or '').strip()
    if not prompt:
        raise _brief.BriefFailed('brief needs a prompt (make.json.prompt is empty)')
    book, scene = ctx.opts.get('book'), ctx.opts.get('scene')
    if bool(book) != bool(scene):
        raise _brief.BriefFailed('--book and --scene go together')
    note = _brief.book_context(book, scene) if book else None
    expect = {'dir': str(book), 'scene': scene} if book else None
    if ctx.params.get('fake'):
        seed = _brief.seed_from_book(prompt, book, scene) if book else _seed_brief(prompt)
        b = _brief.make_brief(prompt, _brief.ScenarioBrief([json.dumps(seed)]), note, expect)
    else:
        import sys
        h0 = str(Path(__file__).resolve().parents[1])
        if h0 not in sys.path:
            sys.path.insert(0, h0)
        from pipe2.ledger import Ledger, load_prices
        from pipe2.spark import Spark
        # two calls max (answer + one retry); the stage share is enforced by run_make after the
        # fact - Spark's worst-case reserve (64k out tokens) is bigger than 2 % of a small budget
        ledger = Ledger(ctx.out / 'events.jsonl', load_prices(), float('inf'), 2)
        ask = _brief.spark_ask(Spark(_spark_transport(), ledger), ctx.opts.get('effort') or 'medium')
        try:
            b = _brief.make_brief(prompt, ask, note, expect)
        finally:
            ctx.spend(ledger.spent)
    (ctx.out / 'brief.json').write_text(json.dumps(b, ensure_ascii=False, indent=2))
    (ctx.out / 'marker.txt').write_text(json.dumps({'start': time.time(), 'end': time.time()}))
    return 0.0


def _run_refs(ctx):
    """Stage `refs`: brief.json -> refs/refs.json, cues.md, <slot>/<n>.png|jpg."""
    from . import refs as _refs
    from .refs import fake as _fake
    brief = json.loads((ctx.run_dir / 'brief' / 'brief.json').read_text())
    pick = ctx.opts.get('pick') or 'first'
    if ctx.params.get('fake'):
        providers, loader, ask = _fake.providers(), _fake.image, _fake.vision_ask
    else:
        from .refs import commons, fandom, openverse, tavily
        providers = {'commons': commons.search, 'openverse': openverse.search, 'tavily': tavily.search,
                     'fandom': fandom.search}

        def loader(url):
            import urllib.request
            req = urllib.request.Request(url, headers={'User-Agent': 'dreamer-make/0.6 (refs)'})
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read()
        ask = None
        if pick == 'vision':
            import base64
            import sys
            h0 = str(Path(__file__).resolve().parents[1])
            if h0 not in sys.path:
                sys.path.insert(0, h0)
            from pipe2.ledger import Ledger, load_prices
            from pipe2.spark import Spark
            ledger = Ledger(ctx.out / 'events.jsonl', load_prices(), float('inf'), 64)
            spark = Spark(_spark_transport(), ledger)

            def ask(slot, images):
                parts = [{'type': 'text', 'text': 'Pick the images that show this place; answer JSON '
                          '{"keep": [indexes], "cues": "visible features"}. Slot: ' + slot}]
                for c in images:
                    mime = 'png' if c['_ext'] == 'png' else 'jpeg'
                    b64 = base64.b64encode(c['_bytes']).decode()
                    parts.append({'type': 'image_url', 'image_url': {'url': f'data:image/{mime};base64,{b64}'}})
                ans = spark.ask('refs', 'refs', 0, [{'role': 'user', 'content': parts}], 'medium')
                ctx.usd = ledger.spent
                return json.dumps(ans.scene) if ans.valid and ans.scene is not None else '{}'
    _refs.run_refs(brief, ctx.out, providers=providers, loader=loader, pick=pick, ask=ask)
    (ctx.out / 'marker.txt').write_text(json.dumps({'start': time.time(), 'end': time.time()}))
    return 0.0


def default_stages():
    S = Stage
    return {s.id: s for s in (
        S("brief", (), 3, _run_brief, ("fake", "prompt", "book", "scene")),
        S("refs", ("brief",), 2, _run_refs, ("fake", "pick")),
        S("world", ("refs",), 1, _slow_stub, ("fake", "effort", "cap")),
        S("cast", ("refs",), 1, _slow_stub, ("fake", "cap")),
        S("story", ("refs",), 1, _slow_stub, ("fake", "cap")),
        S("stage", ("world", "cast", "story"), 1, _fast_stub),
        S("check", ("world", "refs"), 1, _fast_stub, optional=True),
    )}


def canonical(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


def input_hash(stage, version, params, inputs):
    body = {"stage": stage, "version": version, "params": params, "inputs": inputs}
    return hashlib.sha256(canonical(body).encode()).hexdigest()


def _validate_split(sp):
    for k in sp:
        if k not in DEFAULT_SPLIT:
            raise ValueError(f"unknown stage in split: {k}")
    for k, v in sp.items():
        if v < 0:
            raise ValueError(f"split share for {k} is negative: {v}")
    if sum(sp.values()) > 100:
        raise ValueError(f"split shares exceed 100: {sum(sp.values())}")


def parse_split(text=None):
    sp = dict(DEFAULT_SPLIT)
    for part in (text or "").split(","):
        if part.strip():
            k, v = part.split("=")
            sp[k.strip()] = float(v) if "." in v else int(v)
    _validate_split(sp)
    return sp


def _sha_file(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _pid_alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


class _Lock:
    """O_EXCL + pid. Мёртвый лок снимается через rename в уникальное имя и сверку
    содержимого: если между чтением и снятием лок подменили живым, он возвращается."""

    def __init__(self, path):
        self.path = Path(path)
        self.token = None

    def _create(self):
        try:
            fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            return False
        self.token = f"{os.getpid()} {uuid.uuid4().hex}"
        os.write(fd, self.token.encode())
        os.close(fd)
        return True

    def __enter__(self):
        if self._create():
            return self
        try:
            raw = self.path.read_text()
        except FileNotFoundError:
            raw = None
        if raw is not None:
            try:
                pid = int(raw.split()[0])
            except (ValueError, IndexError):
                raise LockError("run is locked (incomplete lock file)")
            if pid <= 0:
                raise LockError("run is locked (incomplete lock file)")
            if pid == os.getpid() or _pid_alive(pid):
                raise LockError(f"run is locked by pid {pid}")
            stale = self.path.with_name(f"{self.path.name}.stale.{uuid.uuid4().hex}")
            try:
                os.rename(self.path, stale)
            except FileNotFoundError:
                pass
            else:
                cur = stale.read_bytes().decode(errors="replace")
                if cur != raw:
                    try:
                        os.link(stale, self.path)
                    except FileExistsError:
                        pass
                    os.unlink(stale)
                    raise LockError("run is locked (lock changed)")
                os.unlink(stale)
        if self._create():
            return self
        raise LockError("run is locked (taken concurrently)")

    def __exit__(self, *a):
        try:
            if self.path.read_bytes().decode(errors="replace") == self.token:
                os.unlink(self.path)
        except FileNotFoundError:
            pass


class _Manifest:
    def __init__(self, run_dir, prompt):
        self.path = run_dir / "make.json"
        self.mu = threading.Lock()
        if self.path.exists():
            self.data = json.loads(self.path.read_text())
            if prompt is not None:
                self.data["prompt"] = prompt
        else:
            self.data = {"prompt": prompt, "created": time.strftime("%Y-%m-%dT%H:%M:%S"),
                         "stages": {}}
        self.save()

    def save(self):
        tmp = self.path.with_name("make.json.tmp")
        tmp.write_text(json.dumps(self.data, ensure_ascii=False, indent=2))
        os.replace(tmp, self.path)

    def get(self, sid):
        return self.data["stages"].get(sid, {})

    def spent(self):
        with self.mu:
            return sum(r.get("usd") or 0 for r in self.data["stages"].values())

    def put(self, sid, rec):
        with self.mu:
            self.data["stages"][sid] = rec
            self.save()


def _descendants(stages, sid):
    out, todo = set(), [sid]
    while todo:
        cur = todo.pop()
        for s in stages.values():
            if cur in s.deps and s.id not in out:
                out.add(s.id)
                todo.append(s.id)
    return out


def _ancestors(stages, sid):
    out, todo = set(), [sid]
    while todo:
        for d in stages[todo.pop()].deps:
            if d not in out:
                out.add(d)
                todo.append(d)
    return out


PUB = ".pub"


def _publish(run_dir, sid, tmp):
    """<sid> — симлинк на .pub/<sid>-<ns>; замена ссылки одним os.replace,
    так что читатель всегда видит старый или новый результат."""
    store = run_dir / PUB
    store.mkdir(exist_ok=True)
    target = store / f"{sid}-{time.time_ns()}"
    os.replace(tmp, target)
    final = run_dir / sid
    link = run_dir / f".{sid}.lnk"
    if link.is_symlink() or link.exists():
        os.unlink(link)
    os.symlink(os.path.relpath(target, run_dir), link)
    old = os.readlink(final) if final.is_symlink() else None
    if final.exists() and not final.is_symlink():  # старая папка без ссылки
        legacy = run_dir / f"{sid}.old"
        os.replace(final, legacy)
        os.replace(link, final)
        shutil.rmtree(legacy, ignore_errors=True)
    else:
        os.replace(link, final)
    if old:
        shutil.rmtree(run_dir / old, ignore_errors=True)


def run_make(run_dir, prompt=None, *, stages=None, only=None, from_=None, until=None,
             fresh=False, fake=False, check=False, max_dollars=None, split=None,
             effort=None, pick="first", book=None, scene=None):
    """Возвращает {stage: ran|cached|failed|blocked}."""
    stages = stages or default_stages()
    run_dir = Path(run_dir)
    run_dir.mkdir(parents=True, exist_ok=True)
    shares = dict(split) if isinstance(split, dict) else parse_split(split)
    _validate_split(shares)
    if max_dollars is not None:
        try:
            _finite = math.isfinite(max_dollars)
        except TypeError:
            raise ValueError(f"invalid max_dollars: {max_dollars!r}")
        if not _finite:
            raise ValueError(f"invalid max_dollars: {max_dollars!r}")
    opts = {"fake": bool(fake), "prompt": prompt, "pick": pick, "effort": effort,
            "book": str(book) if book else None, "scene": scene}

    enabled = {k for k, s in stages.items() if not s.optional or check}
    forced = set()
    if only:
        sel = {only}
    elif from_:
        forced = {from_} | (_descendants(stages, from_) & enabled)
        sel = set(forced)
    elif until:
        sel = ({until} | _ancestors(stages, until)) & enabled
    else:
        sel = set(enabled)

    with _Lock(run_dir / ".lock"):
        man = _Manifest(run_dir, prompt)
        opts["prompt"] = man.data.get("prompt")
        need = set()
        for sid in sel:
            need |= _ancestors(stages, sid)
        # сначала прямые входы, потом дальние предки
        direct = [d for sid in sorted(sel) for d in stages[sid].deps]
        order = {d: i for i, d in reversed(list(enumerate(direct)))}
        for dep in sorted(need - sel, key=lambda d: (order.get(d, len(order)), d)):
            mk = run_dir / dep / stages[dep].marker
            if man.get(dep).get("status") != "ok" or not mk.is_file():
                raise MissingInput(f"missing input: {dep}/{stages[dep].marker}")

        results = {}

        def execute(sid):
            st = stages[sid]
            inputs = []
            for dep in sorted(_ancestors(stages, sid)):
                base = run_dir / dep
                for p in sorted(base.rglob("*")):
                    if p.is_file():
                        inputs.append([p.relative_to(run_dir).as_posix(), _sha_file(p)])
            cap = None
            if max_dollars is not None:
                cap = max_dollars * shares.get(sid, 0) / 100
            o = dict(opts, cap=cap)
            params = {k: o.get(k) for k in st.params
                      if k not in OPTIONAL_PARAMS or o.get(k) is not None}
            if max_dollars is not None and "cap" not in params:
                params["cap"] = cap
            h = input_hash(sid, st.version, params, inputs)
            rec = man.get(sid)
            if (sid not in forced and rec.get("status") == "ok"
                    and rec.get("input_hash") == h and (run_dir / sid).is_dir()):
                return "cached"
            tmp = run_dir / f"{sid}.tmp"
            base_rec = {"input_hash": h, "version": st.version}
            if max_dollars is not None and man.spent() >= max_dollars:
                man.put(sid, dict(base_rec, status="failed", reason="budget",
                                  usd=float(rec.get("usd") or 0.0)))
                return "failed"
            resume = False
            if tmp.exists():
                if sid in KEEP_TMP and not fresh:
                    resume = True
                else:
                    shutil.rmtree(tmp)
            tmp.mkdir(exist_ok=True)
            started = time.time()
            man.put(sid, dict(base_rec, status="running", started=started))
            ctx = Ctx(run_dir, tmp, params, resume, cap, o)
            try:
                ret = st.fn(ctx)
            except Exception as e:
                man.put(sid, dict(base_rec, status="failed", reason="error",
                                  error=f"{type(e).__name__}: {e}", usd=ctx.usd,
                                  started=started, finished=time.time()))
                return "failed"
            # возврат стадии и ctx.spend — оба итог трат; берём больший
            usd = max(ctx.usd, float(ret or 0.0))
            _publish(run_dir, sid, tmp)
            man.put(sid, dict(base_rec, status="ok", started=started,
                              finished=time.time(), usd=usd))
            return "ran"

        pending = set(sel)
        running = {}
        with cf.ThreadPoolExecutor(max_workers=max(1, len(sel))) as ex:
            while pending or running:
                for sid in sorted(pending):
                    deps = [d for d in stages[sid].deps if d in sel]
                    if any(results.get(d) in ("failed", "blocked") for d in deps):
                        results[sid] = "blocked"
                        pending.discard(sid)
                    elif all(d in results for d in deps):
                        pending.discard(sid)
                        running[ex.submit(execute, sid)] = sid
                if not running:
                    continue
                done, _ = cf.wait(running, return_when=cf.FIRST_COMPLETED)
                for f in done:
                    results[running.pop(f)] = f.result()
        return results
