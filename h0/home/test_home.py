"""Dreamer Home: catalog, process slots, API, chapter writer.  cd h0 && python3 -m unittest home.test_home

No network: scenes are the fake stub, builds are `make --fake`, the chapter is canned or a scripted ask().
The real catalog is read (read-only); every write goes to a temp runs/ folder.
"""
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from home import catalog, server, session, write

PY = sys.executable


def _alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    # a zombie still answers kill(0); ask ps for its state
    st = os.popen("ps -o stat= -p %d" % pid).read().strip()
    return bool(st) and not st.startswith("Z")


def _wait_dead(pid, s=5.0):
    end = time.time() + s
    while time.time() < end:
        if not _alive(pid):
            return True
        time.sleep(0.05)
    return False


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="home-test-"))
        self.runs = self.tmp / "runs"
        self.srv, self.home = server.serve(0, fake=True, runs=self.runs)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.url = "http://127.0.0.1:%d" % self.srv.server_address[1]

    def tearDown(self):
        self.home.shutdown()
        self.srv.shutdown()
        self.srv.server_close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def req(self, path, body=None, ctype="application/json", headers=None, raw=None):
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        h = dict(headers or {})
        if data is not None and ctype:
            h["Content-Type"] = ctype
        r = urllib.request.Request(self.url + path, data=data, headers=h)
        try:
            with urllib.request.urlopen(r, timeout=30) as resp:
                return resp.status, json.loads(resp.read() or b"{}")
        except urllib.error.HTTPError as e:
            b = e.read()
            e.close()
            try:
                return e.code, json.loads(b)
            except ValueError:
                return e.code, {"raw": b.decode(errors="replace")}


class TestCatalog(unittest.TestCase):
    def test_real_catalog_ready(self):
        c = catalog.load()
        ids = {s["id"]: s for s in c["scenes"]}
        self.assertTrue({"koshakan-bedroom", "sherlock-221b", "kozb7-yard"} <= set(ids))
        for s in c["scenes"]:
            self.assertTrue(s["ready"], (s["id"], s["why"]))
            self.assertIsNotNone(s["_cover"], s["id"])
        self.assertEqual(ids["kozb7-yard"]["modes"], ["freestyle"])
        self.assertTrue(all(w["ready"] for w in c["worlds"]), [(w["id"], w["why"]) for w in c["worlds"]])

    def _one(self, **e):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, True)
        base = {"id": "x", "title": "X", "kind": "play", "modes": ["book"], "run": "runs/nope"}
        base.update(e)
        (tmp / "s.json").write_text(json.dumps({"scenes": [base], "worlds": []}))
        return catalog.load(tmp / "s.json")["scenes"]

    def test_missing_run_not_ready(self):
        s = self._one()
        self.assertEqual(len(s), 1)
        self.assertFalse(s[0]["ready"])
        self.assertIn("missing", s[0]["why"])

    def test_path_out_of_workspace_refused(self):
        for bad in ("../../..", "/etc", "../some-other-repo/runs/x"):
            s = self._one(run=bad)
            self.assertFalse(s[0]["ready"], bad)
            self.assertIn("leaves the workspace", s[0]["why"])

    def test_allowed_siblings(self):
        self.assertTrue(catalog.allowed(catalog.WORKSPACE / "anymove" / "runs"))
        self.assertTrue(catalog.allowed(catalog.WORKSPACE / "meta-place" / "runs"))
        self.assertFalse(catalog.allowed(catalog.WORKSPACE / "career"))

    def test_place_needs_world_dist(self):
        s = self._one(kind="place", modes=["freestyle"], run="runs/yard-kozb7/refs")
        self.assertFalse(s[0]["ready"])

    def test_place_is_freestyle_only(self):
        s = self._one(kind="place", modes=["book", "freestyle"], run="runs/yard-kozb7")
        self.assertFalse(s[0]["ready"])

    def test_guest_like_id_dropped(self):
        self.assertEqual(self._one(id="home-20261104-101010"), [])
        self.assertEqual(self._one(id="../x"), [])

    def test_public_has_no_paths(self):
        for s in catalog.load()["scenes"]:
            self.assertFalse(any(k.startswith("_") for k in catalog.public(s)))


