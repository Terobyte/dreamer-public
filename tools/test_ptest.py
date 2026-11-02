"""Regression tests for ptest's per-class timeout handling.

These tests intentionally exercise the CLI in a subprocess so importing ptest
does not couple the tests to its implementation details.
"""
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path


PTEST = Path(__file__).with_name("ptest.py").resolve()


class PtestTimeoutTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="ptest-timeout-")
        self.root = Path(self.temp.name)
        self.pid_file = self.root / "grandchild.pid"
        self.process = None
        module = f'''\
import os
import subprocess
import sys
import time
import unittest

PID_FILE = {str(self.pid_file)!r}

class Fast(unittest.TestCase):
    def test_passes(self):
        self.assertTrue(True)

class Hang(unittest.TestCase):
    def test_sleeps_forever(self):
        child = subprocess.Popen([
            sys.executable, "-c",
            "import time; time.sleep(600)",
        ])
        with open(PID_FILE, "w", encoding="ascii") as f:
            f.write(str(child.pid))
        while True:
            time.sleep(60)
'''
        (self.root / "mod_hang.py").write_text(module, encoding="utf-8")

    def tearDown(self):
        # On an outer timeout, terminate ptest and its test-class child tree.
        if self.process is not None and self.process.poll() is None:
            self._kill_process_group(self.process.pid)
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                pass
        self._kill_grandchild()
        self.temp.cleanup()

    @staticmethod
    def _kill_process_group(pid):
        try:
            os.killpg(pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass

    def _kill_grandchild(self):
        try:
            pid = int(self.pid_file.read_text(encoding="ascii"))
        except (FileNotFoundError, ValueError):
            return
        try:
            os.kill(pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass

    def _run_ptest(self, timeout_arg=None, env_timeout=None):
        cmd = [sys.executable, str(PTEST), "--cwd", str(self.root)]
        if timeout_arg is not None:
            cmd.extend(["--timeout", str(timeout_arg)])
        cmd.append("mod_hang")
        env = os.environ.copy()
        env.pop("PTEST_TIMEOUT", None)
        if env_timeout is not None:
            env["PTEST_TIMEOUT"] = str(env_timeout)
        self.process = subprocess.Popen(
            cmd,
            cwd=str(self.root),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            start_new_session=True,
        )
        started = time.monotonic()
        try:
            output, _ = self.process.communicate(timeout=8)
        except subprocess.TimeoutExpired:
            self.fail("ptest hung")
        return self.process.returncode, output, time.monotonic() - started

    def _assert_timeout_run(self, rc, output, elapsed):
        self.assertEqual(rc, 1, output)
        self.assertIn("TIMEOUT mod_hang.Hang", output)
        self.assertIn("ok   mod_hang.Fast", output)
        summary = next((line for line in output.splitlines()
                        if "classes from" in line), "")
        self.assertIn("FAILED:", summary)
        self.assertIn("mod_hang.Hang", summary)
        self.assertLess(elapsed, 30, output)

    def test_cli_timeout_kills_hung_class_process_group_and_continues(self):
        rc, output, elapsed = self._run_ptest(timeout_arg=2)
        self._assert_timeout_run(rc, output, elapsed)

        self.assertTrue(self.pid_file.exists(), "hanging class did not spawn grandchild")
        pid = int(self.pid_file.read_text(encoding="ascii"))
        # A zombie has exited and cannot continue running work, so count it as dead.
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return
            try:
                state = subprocess.run(
                    ["ps", "-o", "stat=", "-p", str(pid)],
                    capture_output=True, text=True, check=False,
                ).stdout.strip()
            except OSError:
                state = ""
            if state.startswith("Z") or not state:
                return
            time.sleep(0.05)
        self.fail(f"grandchild process {pid} is still alive")

    def test_timeout_default_comes_from_environment(self):
        rc, output, elapsed = self._run_ptest(env_timeout=2)
        self._assert_timeout_run(rc, output, elapsed)


if __name__ == "__main__":
    unittest.main()
