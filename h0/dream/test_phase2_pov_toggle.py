"""F2: POV toggle must init from live hero_owner and follow POV rows."""

import http.client
import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))


class PovToggleSyncTest(unittest.TestCase):
    def _html(self):
        with open(os.path.join(HERE, "comic.html"), encoding="utf-8") as f:
            return f.read()

    def test_comic_applies_pov_rows(self):
        html = self._html()
        self.assertIn('case "pov"', html)

    def test_hero_api_reports_owner(self):
        import sim as sim_mod
        from server import Viewer
        sim_mod.use_scene("start")
        self.addCleanup(sim_mod.use_scene, "start")
        import tempfile, shutil
        from unittest import mock
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root, True)
        with mock.patch("urllib.request.urlopen",
                        side_effect=AssertionError("network forbidden")):
            from sim import Sim
            sim = Sim(profile="A", fake=True, speed=1.0, outdir=root)
            self.addCleanup(sim.close)
            sim.set_pov("human")
            v = Viewer(sim=sim, run="A/run_1", root=root)
            prof = getattr(getattr(sim, "dialogue", None), "profile", None)
            if not prof:
                from sim import load_profile
                prof = load_profile(sim.profile)
            soul = prof.get("soul") if isinstance(prof.get("soul"), dict) else prof
            facts = [f.get("text") for f in soul.get("facts") or []
                     if isinstance(f, dict) and not f.get("hidden_from_hero") and f.get("text")]
            diary = [soul["diary"]] if soul.get("diary") else []
            # _hero must report the live owner alongside facts/diary
            import json, http.client
            port = v.start(0)
            self.addCleanup(v.stop)
            c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
            c.request("GET", "/api/hero", headers={"Host": "127.0.0.1:%d" % port})
            r = c.getresponse()
            body = json.loads(r.read())
            c.close()
            self.assertEqual(r.status, 200)
            self.assertEqual(body["facts"], facts)
            self.assertEqual(body["diary"], diary)
            self.assertEqual(body.get("hero_owner"), "human")

    def test_povbtn_starts_disabled(self):
        """F3: the toggle must not accept clicks before the first hero_owner
        sync lands -- a reload during a live "human" dream must not let a
        stray early click re-submit "human" instead of "npc"."""
        html = self._html()
        self.assertRegex(html, r'<button id="povbtn"[^>]*\bdisabled\b')

    def test_povbtn_click_guarded_by_ready_flag(self):
        """F2/F3: renderPov must gate the button's disabled state on a
        readiness flag set only once the live hero_owner is known, not just
        on povHuman (which defaults to false == npc on every load)."""
        html = self._html()
        self.assertIn("povReady", html)
        self.assertRegex(html, r'\.disabled\s*=\s*!povReady')

    def test_apply_does_not_fast_forward_povready(self):
        """F4: snapshot/pov rows replayed off the log (history, possibly stale)
        must only update the toggle's label, never its readiness -- only the
        authoritative /api/hero sync (syncPov/setPov) may flip povReady, or a
        delayed /api/hero response racing a stale replayed "npc" snapshot can
        leave the button enabled on the wrong side."""
        html = self._html()
        snapshot_case = re.search(r'case "snapshot":(.*?)break;', html, re.S).group(1)
        pov_case = re.search(r'case "pov":(.*?)break;', html, re.S).group(1)
        self.assertNotIn("povReady = true", snapshot_case)
        self.assertNotIn("povReady = true", pov_case)
        # readiness is set in exactly one place, povTake, and only for a live source
        self.assertEqual(html.count("povReady = true"), 1)
        take = re.search(r'function povTake\(owner, seq, liveSrc\) \{(.*?)\n\}', html, re.S).group(1)
        self.assertIn("if (liveSrc) povReady = true", take)
        self.assertIn("povTake(r.hero_owner, r.seq, false)", snapshot_case)
        self.assertIn("povTake(r.hero_owner, r.seq, false)", pov_case)
        sync_pov = re.search(r'async function syncPov\(\) \{(.*?)\n\}', html, re.S).group(1)
        self.assertIn("povTake(h.hero_owner, h.seq, true)", sync_pov)

    def test_status_reports_owner(self):
        import sim as sim_mod
        from unittest import mock
        sim_mod.use_scene("start")
        self.addCleanup(sim_mod.use_scene, "start")
        import tempfile, shutil
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root, True)
        with mock.patch("urllib.request.urlopen",
                        side_effect=AssertionError("network forbidden")):
            from sim import Sim
            sim = Sim(profile="A", fake=True, speed=1.0, outdir=root)
            self.addCleanup(sim.close)
            self.assertEqual(sim.status().get("hero_owner"), "npc")
            sim.set_pov("human")
            self.assertEqual(sim.status().get("hero_owner"), "human")


