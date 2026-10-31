"""Comic viewer server: comic.html, run files, SSE log stream, /say /event /stop (spec 11, 5a).
usage: python3 h0/dream/server.py --port 8770          # replay finished runs
       python3 h0/dream/sim.py --profile A --serve      # live dream + viewer
open:  http://localhost:8770/?run=A/<run>
"""

import argparse
import json
import mimetypes
import os
import random
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

from diagnostics import panel_state
from inputs import sanitize

HERE = os.path.dirname(os.path.abspath(__file__))
COMIC = os.path.join(HERE, "comic.html")
AB_PAGE = os.path.join(HERE, "ab.html")
OUT_ROOT = os.path.realpath(os.path.join(HERE, "..", "out", "dream"))
SNAPSHOT_EVERY = 30.0
POLL = 0.2
KEEPALIVE = 15.0
MAX_BODY = 16384


def _run_dir(run, root=OUT_ROOT):
    """'<profile>/<run>' -> its directory under root, or None (no traversal)."""
    if not run or "\x00" in run:
        return None
    parts = [p for p in run.strip("/").split("/") if p]
    if len(parts) != 2 or any(p in (".", "..") for p in parts):
        return None
    path = os.path.realpath(os.path.join(root, *parts))
    if os.path.dirname(os.path.dirname(path)) != root or not os.path.isdir(path):
        return None
    return path


def _inside(path, base):
    path = os.path.realpath(path)
    return path == base or path.startswith(base + os.sep)


def read_rows(logpath, offset=0):
    """Complete jsonl rows from offset -> (rows, new_offset); a half-written last
    line waits for the next read."""
    try:
        with open(logpath, "rb") as f:
            f.seek(offset)
            data = f.read()
    except OSError:
        return [], offset
    end = data.rfind(b"\n")
    if end < 0:
        return [], offset
    rows = []
    for raw in data[:end].split(b"\n"):
        if raw.strip():
            try:
                rows.append(json.loads(raw))
            except ValueError:
                pass
    return rows, offset + end + 1


def fold_snapshot(rows):
    """State for a reconnect mid-build from the log alone (replay / no live sim)."""
    snap = {"type": "snapshot", "live": False, "build_state": "idle",
            "hero_owner": "npc"}
    for r in rows:
        k = r.get("type")
        if k == "snapshot":
            for key in ("scene", "actors", "place", "hero", "speed", "max_dollars",
                        "profile", "hero_owner"):
                if key in r:
                    snap[key] = r[key]
        elif k == "build":
            if r.get("phase") == "start":
                snap.update(build_state="building", bridge=r.get("bridge"),
                            destination=r.get("destination"), build_start=r.get("t"))
            elif r.get("phase") == "abort":
                snap.update(build_state="idle", bridge=None, destination=None, build_start=None)
        elif k == "ready":
            snap["build_state"] = "ready"
        elif k == "transition":
            snap.update(build_state="idle", bridge=None, destination=None, build_start=None)
        elif k == "cost":
            snap["dollars"] = r.get("dollars")
        elif k == "pov":
            if r.get("hero_owner") in ("npc", "human"):
                snap["hero_owner"] = r["hero_owner"]
        elif k in ("stop", "wake_up"):
            snap["ended"] = k
        if "seq" in r:
            snap["seq"] = r["seq"]
        if "t" in r:
            snap["t"] = r["t"]
    return snap


class Viewer:
    """Shared server state: the live sim (or none), its run name, the port."""

    def __init__(self, sim=None, run=None, root=OUT_ROOT, snapshot_every=SNAPSHOT_EVERY):
        self.sim = sim
        self.run = run
        self.root = os.path.realpath(root)
        self.snapshot_every = snapshot_every
        self.port = None
        self.httpd = None
        self.thread = None
        # blind A/B: the A/B order of every pair is drawn from this salt, fixed for
        # the server's life so the page and the verdict agree, fresh on each start
        self.ab_salt = "%016x" % random.getrandbits(64)

    def allowed_hosts(self):
        return {"127.0.0.1:%d" % self.port, "localhost:%d" % self.port}

    def start(self, port=0):
        viewer = self

        class Handler(ViewerHandler):
            pass
        Handler.viewer = viewer
        self.httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
        self.httpd.daemon_threads = True
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        return self.port

    def stop(self):
        if self.httpd is not None:
            self.httpd.shutdown()
            self.httpd.server_close()
            self.httpd = None