class TestBuildStatus(unittest.TestCase):
    def setUp(self):
        self.run = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.run, True)

    def man(self, stages):
        (self.run / "make.json").write_text(json.dumps({"prompt": "p", "created": "x", "stages": stages}))

    def test_failed_stage_wins(self):
        self.man({"brief": {"status": "ok", "started": 1, "finished": 2}, "refs": {"status": "failed", "error": "E"}})
        st = catalog.build_status(self.run, proc_alive=True)
        self.assertEqual(st["status"], "failed")
        self.assertEqual(st["error"], "E")

    def test_budget_reason(self):
        self.man({"story": {"status": "failed", "reason": "budget"}})
        st = catalog.build_status(self.run)
        self.assertIn("money cap", st["error"])

    def test_running(self):
        self.man({"brief": {"status": "running", "started": time.time() - 3}})
        st = catalog.build_status(self.run, proc_alive=True)
        self.assertEqual(st["status"], "running")
        self.assertGreaterEqual(st["stages"][0]["seconds"], 2.5)

    def test_dead_without_stage(self):
        self.man({"brief": {"status": "ok"}})
        self.assertEqual(catalog.build_status(self.run)["status"], "failed")

    def test_exit_code(self):
        self.man({})
        (self.run / "stage").mkdir()
        (self.run / "stage" / "stage.json").write_text("{}")
        self.assertEqual(catalog.build_status(self.run, exit_code=0)["status"], "ok")
        self.assertEqual(catalog.build_status(self.run, exit_code=2)["status"], "failed")

    def test_stage_order(self):
        self.man({"zz": {"status": "ok"}, "story": {"status": "ok"}})
        names = [s["name"] for s in catalog.build_status(self.run)["stages"]]
        self.assertEqual(names[:7], ["brief", "refs", "world", "cast", "story", "stage", "shotplan"])
        self.assertEqual(names[-1], "zz")


class TestSceneSlot(unittest.TestCase):
    def setUp(self):
        self.s = session.Scene()
        self.addCleanup(self.s.stop)
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def _stub(self):
        """a tiny page server that prints its URL: like make.play"""
        p = self.tmp / "stub.py"
        p.write_text("import http.server,sys,threading\n"
                     "s=http.server.ThreadingHTTPServer(('127.0.0.1',0),http.server.SimpleHTTPRequestHandler)\n"
                     "print('http://127.0.0.1:%d/' % s.server_address[1], flush=True)\n"
                     "s.serve_forever()\n")
        return [PY, str(p)]

    def test_start_and_replace(self):
        u1 = self.s.start("a", "book", self._stub())
        self.assertTrue(u1.startswith("http://127.0.0.1:"))
        pid1 = self.s.proc.pid
        self.s.start("b", "book", self._stub())
        self.assertTrue(_wait_dead(pid1), "the first scene must be stopped")
        self.assertEqual(self.s.current()["id"], "b")

    def test_exit_before_url(self):
        with self.assertRaises(session.LaunchError) as cm:
            self.s.start("a", "book", [PY, "-c", "import sys; print('boom', file=sys.stderr); sys.exit(3)"])
        self.assertEqual(cm.exception.code, 502)
        self.assertIn("boom", "\n".join(session.tail(cm.exception.log)))
        self.assertIsNone(self.s.current())

    def test_exit_right_after_url(self):
        with self.assertRaises(session.LaunchError) as cm:
            self.s.start("a", "book", [PY, "-c", "print('http://127.0.0.1:9/x', flush=True)"])
        self.assertEqual(cm.exception.code, 502)

    def test_no_url_timeout(self):
        with self.assertRaises(session.LaunchError) as cm:
            self.s.start("a", "book", [PY, "-c", "import time; time.sleep(30)"], timeout=0.5)
        self.assertEqual(cm.exception.code, 504)

    def test_died_later_is_reported(self):
        self.s.start("a", "freestyle", self._stub())
        os.killpg(self.s.proc.pid, 9)
        time.sleep(0.3)
        st = self.s.status()
        self.assertFalse(st["alive"])
        self.assertEqual(st["id"], "a")

    def test_stop_kills_group(self):
        self.s.start("a", "book", self._stub())
        pid = self.s.proc.pid
        self.s.stop()
        self.assertTrue(_wait_dead(pid))
        self.assertFalse(self.s.status()["alive"])


