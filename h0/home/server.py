"""Dreamer Home: one page with our ready scenes (book / freestyle) and "create your own".

  cd h0 && python3 -m home [--port 8800] [--fake]
  open http://localhost:8800/

Home only launches and frames: a scene is make.play / place.serve in its own process group, a guest
scene is `python -m make` into runs/home-<ts>/. The page never sends a path, only ids from the catalog.
"""
import json
import mimetypes
import re
import shutil
import threading
import time
import unicodedata
import urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from . import catalog, session, write

STATIC = Path(__file__).with_name("static")
FAKE_SCENE = Path(__file__).with_name("testdata") / "fake_scene.py"
FAKE_ASR_TEXT = "a quiet library at night, rain on the windows, and a cat asleep on the desk"
MAX_PROMPT = 600
MAX_BODY = 4096
MAX_WAV = 20_000_000
MAX_DOLLARS = 1


def clean_prompt(text):
    """one line of plain text: control characters out, whitespace squeezed, cut to MAX_PROMPT"""
    if not isinstance(text, str):
        return ""
    t = "".join(" " if unicodedata.category(ch)[0] == "C" else ch for ch in text)
    return re.sub(r"\s+", " ", t).strip()[:MAX_PROMPT]


class Home:
    """state shared by the handler threads"""

    def __init__(self, fake=False, catalog_path=catalog.CATALOG, root=catalog.ROOT, runs=None, port=0):
        self.fake = fake
        self.catalog_path = catalog_path
        self.root = root
        self.runs = Path(runs) if runs else catalog.RUNS
        self.port = port
        self.scene = session.Scene()
        self.build = session.Build()
        self.create_mu = threading.Lock()
        self.ask = None          # tests: ask(system, user) -> text instead of Spark

    def cat(self):
        return catalog.load(self.catalog_path, self.root)

    def mine(self):
        return catalog.mine(self.runs)

    def entry(self, sid):
        """a catalog scene or a guest scene by id -> entry or None"""
        if not isinstance(sid, str):
            return None
        if catalog.RUN_ID.fullmatch(sid):
            return next((m for m in self.mine() if m["id"] == sid), None)
        return next((s for s in self.cat()["scenes"] if s["id"] == sid), None)

    def scene_argv(self, e, mode):
        py = session.python()
        if self.fake:
            return [py, str(FAKE_SCENE), "http://127.0.0.1:%d/fake/scene.html?id=%s&mode=%s" % (self.port, e["id"], mode)]
        if e["kind"] == "place":
            return [py, "-m", "place.serve", str(e["_run"]), "--port", str(session.free_port())]
        argv = [py, "-m", "make.play", str(e["_run"]), "--port", str(session.free_port()),
                "--static-port", str(session.free_port())]
        return argv + (["--freestyle"] if mode == "freestyle" else [])

    def play(self, e, mode):
        """start the scene; one retry with fresh ports when it dies at once (another process took a port)"""
        try:
            return self.scene.start(e["id"], mode, self.scene_argv(e, mode))
        except session.LaunchError as ex:
            if ex.code != 502 or not any("Address already in use" in l for l in session.tail(ex.log, 40)):
                raise
            return self.scene.start(e["id"], mode, self.scene_argv(e, mode))

    def build_argv(self, run, prompt, world):
        argv = [session.python(), "-m", "make", prompt, "--book", str(run / "book"), "--scene", write.SCENE_ID,
                "--world", str(world["_dir"]), "--run", str(run), "--max-dollars", str(MAX_DOLLARS)]
        return argv + (["--fake"] if self.fake else [])

    def world(self, wid):
        return next((w for w in self.cat()["worlds"] if w.get("id") == wid), None) if isinstance(wid, str) else None

    def create(self, prompt, world_id):
        """-> run_id; the chapter is written and make is started in the Build slot's thread"""
        if not self.cat()["create"]:
            raise session.LaunchError("create is switched off in scenes.json", code=403)
        world = self.world(world_id)
        if world is None or not world["ready"]:
            raise session.LaunchError("unknown world", code=400)
        with self.create_mu:
            if self.build.busy():
                raise session.LaunchError("a build is already running", code=429)
            self.runs.mkdir(parents=True, exist_ok=True)
            run = self.runs / ("home-" + time.strftime("%Y%m%d-%H%M%S"))
            while run.exists():
                time.sleep(0.2)
                run = self.runs / ("home-" + time.strftime("%Y%m%d-%H%M%S"))
            run.mkdir()
            h = {"prompt": prompt, "title": prompt[:60], "world": world_id,
                 "created": time.strftime("%Y-%m-%dT%H:%M:%S"), "chapter": {"status": "running"}}
            _write_home(run, h)
            self.build.begin(run, lambda: self._build(run, prompt, world, h))
        return run.name

    def _build(self, run, prompt, world, h):
        """Build-slot thread: chapter -> book -> cast.src -> make"""
        t = time.time()
        try:
            ans = write.write_chapter(prompt, world, fake=self.fake, ask=self.ask)
            book = write.write_book(ans, world, run / "book")
            shutil.copytree(world["_cast"], run / "cast.src", ignore=shutil.ignore_patterns("marker.txt"))
        except Exception as e:  # noqa: BLE001 — the reason goes to the page
            h["chapter"] = {"status": "failed", "seconds": round(time.time() - t, 1), "error": str(e)[:300]}
            _write_home(run, h)
            return None
        h["chapter"] = {"status": "ok", "seconds": round(time.time() - t, 1)}
        h["title"] = book["title"]
        h["room"] = ans["room"]
        _write_home(run, h)
        return self.build_argv(run, prompt, world)

    def build_status(self, run_id):
        if not isinstance(run_id, str) or not catalog.RUN_ID.fullmatch(run_id):
            return None
        run = self.runs / run_id
        if not run.is_dir():
            return None
        alive, code = self.build.state(run)
        st = catalog.build_status(run, alive, code)
        h = catalog.home_json(run)
        ch = h.get("chapter") or {}
        chap = {"name": "chapter", "status": ch.get("status") or "waiting", "seconds": ch.get("seconds"),
                "usd": 0.0, "error": ch.get("error")}
        st["stages"] = [chap] + st["stages"]
        if chap["status"] == "failed":
            st["status"], st["error"] = "failed", chap["error"]
        elif alive and st["status"] != "failed":
            st["status"] = "running"
        try:
            created = time.mktime(time.strptime(h.get("created", ""), "%Y-%m-%dT%H:%M:%S"))
            end = time.time() if alive else max([created + (chap["seconds"] or 0)] + [
                s0 for s0 in (_finished(run, x["name"]) for x in st["stages"][1:]) if s0])
            st["seconds"] = round(end - created)
        except ValueError:
            st["seconds"] = None
        st["prompt"], st["title"], st["world"] = h.get("prompt"), h.get("title"), h.get("world")
        return st

    def shutdown(self):
        self.scene.stop()
        self.build.stop()