class ViewerHandler(BaseHTTPRequestHandler):
    viewer = None
    protocol_version = "HTTP/1.1"
    server_version = "dream"
    sys_version = ""

    def log_message(self, fmt, *args):  # quiet: the dream log is the record
        pass

    # --- guards ----------------------------------------------------------
    def _engine_origin(self, origin):
        """The 3D engine page runs on another loopback port (?sim=...), so a
        local engine origin is one of us; anything off-loopback is foreign."""
        if not origin:
            return False
        u = urlparse(origin)
        return (u.scheme == "http" and u.hostname in ("127.0.0.1", "localhost")
                and u.port is not None and not u.path and not u.query)

    def _guard(self):
        """Spec 11: only our own address; a foreign tab must not spend credits."""
        host = self.headers.get("Host", "")
        origin = self.headers.get("Origin")
        ok = host in self.viewer.allowed_hosts()
        if origin is not None:
            ok = ok and (origin in {"http://" + h for h in self.viewer.allowed_hosts()}
                         or self._engine_origin(origin))
        if not ok:
            self._send(403, {"error": "forbidden"})
        return ok

    def _cors(self):
        """Echo an allowed engine origin so the page on another loopback port
        can read SSE and POST; foreign origins never reach here (_guard)."""
        origin = self.headers.get("Origin")
        if origin is not None and (origin in {"http://" + h for h in self.viewer.allowed_hosts()}
                                    or self._engine_origin(origin)):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")

    def _send(self, code, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self._cors()
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def _not_found(self):
        self._send(404, {"error": "not found"})

    # --- GET ---------------------------------------------------------------
    def do_GET(self):
        if not self._guard():
            return
        url = urlparse(self.path)
        q = parse_qs(url.query)
        path = unquote(url.path)
        if path in ("/", "/comic.html"):
            with open(COMIC, "rb") as f:
                return self._send(200, f.read(), "text/html; charset=utf-8")
        if path == "/api/status":
            return self._send(200, {"live": self.viewer.run if self.viewer.sim else None})
        if path == "/api/hero":
            return self._hero()
        if path == "/api/runs":
            return self._send(200, {"runs": self._runs()})
        if path in ("/ab", "/ab.html"):
            with open(AB_PAGE, "rb") as f:
                return self._send(200, f.read(), "text/html; charset=utf-8")
        if path == "/api/ab":
            return self._send(200, self._ab_state())
        if path == "/api/panel":
            return self._panel(q)
        if path == "/events":
            return self._events(q)
        if path.startswith("/out/"):
            return self._static(path[len("/out/"):])
        return self._not_found()

    def _hero(self):
        """Spec 9, 2.1: what the hero himself knows, read off the live dream --
        his diary and the facts not hidden from him. The log would only tell us
        what has already been said."""
        sim = self.viewer.sim
        if sim is None:
            return self._send(409, {"error": "no live dream"})
        # 2.1: seq first, owner second (see Sim.status): the owner can then only be
        # as new as the log at seq or newer, never older, so the viewer's
        # "apply only seq > last" rule cannot drop the pov row that changed it
        log = getattr(sim, "logger", None)
        seq = getattr(log, "seq", 0) or 0
        owner = getattr(sim, "hero_owner", "npc")
        prof = getattr(getattr(sim, "dialogue", None), "profile", None)
        if not prof:
            from sim import load_profile
            prof = load_profile(sim.profile)
        # a scene hero keeps his soul in its own dict (scenes/roof3.json)
        soul = prof.get("soul") if isinstance(prof.get("soul"), dict) else prof
        facts = [f.get("text") for f in soul.get("facts") or []
                 if isinstance(f, dict) and not f.get("hidden_from_hero") and f.get("text")]
        diary = [soul["diary"]] if soul.get("diary") else []
        # `seq` is the log position this answer speaks for: the viewer orders it
        # against snapshot/pov rows by seq, so neither side can overrule a newer one
        return self._send(200, {"facts": facts, "diary": diary,
                                "hero_owner": owner, "seq": seq})

    def _panel(self, q):
        """Director panel (2.3): Python folds the whole log, the page only draws.
        Same run guard as /events -- a path outside the base is a 404."""
        run = (q.get("run") or [self.viewer.run or ""])[0]
        base = _run_dir(run, self.viewer.root)
        if base is None:
            return self._not_found()
        rows, _ = read_rows(os.path.join(base, "log.jsonl"))
        return self._send(200, panel_state(rows))

    # --- blind A/B (Oct 29): the owner judges pairs of runs with the labels hidden
    def _ab_pairs(self):
        """<root>/ab/pairs.json: [{"id", "runs": {"<profile>/<run>": "<label>"}}]."""
        path = os.path.join(self.viewer.root, "ab", "pairs.json")
        if not os.path.isfile(path):
            return []
        with open(path, encoding="utf-8") as f:
            pairs = json.load(f)
        return [p for p in pairs if isinstance(p, dict) and p.get("id")
                and isinstance(p.get("runs"), dict) and len(p["runs"]) == 2]

    def _ab_verdicts(self):
        path = os.path.join(self.viewer.root, "ab", "verdicts.jsonl")
        return read_rows(path)[0] if os.path.isfile(path) else []

    def _ab_order(self, pair):
        """A and B for a pair: the two runs, shuffled by the server's salt."""
        runs = sorted(pair["runs"])
        if random.Random(self.viewer.ab_salt + pair["id"]).random() < 0.5:
            runs.reverse()
        return runs

    def _ab_state(self):
        pairs = self._ab_pairs()
        if not pairs:
            return {"pairs": []}
        judged = {v.get("id"): v for v in self._ab_verdicts()}
        out = []
        for p in pairs:
            a, b = self._ab_order(p)
            out.append({"id": p["id"], "a": a, "b": b, "done": p["id"] in judged})
        state = {"pairs": out}
        if all(o["done"] for o in out):
            # the tally shows only when every pair is judged: no peeking mid-way
            labels = sorted({l for p in pairs for l in p["runs"].values()})
            tally = {l: 0 for l in labels}
            tally["same"] = 0
            for p in pairs:
                w = judged[p["id"]].get("winner")
                tally[w if w in tally else "same"] += 1
            state["summary"] = tally
        return state

    def _ab_verdict(self, body):
        pairs = {p["id"]: p for p in self._ab_pairs()}
        p = pairs.get(body.get("id"))
        pick = body.get("pick")
        if p is None or pick not in ("a", "b", "same"):
            return self._send(400, {"error": "unknown pair or pick"})
        a, b = body.get("a"), body.get("b")
        if {a, b} != set(p["runs"]) or a == b:
            return self._send(400, {"error": "runs do not match the pair"})
        row = {"t": time.time(), "id": p["id"], "pick": pick, "a": a, "b": b,
               "a_label": p["runs"][a], "b_label": p["runs"][b],
               "winner": {"a": p["runs"][a], "b": p["runs"][b]}.get(pick, "same")}
        d = os.path.join(self.viewer.root, "ab")
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "verdicts.jsonl"), "a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
        done = len({v.get("id") for v in self._ab_verdicts()} & set(pairs))
        return self._send(200, {"ok": True, "done": done, "total": len(pairs)})

    def _runs(self):
        out = []
        root = self.viewer.root
        for prof in sorted(os.listdir(root)) if os.path.isdir(root) else []:
            pdir = os.path.join(root, prof)
            if not os.path.isdir(pdir) or prof == "checks":
                continue
            for run in sorted(os.listdir(pdir), reverse=True):
                if os.path.isfile(os.path.join(pdir, run, "log.jsonl")):
                    out.append("%s/%s" % (prof, run))
        return out[:200]

    def _static(self, rest):
        """Only files of one run: /out/<profile>/<run>/<file...>; anything else 404."""
        parts = rest.split("/")
        if len(parts) < 3 or "\x00" in rest or any(p in ("", ".", "..") for p in parts):
            return self._not_found()
        base = _run_dir("/".join(parts[:2]), self.viewer.root)
        if base is None:
            return self._not_found()
        target = os.path.join(base, *parts[2:])
        if not _inside(target, base) or not os.path.isfile(target):
            return self._not_found()
        ctype = mimetypes.guess_type(target)[0] or "application/octet-stream"
        if target.endswith(".jsonl"):
            ctype = "application/x-ndjson"
        with open(target, "rb") as f:
            return self._send(200, f.read(), ctype)

    def _events(self, q):
        """SSE: log rows with seq >= from_seq (or Last-Event-ID + 1), then a tail;
        a snapshot every snapshot_every seconds lets a reconnect land mid-build."""
        run = (q.get("run") or [self.viewer.run or ""])[0]
        base = _run_dir(run, self.viewer.root)
        if base is None:
            return self._not_found()
        try:
            from_seq = int((q.get("from_seq") or ["0"])[0])
        except ValueError:
            return self._send(400, {"error": "from_seq"})
        last_id = self.headers.get("Last-Event-ID")
        if last_id and last_id.isdigit():
            from_seq = max(from_seq, int(last_id) + 1)
        live = self.viewer.sim is not None and run == self.viewer.run
        logpath = os.path.join(base, "log.jsonl")
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self._cors()
        self.end_headers()
        self.close_connection = True
        offset, seen = 0, []
        last_snap = last_beat = time.monotonic()
        try:
            while True:
                rows, offset = read_rows(logpath, offset)
                seen.extend(rows)
                for r in rows:
                    if r.get("seq", 0) >= from_seq:
                        self._sse(r, r.get("seq"))
                now = time.monotonic()
                if now - last_snap >= self.viewer.snapshot_every:
                    last_snap = now
                    snap = self.viewer.sim.status() if live else fold_snapshot(seen)
                    self._sse(snap, event="snapshot")
                if not live and not rows:
                    self._sse({"type": "end"}, event="end")
                    return
                if live and self.viewer.sim.stopped and not rows:
                    self._sse({"type": "end"}, event="end")
                    return
                if now - last_beat >= KEEPALIVE:
                    last_beat = now
                    self.wfile.write(b": keepalive\n\n")
                    self.wfile.flush()
                time.sleep(POLL)
        except (BrokenPipeError, ConnectionResetError, OSError):
            return

    def _sse(self, obj, sid=None, event=None):
        chunk = ""
        if event:
            chunk += "event: %s\n" % event
        if sid is not None:
            chunk += "id: %d\n" % sid
        chunk += "data: %s\n\n" % json.dumps(obj, ensure_ascii=False)
        self.wfile.write(chunk.encode())
        self.wfile.flush()

    # --- POST --------------------------------------------------------------
    def do_OPTIONS(self):
        """Preflight for the engine's JSON POSTs from another loopback port."""
        host = self.headers.get("Host", "")
        origin = self.headers.get("Origin")
        if host not in self.viewer.allowed_hosts():
            return self._send(403, {"error": "forbidden"})
        if origin is None or not (origin in {"http://" + h for h in self.viewer.allowed_hosts()}
                                   or self._engine_origin(origin)):
            return self._send(403, {"error": "forbidden"})
        if urlparse(self.path).path not in ("/say", "/event", "/pov", "/continue", "/stop", "/freestyle", "/api/ab"):
            return self._not_found()
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "content-type")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        if not self._guard():
            return
        ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if ctype != "application/json":
            return self._send(415, {"error": "application/json only"})
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = -1
        if n < 0 or n > MAX_BODY:
            return self._send(400, {"error": "body size"})
        try:
            body = json.loads(self.rfile.read(n) or b"{}")
        except ValueError:
            return self._send(400, {"error": "bad json"})
        if not isinstance(body, dict):
            return self._send(400, {"error": "json object expected"})
        path = urlparse(self.path).path
        if path == "/api/ab":
            return self._ab_verdict(body)
        sim = self.viewer.sim
        if path not in ("/say", "/event", "/pov", "/continue", "/stop", "/freestyle"):
            return self._not_found()
        if sim is None:
            return self._send(409, {"error": "no live dream"})
        if path == "/say":
            raw = str(body.get("text") or "")[:2000]
            text = sanitize(raw, "human")[0]
            if not text:
                return self._send(400, {"error": "empty text"})
            # the sim sanitizes again and logs what it cut (input_rejected, spec 5a)
            sim.submit("say", raw)
            return self._send(200, {"ok": True, "text": text})
        if path == "/pov":
            owner = body.get("hero_owner")
            if owner not in ("npc", "human"):
                return self._send(400, {"error": "hero_owner must be npc or human"})
            sim.submit("pov", owner)
            return self._send(200, {"ok": True, "hero_owner": owner})
        if path == "/freestyle":
            # book -> freestyle: the score stops, the same cast improvises on
            sim.submit("freestyle")
            return self._send(200, {"ok": True})
        if path == "/continue":
            # 2.2: the only way out of a safety pause; the sim resumes on its next tick
            sim.submit("continue")
            return self._send(200, {"ok": True})
        if path == "/event":
            # the 3D engine's door_touch (phase G2): the hero touches a door,
            # which the sim reads as an input event naming the door
            if body.get("type") == "touch" and body.get("object"):
                ev = {"source": "touch", "value": str(body.get("object"))[:200]}
                if body.get("outcome") is not None:
                    ev["outcome"] = body.get("outcome")
                sim.submit("event", ev)
                return self._send(200, {"ok": True})
            if not body.get("value"):
                return self._send(400, {"error": "value required"})
            ev = {k: body.get(k) for k in ("source", "value", "outcome") if body.get(k) is not None}
            sim.submit("event", ev)
            return self._send(200, {"ok": True})
        sim.submit("stop")
        return self._send(200, {"ok": True})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8770)
    args = ap.parse_args()
    viewer = Viewer()
    port = viewer.start(args.port)
    print("replay viewer: http://localhost:%d/" % port, flush=True)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        viewer.stop()


if __name__ == "__main__":
    main()
