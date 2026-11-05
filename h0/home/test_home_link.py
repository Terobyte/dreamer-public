"""Home kind "link": a card that opens a live shared world on modal.run.  cd h0 && python3 -m unittest home.test_home_link

No network; a temp catalog file, scenes.json is never touched.
"""
import json
import re
import shutil
import tempfile
import threading
import unittest
from pathlib import Path

from home import catalog, server
from home.test_home import Base

GOOD = "https://highskilltero--semey-web.modal.run/?live"
BAD = [
    "http://x.modal.run/",
    "javascript:alert(1)",
    "https://evilmodal.run/",
    "https://x.modal.run.evil.com/",
    "https://u:p@x.modal.run/",
    "https://x.modal.run:444/",
    "https://x.modal.run/\\evil",
    "https://x.modal.run/ a",
]
STATIC = Path(__file__).with_name("static")


def _link(url, id="semey-live"):
    return {"id": id, "title": "Semey live", "kind": "link", "url": url, "blurb": "shared world"}


def _write_catalog(entries):
    tmp = Path(tempfile.mkdtemp())
    p = tmp / "s.json"
    p.write_text(json.dumps({"scenes": entries, "worlds": []}))
    return tmp, p


class TestLinkCatalog(unittest.TestCase):
    def _load(self, url):
        tmp, p = _write_catalog([_link(url)])
        self.addCleanup(shutil.rmtree, tmp, True)
        return catalog.load(p)["scenes"]

    def test_kinds_has_link(self):
        self.assertIn("link", catalog.KINDS)

    def test_good_link_loads_without_run(self):
        s = self._load(GOOD)
        self.assertEqual(len(s), 1)
        self.assertTrue(s[0]["ready"], s[0].get("why"))
        self.assertNotIn("_run", s[0])
        self.assertEqual(s[0]["url"], GOOD)

    def test_bad_urls_rejected(self):
        good = self._load(GOOD)   # guard: rejection only means something if a good link is accepted
        self.assertTrue(good and good[0]["ready"], "good link must load")
        for url in BAD:
            s = self._load(url)   # dropped, or kept with ready=False (as test_home does for broken entries)
            self.assertTrue(not s or not s[0]["ready"], url)

    def test_non_string_url_rejected(self):
        self.assertTrue(self._load(GOOD)[0]["ready"], "good link must load")
        for url in (None, 5, ["https://x.modal.run/"]):
            s = self._load(url)
            self.assertTrue(not s or not s[0]["ready"], repr(url))

    def test_public_has_url_and_no_paths(self):
        s = self._load(GOOD)
        self.assertTrue(s and s[0]["ready"], "good link must load")
        pub = catalog.public(s[0])
        self.assertEqual(pub["url"], GOOD)
        self.assertFalse(any(k.startswith("_") for k in pub))


class TestLinkApi(Base):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="home-test-"))
        self.runs = self.tmp / "runs"
        self.cat = self.tmp / "s.json"
        self.cat.write_text(json.dumps({"scenes": [dict(_link(GOOD), modes=["freestyle"])], "worlds": []}))
        self.srv, self.home = server.serve(0, fake=True, runs=self.runs, catalog_path=self.cat)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.url = "http://127.0.0.1:%d" % self.srv.server_address[1]

    def test_scenes_returns_url(self):
        code, body = self.req("/api/scenes")
        self.assertEqual(code, 200)
        s = next(x for x in body["scenes"] if x["id"] == "semey-live")
        self.assertTrue(s["ready"], s.get("why"))
        self.assertEqual(s["url"], GOOD)
        self.assertFalse(any(k.startswith("_") for k in s))

    def test_play_link_is_400(self):
        # the entry carries modes=["freestyle"] and is ready, so only the link check can give 400 here
        code, body = self.req("/api/scenes")
        s = next(x for x in body["scenes"] if x["id"] == "semey-live")
        self.assertTrue(s["ready"], s.get("why"))
        for mode in ("freestyle", "book", None):
            code, body = self.req("/api/play", {"id": "semey-live", "mode": mode})
            self.assertEqual(code, 400, (mode, body))
            self.assertIn("error", body)
        self.assertIsNone(self.home.scene.current())


class TestLinkPage(unittest.TestCase):
    def setUp(self):
        self.js = (STATIC / "home.js").read_text()

    def test_opens_new_tab_noopener(self):
        self.assertTrue(re.search(r"window\.open\([^)]*['\"]_blank['\"]\s*,\s*['\"]noopener['\"]", self.js),
                        "no window.open(url, '_blank', 'noopener') in home.js")

    def test_link_kind_handled_in_card(self):
        self.assertTrue(re.search(r"""kind\s*===?\s*["']link["']""", self.js), "no kind === 'link' branch in home.js")

    def test_live_badge(self):
        # a badge string literal (quotes or template) that says "live", e.g. "live · shared world"
        self.assertTrue(re.search(r"""["'`][^"'`\n]*\blive\b[^"'`\n]*["'`]""", self.js, re.I), "no 'live' badge text in home.js")

    def test_link_does_not_go_through_play(self):
        # the link branch must come before / instead of the play() call in card()
        card = self.js[self.js.index("function card("):]
        card = card[:card.index("\n}\n")]
        i_link = card.find("link")
        self.assertGreaterEqual(i_link, 0, "card() has no link branch")
        self.assertIn("window.open", card)
        self.assertLess(card.index("window.open"), card.index("play(s.id") if "play(s.id" in card else 10**9)


if __name__ == "__main__":
    unittest.main()