class TestApi(Base):
    J = "application/json"

    def test_scenes(self):
        code, d = self.req("/api/scenes")
        self.assertEqual(code, 200)
        self.assertEqual([s["id"] for s in d["scenes"] if "book" in s["modes"]],
                         ["koshakan-bedroom", "koshakan-bathroom", "koshakan-meadow", "sherlock-221b"])
        self.assertEqual(len([s for s in d["scenes"] if "freestyle" in s["modes"]]), 5)
        self.assertTrue(all(s["cover_url"] for s in d["scenes"]))
        self.assertNotIn("/Users/", json.dumps(d))
        self.assertTrue(d["fake"])

    def test_play_stop(self):
        code, d = self.req("/api/play", {"id": "koshakan-bedroom", "mode": "book"})
        self.assertEqual(code, 200, d)
        self.assertIn("mode=book", d["url"])
        pid = self.home.scene.proc.pid
        code, d2 = self.req("/api/play", {"id": "sherlock-221b", "mode": "freestyle"})
        self.assertEqual(code, 200)
        self.assertTrue(_wait_dead(pid))
        code, s = self.req("/api/session")
        self.assertEqual((s["alive"], s["id"], s["mode"]), (True, "sherlock-221b", "freestyle"))
        self.assertEqual(self.req("/api/stop", {})[0], 200)
        self.assertFalse(self.req("/api/session")[1]["alive"])
        self.assertEqual(self.req("/api/stop", {})[0], 200)   # nothing left to stop is fine

    def test_play_errors(self):
        self.assertEqual(self.req("/api/play", {"id": "nope", "mode": "book"})[0], 404)
        self.assertEqual(self.req("/api/play", {"id": "kozb7-yard", "mode": "book"})[0], 400)
        self.assertEqual(self.req("/api/play", raw=b"{oops")[0], 400)
        self.assertEqual(self.req("/api/play", {"id": "../../etc", "mode": "book"})[0], 404)

    def test_origin_and_type(self):
        body = {"id": "koshakan-bedroom", "mode": "book"}
        self.assertEqual(self.req("/api/play", body, headers={"Origin": "http://evil.example"})[0], 403)
        self.assertEqual(self.req("/api/play", body, ctype="text/plain")[0], 403)
        self.assertEqual(self.req("/api/play", body, ctype=None)[0], 403)
        self.assertEqual(self.req("/api/stop", {}, headers={"Host": "evil.example"})[0], 403)
        code, d = self.req("/api/scenes", headers={"Host": "evil.example"})
        self.assertEqual((code, d.get("error")), (403, "forbidden"))
        ok = self.req("/api/stop", {}, headers={"Origin": self.url})
        self.assertEqual(ok[0], 200)

    def test_body_limit(self):
        self.assertEqual(self.req("/api/create", raw=b"{" + b" " * 5000 + b"}")[0], 413)

    def test_static_and_covers(self):
        with urllib.request.urlopen(self.url + "/") as r:
            self.assertIn(b"Step inside a story", r.read())
        self.assertEqual(self.req("/static/..%2f..%2fscenes.json")[0], 404)
        self.assertEqual(self.req("/static/../server.py")[0], 404)
        with urllib.request.urlopen(self.url + "/cover/koshakan-bedroom") as r:
            self.assertEqual(r.headers["Content-Type"], "image/jpeg")
        self.assertEqual(self.req("/cover/..%2fscenes.json")[0], 404)
        self.assertEqual(self.req("/nope")[0], 404)

    def test_asr_fake(self):
        code, d = self.req("/api/asr", raw=b"RIFF....", ctype="audio/wav")
        self.assertEqual(code, 200)
        self.assertTrue(d["text"])
        self.assertEqual(self.req("/api/asr", raw=b"RIFF", ctype="application/json")[0], 403)

    def _wait_build(self, run_id, s=60):
        end = time.time() + s
        while time.time() < end:
            code, st = self.req("/api/create/" + run_id)
            if st.get("status") != "running":
                return st
            time.sleep(0.3)
        self.fail("build did not finish")

    def test_create_end_to_end(self):
        code, d = self.req("/api/create", {"world": "koshakan-house", "prompt": "Mirai finds a lost kitten in the meadow"})
        self.assertEqual(code, 200, d)
        rid = d["run_id"]
        self.assertRegex(rid, r"^home-\d{8}-\d{6}$")
        self.assertEqual(self.req("/api/create", {"world": "koshakan-house", "prompt": "another one please"})[0], 429)
        st = self._wait_build(rid)
        self.assertEqual(st["status"], "ok", st)
        self.assertEqual(st["stages"][0]["name"], "chapter")
        self.assertTrue(all(s["status"] == "ok" for s in st["stages"]), st["stages"])
        self.assertIsNotNone(st["seconds"])
        run = self.runs / rid
        sj = json.loads((run / "stage" / "stage.json").read_text())
        self.assertEqual(sj["mode"], "book")
        self.assertEqual(sj["book"]["scene"], write.SCENE_ID)
        self.assertTrue((run / "cast.src" / "cast.json").is_file())
        self.assertFalse((run / "cast.src" / "marker.txt").exists())
        argv = self.home.build_argv(run, "p", self.home.world("koshakan-house"))
        self.assertEqual(argv[argv.index("--max-dollars") + 1], "1")
        mine = self.req("/api/scenes")[1]["mine"]
        self.assertEqual([m["id"] for m in mine], [rid])
        self.assertEqual(mine[0]["modes"], ["book", "freestyle"])
        self.assertTrue(mine[0]["cover_url"])
        code, p = self.req("/api/play", {"id": rid, "mode": "freestyle"})
        self.assertEqual(code, 200, p)

    def test_create_errors(self):
        self.assertEqual(self.req("/api/create", {"world": "koshakan-house", "prompt": "hi"})[0], 400)
        self.assertEqual(self.req("/api/create", {"world": "nope", "prompt": "a long enough idea"})[0], 400)
        self.assertEqual(self.req("/api/create/home-..%2f..")[0], 404)
        self.assertEqual(self.req("/api/create/home-20200101-000000")[0], 404)

    def test_chapter_failure_is_a_failed_build(self):
        self.home.fake = False
        self.home.ask = lambda system, user: '{"title": "t", "room": "attic", "paragraphs": []}'
        code, d = self.req("/api/create", {"world": "koshakan-house", "prompt": "a long enough idea"})
        self.assertEqual(code, 200)
        st = self._wait_build(d["run_id"])
        self.assertEqual(st["status"], "failed")
        self.assertEqual(st["stages"][0]["status"], "failed")
        self.assertIn("room", st["error"])

    def test_shutdown_kills_both(self):
        self.req("/api/play", {"id": "koshakan-bedroom", "mode": "book"})
        pid = self.home.scene.proc.pid
        self.home.build.begin(self.runs / "home-20200101-000000",
                              lambda: [PY, "-c", "import time; time.sleep(60)"])
        time.sleep(0.5)
        bpid = self.home.build.proc.pid
        self.home.shutdown()
        self.assertTrue(_wait_dead(pid))
        self.assertTrue(_wait_dead(bpid))