def _finished(run, sid):
    try:
        return (json.loads((run / "make.json").read_text()).get("stages") or {}).get(sid, {}).get("finished")
    except (OSError, ValueError):
        return None


def _write_home(run, h):
    tmp = run / "home.json.tmp"
    tmp.write_text(json.dumps(h, ensure_ascii=False, indent=2))
    tmp.replace(run / "home.json")


def _mine_public(m, worlds):
    """a guest scene: its own shot if the world had one, else the world's cover"""
    p = _scene_public(m)
    if not p["cover_url"]:
        w = next((x for x in worlds if x["id"] == m.get("world") and x.get("_cover")), None)
        p["cover_url"] = "/wcover/%s" % w["id"] if w else None
    return p


def _scene_public(s):
    p = catalog.public(s)
    p["cover_url"] = "/cover/%s" % s["id"] if s.get("_cover") else None
    return p


def make_handler(home: Home):
    class H(SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _json(self, obj, code=200):
            b = json.dumps(obj, ensure_ascii=False).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(b)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(b)

        def _file(self, p: Path):
            if p is None or not Path(p).is_file():
                return self._json({"error": "not found"}, 404)
            b = Path(p).read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", mimetypes.guess_type(str(p))[0] or "application/octet-stream")
            self.send_header("Content-Length", str(len(b)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(b)

        def _local_host(self):
            return (self.headers.get("Host") or "").split(":")[0] in ("localhost", "127.0.0.1")

        def _same_origin(self, ctype):
            """only this page may start processes and spend money (as place.serve): local Host, our Origin
            if one is sent, and a non-simple Content-Type, which forces a CORS preflight nobody answers"""
            port = self.server.server_address[1]
            origin = self.headers.get("Origin")
            ok_origin = origin is None or origin in ("http://localhost:%d" % port, "http://127.0.0.1:%d" % port)
            return self._local_host() and ok_origin and (self.headers.get("Content-Type") or "").startswith(ctype)

        def do_GET(self):
            if not self._local_host():
                return self._json({"error": "forbidden"}, 403)   # DNS rebinding
            path = urllib.parse.urlsplit(self.path).path
            if path in ("/", "/index.html"):
                return self._file(STATIC / "index.html")
            if path.startswith("/static/"):
                p = (STATIC / urllib.parse.unquote(path[8:])).resolve()
                return self._file(p if p.is_relative_to(STATIC.resolve()) else None)
            if path == "/fake/scene.html" and home.fake:
                return self._file(Path(__file__).with_name("testdata") / "fake_scene.html")
            if path == "/api/scenes":
                c = home.cat()
                building = home.build.run.name if home.build.busy() and home.build.run else None
                return self._json({
                    "scenes": [_scene_public(s) for s in c["scenes"]],
                    "worlds": [{"id": w["id"], "title": w.get("title"), "blurb": w.get("blurb"), "who": w["who"],
                                "cover_url": "/wcover/%s" % w["id"] if w.get("_cover") else None}
                               for w in c["worlds"] if w["ready"]],
                    "mine": [_mine_public(m, c["worlds"]) for m in home.mine()],
                    "session": home.scene.current() and {k: v for k, v in home.scene.current().items() if k != "log"},
                    "building": building, "fake": home.fake, "create": c["create"]})
            if path.startswith("/wcover/"):
                w = home.world(path[8:])
                return self._file(w.get("_cover") if w else None)
            if path == "/api/session":
                return self._json(home.scene.status())
            if path.startswith("/cover/"):
                e = home.entry(path[7:])
                return self._file(e.get("_cover") if e else None)
            if path.startswith("/api/create/"):
                st = home.build_status(path[12:])
                return self._json(st) if st else self._json({"error": "unknown build"}, 404)
            return self._json({"error": "not found"}, 404)

        def _body(self, limit):
            n = int(self.headers.get("Content-Length") or 0)
            if n > limit:
                return None
            return self.rfile.read(n)

        def do_POST(self):
            path = urllib.parse.urlsplit(self.path).path
            wav = path == "/api/asr"
            body = self._body(MAX_WAV if wav else MAX_BODY)
            if body is None:
                return self._json({"error": "body too large"}, 413)
            if not self._same_origin("audio/wav" if wav else "application/json"):
                return self._json({"error": "forbidden"}, 403)
            if wav:
                if home.fake:
                    return self._json({"text": FAKE_ASR_TEXT, "s": 0.0})
                t = time.time()
                try:
                    from place.serve import asr
                    text = asr(body)
                except Exception as e:  # noqa: BLE001 — the page shows the reason, the user can type instead
                    return self._json({"error": "voice: %s" % str(e)[:200]}, 502)
                return self._json({"text": text, "s": round(time.time() - t, 2)})
            try:
                req = json.loads(body or b"{}")
                if not isinstance(req, dict):
                    raise ValueError
            except ValueError:
                return self._json({"error": "bad json"}, 400)
            if path == "/api/play":
                e = home.entry(req.get("id"))
                mode = req.get("mode")
                if e is None:
                    return self._json({"error": "unknown scene"}, 404)
                if mode not in e["modes"]:
                    return self._json({"error": "this scene has no %s mode" % mode}, 400)
                if not e["ready"]:
                    return self._json({"error": "not ready: %s" % e.get("why")}, 409)
                try:
                    url = home.play(e, mode)
                except session.LaunchError as ex:
                    return self._json({"error": str(ex), "log": session.tail(ex.log) if ex.log else []}, ex.code)
                return self._json({"url": url, "id": e["id"], "mode": mode})
            if path == "/api/stop":
                home.scene.stop()
                return self._json({"ok": True})
            if path == "/api/create":
                prompt = clean_prompt(req.get("prompt"))
                if len(prompt) < 8:
                    return self._json({"error": "say a little more about the scene"}, 400)
                try:
                    run_id = home.create(prompt, req.get("world"))
                except session.LaunchError as ex:
                    return self._json({"error": str(ex)}, ex.code)
                return self._json({"run_id": run_id})
            return self._json({"error": "not found"}, 404)

    return H


def serve(port=8800, fake=False, **kw):
    """-> (server, home); the caller runs serve_forever"""
    home = Home(fake=fake, **kw)
    srv = ThreadingHTTPServer(("127.0.0.1", port), make_handler(home))
    home.port = srv.server_address[1]
    return srv, home
