"""One HTTP client for Meta/Baseten/Fish (lesson L71): host list, paid-model guard,
retries, redaction, keys. No network: urlopen is replaced in every test."""
import io
import json
import os
import tempfile
import unittest
import urllib.error
import urllib.request
from unittest import mock

import keys
import llm_http

PAID = "muse-spark-" + "1.3"  # built, so the source never names the paid model
OK_BODY = {"choices": [{"message": {"content": "hi"}}], "usage": {"prompt_tokens": 1}}
META = "https://api.meta.ai/v1/chat/completions"


class Resp:
    def __init__(self, body):
        self.body = body if isinstance(body, bytes) else json.dumps(body).encode()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self):
        return self.body


def http_error(status, body=b"oops"):
    return urllib.error.HTTPError(META, status, "x", {}, io.BytesIO(body))


class Base(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.script = []        # items: Resp or Exception, consumed in order
        self.sleeps = []
        self.enterContext(mock.patch.object(urllib.request, "urlopen", side_effect=self._open))
        self.enterContext(mock.patch.object(llm_http, "_sleep", side_effect=self.sleeps.append))

    def _open(self, req, timeout=None):
        self.calls.append(req)
        if not self.script:
            raise AssertionError("network forbidden")
        item = self.script.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


class Post(Base):
    def test_content_null_becomes_empty_string(self):
        self.script = [Resp({"choices": [{"message": {"content": None}}]})]
        out = llm_http.post(META, "Bearer k", {"model": "m"}, 5, 0)
        self.assertEqual("", out["content"])
        self.assertEqual({}, out["usage"])
        self.assertIn("choices", out["raw"])

    def test_non_string_content_is_a_non_retryable_transport_error(self):
        for bad in ({"text": "hi"}, 5):
            with self.subTest(content=bad):
                self.calls.clear()
                self.script = [Resp({"choices": [{"message": {"content": bad}}]})]
                with self.assertRaises(llm_http.TransportError) as cm:
                    llm_http.post(META, "Bearer k", {"model": "m"}, 5, 0)
                self.assertIs(cm.exception.retryable, False)
                self.assertEqual(1, len(self.calls))

    def test_ok(self):
        self.script = [Resp(OK_BODY)]
        out = llm_http.post(META, "Bearer k", {"model": "m"}, 5, 0)
        self.assertEqual("hi", out["content"])
        self.assertEqual({"prompt_tokens": 1}, out["usage"])

    def test_every_listed_host_is_allowed(self):
        self.assertEqual({"api.meta.ai", "inference.baseten.co", "api.fish.audio"},
                         set(llm_http.ALLOWED_HOSTS))
        for host in llm_http.ALLOWED_HOSTS:
            self.script = [Resp(OK_BODY)]
            out = llm_http.post("https://%s/v1/chat/completions" % host, "Bearer k", {"model": "m"}, 5, 0)
            self.assertEqual("hi", out["content"], host)

    def test_other_host_refused_before_network(self):
        for url in ("https://evil.example/v1", "https://api.meta.ai.evil.example/v1",
                    "http://api.meta.ai/v1", "https://api.meta.ai@evil.example/v1"):
            with self.assertRaises(llm_http.TransportError, msg=url):
                llm_http.post(url, "Bearer secret-token-123", {"model": "m"}, 5, 0)
        self.assertEqual([], self.calls)

    def test_paid_model_refused_before_network(self):
        with self.assertRaises(llm_http.TransportError):
            llm_http.post(META, "Bearer k", {"model": PAID}, 5, 0)
        self.assertEqual([], self.calls)
        self.script = [Resp(OK_BODY)]
        llm_http.post(META, "Bearer k", {"model": PAID + "-contributor"}, 5, 0)
        self.assertEqual(1, len(self.calls))

    def test_retries_429_then_ok(self):
        self.script = [http_error(429), http_error(503), Resp(OK_BODY)]
        out = llm_http.post(META, "Bearer k", {"model": "m"}, 5, 5)
        self.assertEqual("hi", out["content"])
        self.assertEqual(3, len(self.calls))
        self.assertEqual([llm_http.backoff(0), llm_http.backoff(1)], self.sleeps)

    def test_at_most_three_attempts(self):
        self.script = [http_error(500)] * 6
        with self.assertRaises(llm_http.TransportError) as cm:
            llm_http.post(META, "Bearer k", {"model": "m"}, 5, 9)
        self.assertEqual(3, len(self.calls))
        self.assertEqual(500, cm.exception.status)
        self.assertEqual(2, len(self.sleeps))

    def test_no_retry_when_retries_zero_or_client_error(self):
        self.script = [http_error(503)]
        with self.assertRaises(llm_http.TransportError):
            llm_http.post(META, "Bearer k", {"model": "m"}, 5, 0)
        self.assertEqual(1, len(self.calls))
        self.script = [http_error(400)]
        with self.assertRaises(llm_http.TransportError):
            llm_http.post(META, "Bearer k", {"model": "m"}, 5, 3)
        self.assertEqual(2, len(self.calls))
        self.assertEqual([], self.sleeps)

    def test_error_body_token_is_not_in_exception(self):
        token = "sk-" + "A" * 40
        self.script = [http_error(400, ("bad key %s here" % token).encode())]
        with self.assertRaises(llm_http.TransportError) as cm:
            llm_http.post(META, "Bearer k", {"model": "m"}, 5, 0)
        self.assertNotIn(token, str(cm.exception))
        self.assertNotIn("AAAAAAAA", str(cm.exception))
        self.assertIn("400", str(cm.exception))

    def test_no_choices_is_error_with_redacted_head(self):
        token = "sk-" + "B" * 40
        body = json.dumps({"error": "nope " + token + "x" * 400}).encode()
        self.script = [Resp(body)]
        with self.assertRaises(llm_http.TransportError) as cm:
            llm_http.post(META, "Bearer k", {"model": "m"}, 5, 0)
        self.assertNotIn(token, str(cm.exception))
        self.assertLessEqual(len(str(cm.exception)), 260)

    def test_cross_host_redirect_not_followed(self):
        handler = llm_http._SameHostRedirect()
        req = urllib.request.Request(META, b"{}", {"Authorization": "Bearer k"})
        with self.assertRaises(llm_http.TransportError):
            handler.redirect_request(req, None, 302, "Found", {}, "https://evil.example/x")


class Keys(unittest.TestCase):
    def test_env_then_file_then_error_names_variable_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            env_file = os.path.join(tmp, ".env")
            with open(env_file, "w") as f:
                f.write("BASETEN_API_KEY=from-file-value\n")
            with mock.patch.object(keys, "ENV_FILE", env_file), \
                    mock.patch.dict(os.environ, {"META_MODEL_API_KEY": "from-env-value"}, clear=True):
                self.assertEqual("from-env-value", keys.get("META"))
                self.assertEqual("from-env-value", keys.get("IMAGE"))
                self.assertEqual("from-file-value", keys.get("BASETEN"))
                with self.assertRaises(keys.MissingKey) as cm:
                    keys.get("FISH")
                self.assertIn("FISH_AUDIO_API_KEY", str(cm.exception))
                self.assertNotIn("from-", str(cm.exception))

    def test_unknown_name(self):
        with self.assertRaises(KeyError):
            keys.get("NOPE")


class Callers(Base):
    def test_pipe2_http_transport_goes_through_llm_http_post(self):
        from pipe2.spark import HttpTransport
        with mock.patch.dict(os.environ, {"META_MODEL_API_KEY": "k-pipe2"}), \
                mock.patch.object(llm_http, "post", return_value={"content": "x", "usage": {}, "raw": OK_BODY}) as p:
            raw = HttpTransport().post({"model": "muse-spark-" + "1.3-contributor"}, 7)
        self.assertEqual(1, p.call_count)
        self.assertEqual(OK_BODY, raw)
        self.assertEqual([], self.calls)

    def test_dream_post_goes_through_llm_http_post(self):
        from dream import llm
        with mock.patch.object(llm_http, "post",
                               return_value={"content": "dream", "usage": {"a": 1}, "raw": {}}) as p:
            out = llm._post(llm.META_API, "Bearer k", "muse-spark-" + "1.3-contributor", "low",
                            "sys", [{"role": "user", "content": "hi"}], 100)
        self.assertEqual(1, p.call_count)
        self.assertEqual({"content": "dream", "usage": {"a": 1}}, out)
        self.assertEqual([], self.calls)


if __name__ == "__main__":
    unittest.main()