class PovToggleOrderTest(unittest.TestCase):
    """F4-F7: every POV source (log rows, replayed history, /api/hero, the live
    status) is ordered by its log seq, so arrival order cannot win. The page's own
    pov block is extracted and run under node with a scripted fetch, so these
    check behaviour -- state and the /pov request a click sends -- not wording."""

    def _html(self):
        with open(os.path.join(HERE, "comic.html"), encoding="utf-8") as f:
            return f.read()

    def _case(self, html, name):
        return re.search(r'case "%s":(.*?)break;' % name, html, re.S).group(1)

    def _run(self, steps):
        """steps: "sync" (start syncPov, /api/hero left pending), {"hero": obj|None}
        (answer the oldest pending /api/hero; None = HTTP error), {"row": r} (SSE
        log row through apply), {"status": s} (named SSE snapshot event), "click"
        (the button's click handler), {"pov_ok": bool} (next /pov answers)."""
        node = shutil.which("node")
        if not node:
            self.skipTest("node is not installed")
        html = self._html()
        block = html[html.index("// --- 2.1: whose turn the hero is"):
                     html.index('const povbtn = $("povbtn");')]
        sync = re.search(r"async function syncPov\(\) \{.*?\n\}", html, re.S).group(0)
        status = re.search(r'es\.addEventListener\("snapshot", \(e\) => \{(.*?)\n  \}\);',
                           html, re.S).group(1)
        js = """
const btn = {disabled: true, textContent: ""};
function $(id) { return id === "povbtn" ? btn : null; }
const heroWaiters = [], posts = [], seen = [];
let povOk = true;
async function fetch(url, opts) {
  if (url === '/api/hero') return new Promise((res) => heroWaiters.push(res));
  if (url === '/pov') {
    posts.push(JSON.parse(opts.body));
    if (opts.headers["Content-Type"] !== "application/json") throw new Error("ctype");
    return {ok: povOk};
  }
  throw new Error("unexpected fetch " + url);
}
let S = {};
function newScene() {}
%s
%s
function applyRow(r) {
  switch (r.type) {
    case "snapshot": %s break;
    case "pov": %s break;
  }
}
function statusEvent(e) { %s }
const flush = () => new Promise((r) => setTimeout(r, 0));
const snap = () => ({povHuman, povReady, povPending, disabled: btn.disabled,
                     posts: posts.slice()});
(async () => {
  for (const st of %s) {
    if (st === "sync") syncPov();
    else if (st === "click") { if (!btn.disabled) povClick(); else seen.push("blocked"); }
    else if ("hero" in st) {
      const res = heroWaiters.shift();
      res(st.hero === null ? {ok: false} : {ok: true, json: async () => st.hero});
    }
    else if ("row" in st) applyRow(st.row);
    else if ("status" in st) statusEvent({data: JSON.stringify(st.status)});
    else if ("pov_ok" in st) povOk = st.pov_ok;
    await flush();
    seen.push(snap());
  }
  console.log(JSON.stringify({final: snap(), steps: seen}));
})();
""" % (block, sync, self._case(html, "snapshot"), self._case(html, "pov"), status,
       json.dumps(steps))
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, True)
        f = os.path.join(d, "harness.mjs")
        with open(f, "w", encoding="utf-8") as fh:
            fh.write(js)
        out = subprocess.run([node, f], capture_output=True, text=True, timeout=30)
        self.assertEqual(out.returncode, 0, out.stderr)
        return json.loads(out.stdout.strip().splitlines()[-1])

    def test_stale_rows_do_not_flip_the_synced_toggle(self):
        res = self._run(["sync", {"hero": {"hero_owner": "human", "seq": 10}},
                         {"row": {"type": "snapshot", "hero_owner": "npc", "seq": 9}},
                         {"row": {"type": "pov", "hero_owner": "npc", "seq": 8}}, "click"])
        state = res["steps"][3]
        self.assertTrue(state["povReady"])
        self.assertTrue(state["povHuman"],
                        "a stale npc row overrode the live human owner: the first "
                        "click would submit human again instead of npc")
        self.assertEqual(res["final"]["posts"], [{"hero_owner": "npc"}])

    def test_fresh_rows_still_move_the_toggle(self):
        res = self._run(["sync", {"hero": {"hero_owner": "human", "seq": 10}},
                         {"row": {"type": "pov", "hero_owner": "npc", "seq": 11}}, "click"])
        self.assertFalse(res["steps"][2]["povHuman"],
                         "a pov row newer than the sync must still be applied")
        self.assertEqual(res["final"]["posts"], [{"hero_owner": "human"}])

    def test_older_sync_answer_does_not_undo_a_newer_row(self):
        """F7 (round 6): /api/hero answered at seq 10 (npc) lands after the SSE
        pov row seq 11 (human) -- the newer row must stand."""
        res = self._run(["sync",
                         {"row": {"type": "pov", "hero_owner": "human", "seq": 11}},
                         {"hero": {"hero_owner": "npc", "seq": 10}}, "click"])
        state = res["steps"][2]
        self.assertTrue(state["povHuman"], "an older /api/hero answer overruled seq 11")
        self.assertTrue(state["povReady"])
        self.assertEqual(res["final"]["posts"], [{"hero_owner": "npc"}])

    def test_history_before_sync_neither_enables_nor_sticks(self):
        """F3/F4: replayed history (snapshot npc at seq 1) arrives while /api/hero
        is still pending -- the button stays locked, a click sends nothing, and
        the live human answer wins once it lands."""
        res = self._run(["sync",
                         {"row": {"type": "snapshot", "hero_owner": "npc", "seq": 1}},
                         "click",
                         {"hero": {"hero_owner": "human", "seq": 50}},
                         {"row": {"type": "pov", "hero_owner": "npc", "seq": 7}},
                         "click"])
        self.assertTrue(res["steps"][1]["disabled"])
        self.assertEqual(res["steps"][2], "blocked")
        self.assertEqual(res["steps"][3]["posts"], [])
        self.assertTrue(res["steps"][4]["povHuman"])
        self.assertEqual(res["final"]["posts"], [{"hero_owner": "npc"}])

    def test_click_locks_until_its_row_lands(self):
        """Toggle mid-flight: the click does not guess the new owner; the toggle
        stays locked through stale backlog and unlocks on the server's pov row."""
        res = self._run(["sync", {"hero": {"hero_owner": "human", "seq": 10}},
                         "click", "click",
                         {"row": {"type": "pov", "hero_owner": "human", "seq": 5}},
                         {"row": {"type": "pov", "hero_owner": "npc", "seq": 11}},
                         "click"])
        after_click = res["steps"][2]
        self.assertTrue(after_click["povPending"])
        self.assertTrue(after_click["disabled"])
        self.assertTrue(after_click["povHuman"], "the click must not guess the owner")
        self.assertEqual(res["steps"][3], "blocked")
        self.assertTrue(res["steps"][5]["povPending"], "a stale row must not unlock")
        landed = res["steps"][6]
        self.assertFalse(landed["povPending"])
        self.assertFalse(landed["povHuman"])
        self.assertFalse(landed["disabled"])
        self.assertEqual(res["final"]["posts"],
                         [{"hero_owner": "npc"}, {"hero_owner": "human"}])

    def test_failed_post_unlocks_without_moving(self):
        res = self._run(["sync", {"hero": {"hero_owner": "human", "seq": 10}},
                         {"pov_ok": False}, "click"])
        state = res["final"]
        self.assertFalse(state["povPending"])
        self.assertFalse(state["disabled"])
        self.assertTrue(state["povHuman"])
        self.assertEqual(state["posts"], [{"hero_owner": "npc"}])

    def test_live_status_is_a_source_when_hero_api_fails(self):
        """/api/hero errors: the periodic live status still enables the toggle,
        under the same seq rule; a folded (non-live) snapshot never does."""
        res = self._run(["sync", {"hero": None},
                         {"status": {"live": False, "hero_owner": "human", "seq": 4}},
                         {"status": {"live": True, "hero_owner": "human", "seq": 3}},
                         {"row": {"type": "pov", "hero_owner": "npc", "seq": 4}},
                         {"status": {"live": True, "hero_owner": "human", "seq": 2}}])
        self.assertFalse(res["steps"][1]["povReady"])
        self.assertFalse(res["steps"][2]["povReady"])
        self.assertTrue(res["steps"][3]["povReady"])
        self.assertTrue(res["steps"][3]["povHuman"])
        self.assertFalse(res["final"]["povHuman"], "an older live status undid seq 4")

    def _racy_sim(self, root):
        """A Sim whose hero_owner changes (assign, then log the pov row -- the
        order set_pov uses) right after someone reads it, i.e. a set_pov landing
        between two reads in the server thread."""
        from sim import Sim

        class RacySim(Sim):
            racing = False

            @property
            def hero_owner(self):
                v = self._owner
                if self.racing:
                    self.racing = False
                    self._owner = "human"
                    self.logger.write_event({"type": "pov", "hero_owner": "human"})
                return v

            @hero_owner.setter
            def hero_owner(self, v):
                self._owner = v

        return RacySim(profile="A", fake=True, speed=1.0, outdir=root)

    def test_owner_is_read_after_seq(self):
        """The answer's owner must never be older than its seq: read the other
        way round, a set_pov in between yields {npc, seq of the human row} and
        the viewer then drops that row as not newer."""
        import sim as sim_mod
        from server import Viewer
        from unittest import mock
        sim_mod.use_scene("start")
        self.addCleanup(sim_mod.use_scene, "start")
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root, True)
        with mock.patch("urllib.request.urlopen",
                        side_effect=AssertionError("network forbidden")):
            sim = self._racy_sim(root)
            self.addCleanup(sim.close)
            before = sim.logger.seq
            sim.racing = True
            st = sim.status()
            self.assertEqual(st["hero_owner"], "npc")
            self.assertEqual(st["seq"], before)
            self.assertGreater(sim.logger.seq, st["seq"])
            v = Viewer(sim=sim, run="A/run_1", root=root)
            port = v.start(0)
            self.addCleanup(v.stop)
            before = sim.logger.seq
            sim._owner = "npc"
            sim.racing = True
            c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
            c.request("GET", "/api/hero", headers={"Host": "127.0.0.1:%d" % port})
            r = c.getresponse()
            body = json.loads(r.read())
            c.close()
        self.assertEqual(r.status, 200)
        self.assertEqual(body["hero_owner"], "npc")
        self.assertEqual(body["seq"], before)
        self.assertGreater(sim.logger.seq, body["seq"])

    def test_hero_api_reports_the_log_position(self):
        """The watermark has to come from the server: /api/hero answers for a
        point in the log, so it must say which one."""
        import sim as sim_mod
        from server import Viewer
        from unittest import mock
        sim_mod.use_scene("start")
        self.addCleanup(sim_mod.use_scene, "start")
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root, True)
        with mock.patch("urllib.request.urlopen",
                        side_effect=AssertionError("network forbidden")):
            from sim import Sim
            sim = Sim(profile="A", fake=True, speed=1.0, outdir=root)
            self.addCleanup(sim.close)
            v = Viewer(sim=sim, run="A/run_1", root=root)
            port = v.start(0)
            self.addCleanup(v.stop)
            c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
            c.request("GET", "/api/hero", headers={"Host": "127.0.0.1:%d" % port})
            r = c.getresponse()
            body = json.loads(r.read())
            c.close()
        self.assertEqual(r.status, 200)
        self.assertIsInstance(body.get("seq"), int)
        self.assertEqual(body["seq"], sim.logger.seq)


if __name__ == "__main__":
    unittest.main()
