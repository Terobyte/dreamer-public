"""Offline tests: Spark Open on Baseten is primary, Spark 1.3 on Meta is the fallback.
usage: cd h0/dream && python3 -m unittest test_baseten -q
"""
import os
import tempfile
import unittest
from unittest import mock

import llm


def _msgs():
    return [{"role": "user", "content": "hi"}]


class BasetenTest(unittest.TestCase):
    def test_open_goes_to_baseten(self):
        sent = []

        def post(url, auth, model, *a):
            sent.append((url, auth.split()[0], model))
            return {"content": "line", "usage": {}}
        with mock.patch.object(llm, "_post", post), \
                mock.patch.object(llm, "_baseten_key", lambda: "k"):
            out = llm.RealTransport().complete(llm.SPARK_OPEN_MODEL, "minimal", "s", _msgs(), 1500)
        self.assertEqual(out["content"], "line")
        self.assertEqual(sent, [(llm.BASETEN_API, "Api-Key", llm.SPARK_OPEN_MODEL)])

    def test_baseten_failure_falls_back_to_meta(self):
        sent = []

        def post(url, auth, model, *a):
            sent.append((url, model))
            if url == llm.BASETEN_API:
                raise OSError("503")
            return {"content": "meta line", "usage": {}}
        with mock.patch.object(llm, "_post", post), \
                mock.patch.object(llm, "_baseten_key", lambda: "k"), \
                mock.patch.dict(os.environ, {"META_MODEL_API_KEY": "m"}):
            out = llm.RealTransport().complete(llm.SPARK_OPEN_MODEL, "minimal", "s", _msgs(), 1500)
        self.assertEqual(out["content"], "meta line")
        self.assertEqual(out["model"], llm.SPARK_MODEL)
        self.assertEqual(sent[-1], (llm.META_API, llm.SPARK_MODEL))

    def test_fallback_is_billed_as_spark13(self):
        class T:
            def complete(self, **kw):
                return {"content": "x", "usage": {"prompt_tokens": 1000000,
                                                  "completion_tokens": 0},
                        "model": llm.SPARK_MODEL}
        llm.reset_spent()
        r = llm.call("hero", "s", _msgs(), _transport=T())
        self.assertAlmostEqual(r.dollars, llm.SPARK_IN_PER_M)

    def test_key_from_env_file(self):
        d = tempfile.mkdtemp()
        path = os.path.join(d, ".env")
        with open(path, "w") as f:
            f.write("OTHER=1\nBASETEN_API_KEY=abc\n")
        with mock.patch.object(llm, "ENV_FILE", path), \
                mock.patch.dict(os.environ, {"BASETEN_API_KEY": ""}):
            self.assertEqual(llm._baseten_key(), "abc")


if __name__ == "__main__":
    unittest.main()