class TestWrite(unittest.TestCase):
    def setUp(self):
        self.world = next(w for w in catalog.load()["worlds"] if w["id"] == "koshakan-house")

    def good(self):
        return {"title": "The kitten", "room": "meadow", "paragraphs": [
            "The grass was warm.", '"Look, a kitten!" said Mirai.', "It mewed.", '"Shall we keep it?" said Mama.']}

    def test_good(self):
        self.assertEqual(write.check(self.good(), self.world), [])

    def test_rejects(self):
        g = self.good()
        g["room"] = "attic"
        self.assertTrue(any("room" in e for e in write.check(g, self.world)))
        g = self.good()
        g["paragraphs"][1] = '"Hello." said Watson.'
        errs = write.check(g, self.world)
        self.assertTrue(any("Watson" in e for e in errs) and any("Mirai never speaks" in e for e in errs))
        g = self.good()
        g["paragraphs"] = g["paragraphs"][:2]
        self.assertTrue(any("paragraphs" in e for e in write.check(g, self.world)))
        g = self.good()
        g["paragraphs"][1] = 'Mirai said "hi" and "bye".'
        self.assertTrue(any("exactly" in e for e in write.check(g, self.world)))

    def test_retry_then_ok(self):
        answers = iter(['not json', json.dumps(self.good())])
        seen = []
        ans = write.write_chapter("kitten", self.world, ask=lambda s, u: seen.append(u) or next(answers))
        self.assertEqual(ans["room"], "meadow")
        self.assertIn("last answer was wrong", seen[1])

    def test_two_bad_answers_fail(self):
        with self.assertRaises(write.ChapterError):
            write.write_chapter("kitten", self.world, ask=lambda s, u: "{}")

    def test_book_loads(self):
        out = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, out, True)
        write.write_book(self.good(), self.world, out)
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "dream"))
        import book as dream_book
        b = dream_book.load_book(str(out))
        sc = b["chapters"][0]["scenes"][0]
        self.assertEqual((sc["id"], sc["room"], sc["paras"]), (write.SCENE_ID, "meadow", [0, 4]))
        self.assertEqual(set(b["cast"]), {"Mama", "Mirai"})
        self.assertIn(b["pov"], b["cast"])

    def test_prompt_cleaning(self):
        self.assertEqual(server.clean_prompt("a\x00b\n\n c\t"), "a b c")
        self.assertEqual(len(server.clean_prompt("x" * 900)), server.MAX_PROMPT)
        self.assertEqual(server.clean_prompt(None), "")


if __name__ == "__main__":
    unittest.main()
