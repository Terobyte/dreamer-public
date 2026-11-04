"""Hunt 2026-11-04 bugs B16-B21 in semey.py, as red tests. No network beyond 127.0.0.1.

Each test is expected to FAIL on the current code at its own assertion (documented in bugs.md, "Hunt 2026-11-04").

  cd h0 && python3 -m unittest place.test_semey_bugs_http -v
"""
import json
import socket
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from place import semey as S
from place.test_semey import ADMIN, KEY, TOK, Clock, FakeProg, gate_builder

WID = "w" + "a" * 12
SOCK_TIMEOUT = 5


def status_of(data: bytes):
    line = data.split(b"\r\n", 1)[0].split()
    return int(line[1]) if len(line) > 1 and line[1].isdigit() else None


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        (self.tmp / "f.json").write_text("{}")
        self.clock = Clock()
        self.builder, self.ev, self.calls = gate_builder()

    def world(self):
        w = S.World(self.tmp, self.tmp / "f.json", builder=self.builder, clock=self.clock, progress_cls=FakeProg)
        w.st["claims"] = True
        return w


class HttpBase(Base):
    def setUp(self):
        super().setUp()
        self.client = self.tmp / "client"
        (self.client / "assets").mkdir(parents=True)
        (self.client / "index.html").write_text("<html>semey</html>")
        self.w = self.world()
        h = S.make_handler(self.w, self.client, "semey.example", KEY, ADMIN, asr=lambda b: "аптека")
        self.srv = S.BoundedServer(("127.0.0.1", 0), h)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.port = self.srv.server_address[1]

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()

    def raw(self, payload: bytes) -> bytes:
        """send raw bytes, read until the server closes; b'' if the server dropped the connection"""
        data = b""
        s = socket.create_connection(("127.0.0.1", self.port), timeout=SOCK_TIMEOUT)
        try:
            s.sendall(payload)
            while True:
                chunk = s.recv(4096)
                if not chunk:
                    break
                data += chunk
        except OSError:
            pass
        finally:
            s.close()
        return data

    def url_status(self, path, method="GET", body=None, headers=None):
        """status code via urllib, or 'exc:<name>' when the server dropped the connection"""
        r = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", data=body, method=method,
                                   headers={"Host": f"localhost:{self.port}", **(headers or {})})
        try:
            with urllib.request.urlopen(r, timeout=SOCK_TIMEOUT) as resp:
                return resp.status
        except urllib.error.HTTPError as e:
            return e.code
        except Exception as e:
            return f"exc:{type(e).__name__}"


class B16_RawWishOnPublicLabel(Base):
    def test_B16_raw_wish_not_in_public_label_before_rude_check(self):
        w = self.world()
        wish = "сука аптека"          # rude wish, passes check_text; Spark's rude check runs later
        wid = w.claim(2, "a", wish, TOK(1))
        try:
            view_place = next(p for p in w.view()["places"] if p["id"] == 2)
            self.assertNotIn("сука", view_place.get("label") or "",
                             f"public label shows raw wish text while building: {view_place.get('label')!r}")
            self.assertNotIn("сука", w.st["places"]["2"]["label"],
                             "stored public label holds raw wish text before the rude check")
        finally:
            self.finish(w, wid)

    def finish(self, w, wid):
        self.ev.setdefault(wid, threading.Event()).set()
        th = w.running.get(wid)
        if th:
            th.join(5)


class B17_EncodedDotDotParts(HttpBase):
    def test_B17_encoded_dotdot_under_dist_does_not_serve_sibling_file(self):
        (self.tmp / "parts" / WID / "dist").mkdir(parents=True)
        (self.tmp / "parts" / WID / "wish.txt").write_text("SECRET-WISH-TEXT")
        data = self.raw(f"GET /parts/{WID}/dist/..%2fwish.txt HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\n"
                        f"Connection: close\r\n\r\n".encode())
        code = status_of(data)
        self.assertIn(code, (403, 404), f"encoded ../ escaped dist/, got {code}")
        self.assertNotIn(b"SECRET-WISH-TEXT", data)


class B18_NonAsciiKey(HttpBase):
    def test_B18_non_ascii_judge_key_gets_clean_403(self):
        payload = (f"POST /api/asr HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\nContent-Type: audio/wav\r\n"
                   f"Content-Length: 0\r\nX-Token: {TOK(1)}\r\nConnection: close\r\n").encode()
        payload = payload + b"X-Judge-Key: " + "ключ".encode("utf-8") + b"\r\n\r\n"
        data = self.raw(payload)
        self.assertEqual(status_of(data), 403, f"non-ASCII judge key: expected clean 403, got raw reply {data[:80]!r}")

    def test_B18_non_ascii_admin_key_gets_clean_answer(self):
        payload = (f"POST /api/admin HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\nContent-Length: 2\r\n"
                   f"Connection: close\r\n").encode()
        payload = payload + b"X-Admin-Key: " + "ключ".encode("utf-8") + b"\r\n\r\n{}"
        data = self.raw(payload)
        self.assertIn(status_of(data), (403, 404), f"non-ASCII admin key: expected clean refusal, got raw reply {data[:80]!r}")


class B19_NonObjectAdminBody(HttpBase):
    def test_B19_admin_non_object_json_body_gets_400(self):
        for body in (b"[]", b'"x"'):
            with self.subTest(body=body):
                got = self.url_status("/api/admin", "POST", body, {"X-Admin-Key": ADMIN})
                self.assertEqual(got, 400, f"admin body {body!r} with valid key: expected 400, got {got}")


class B20_NulInPath(HttpBase):
    def test_B20_nul_byte_in_path_gets_400_or_404(self):
        data = self.raw(f"GET /a%00b HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\nConnection: close\r\n\r\n".encode())
        self.assertIn(status_of(data), (400, 404), f"%00 in path: expected 400/404, got raw reply {data[:80]!r}")


class B21_DuplicateLongIds(Base):
    def test_B21_fix_spec_duplicate_24_char_ids_end_up_unique(self):
        long_id = "x" * 24
        objs = [{"id": long_id, "prompt": "a shelf", "w": 1, "d": 0.5, "h": 2, "place": "left"},
                {"id": long_id, "prompt": "a table", "w": 1, "d": 1, "h": 0.8, "place": "centre"},
                {"id": "counter", "prompt": "a counter", "w": 2, "d": 0.7, "h": 1, "place": "back"}]
        spec = json.loads(json.dumps(S.FALLBACK_SPEC))
        spec["objects"] = objs
        ids = [x["id"] for x in S.fix_spec(spec)["objects"]]
        self.assertEqual(len(set(ids)), len(ids), f"duplicate object ids after fix_spec: {ids}")


if __name__ == "__main__":
    unittest.main()
