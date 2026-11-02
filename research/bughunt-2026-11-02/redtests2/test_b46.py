"""B46: failed TTS leaves log != novoice, so the next dub() returns (0,0) forever."""
import json
import os
import shutil
import tempfile
from unittest import mock

import dub


class DeadVoice:
    def synthesize(self, text, label, path):
        return {"ok": False, "audio": None, "pause": 0.5}


def test_second_dub_retries_after_failed_synthesis():
    run = tempfile.mkdtemp()
    try:
        rows = [{"seq": 1, "t": 0.0, "type": "snapshot"},
                {"seq": 2, "t": 1.0, "type": "line", "text": "[flat] Hi.", "who": "A", "role": "hero"}]
        with open(os.path.join(run, "log.jsonl"), "w") as f:
            f.write("".join(json.dumps(r) + "\n" for r in rows))
        cast = ("A", {"A": "man"}, {}, "room", {})
        with mock.patch.object(dub, "cast_of", return_value=cast):
            n1, _ = dub.dub(run, "x", voice=DeadVoice(), images=False)

            class GoodVoice:
                def __init__(s):
                    s.calls = 0

                def synthesize(s, text, label, path):
                    s.calls += 1
                    return {"ok": True, "audio": path, "pause": 0.5}
            good = GoodVoice()
            n2, _ = dub.dub(run, "x", voice=good, images=False)
        assert n2 == 1 and good.calls == 1, \
            "second dub after TTS recovery should voice the missing line: first=%d second=%d synth_calls=%d" % (n1, n2, good.calls)
    finally:
        shutil.rmtree(run, True)
