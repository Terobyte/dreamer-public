"""Bug tests for hunt 2026-11-04 (c): B43b, B51, B53 (meta/bugs.md). Each fails on current code at its own assertion."""
import re
import unittest
from pathlib import Path
from unittest import mock

from place import semey_admin, semey_modal, semey_modal as sm

SRC = Path(semey_modal.__file__).read_text()


class B43b(unittest.TestCase):
    def test_claims_with_bad_word_exits_with_usage_and_sends_nothing(self):
        for word in ("On", "ON", "yes", "1", "not"):
            with mock.patch.object(semey_admin, "call", return_value=(200, {})) as c, \
                    mock.patch("urllib.request.urlopen") as u:
                with self.assertRaises(SystemExit, msg=f"B43b expected: claims {word!r} exits with usage; actual: returned"):
                    semey_admin.main(["http://x", "claims", word])
                self.assertFalse(c.called or u.called, f"B43b expected: no request for claims {word!r}")


class B51(unittest.TestCase):
    def test_image_runs_build_time_checks(self):
        cmds = []
        for m in re.finditer(r"\.run_commands\((.*?)\)\n", SRC, re.S):
            cmds.append(m.group(1))
        blob = "\n".join(cmds)
        try:
            blob += "\n" + "\n".join(str(x) for x in semey_modal.image._context_mount_function.__dict__.values())
        except Exception:
            pass
        self.assertRegex(blob, r"import place\.semey|from place import semey|import place\.semey",
                         "B51 expected: a build-time python import check of place.semey in run_commands; actual: none")
        self.assertIn("place.semey --selftest", blob, "B51 expected: `python -m place.semey --selftest` at build time; actual: absent")
        self.assertRegex(blob, r"node\s+(-v|--version|-e)", "B51 expected: a node version check at build time; actual: absent")
        self.assertIn("test -f /client/index.html", blob, "B51 expected: `test -f /client/index.html` at build time; actual: absent")


class _Stop(Exception):
    pass


class B53(unittest.TestCase):
    def test_sleep_after_healthy_run_is_one(self):
        clock = [0.0]
        durations = [1, 1, 1, 1, 100]      # four fast crashes, then a healthy 100 s run
        sleeps = []
        n = [0]

        class P:
            def wait(self_):
                clock[0] += durations[n[0] - 1]
                return 1

        def popen(*a, **k):
            if n[0] >= len(durations):
                raise _Stop
            n[0] += 1
            return P()

        def sleep(d):
            sleeps.append(d)
            clock[0] += d

        with mock.patch.object(sm.time, "monotonic", lambda: clock[0]), mock.patch("builtins.print"):
            with self.assertRaises(_Stop):
                sm.supervise(["x"], ".", {}, popen=popen, sleep=sleep)
        self.assertGreaterEqual(max(sleeps[:4]), 8, f"setup: delay should have grown, sleeps={sleeps}")
        self.assertEqual(sleeps[4], 1, f"B53 expected: sleep right after a healthy (>60 s) run is 1; actual sleeps={sleeps}")


if __name__ == "__main__":
    unittest.main()
