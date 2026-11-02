"""Run unittest test classes in parallel processes, one process per class.

  python3 tools/ptest.py [-j N] [--cwd DIR] [--timeout SEC] module...

The tests mostly wait on clocks, not the CPU, so classes run side by side.
A child process lists the classes first (`--list`); the largest modules start first.
Output of a failed class is printed whole; passing ones get one line.
A class that runs longer than --timeout (env PTEST_TIMEOUT, default 300 s) is killed with
its whole process group and reported as TIMEOUT; the other classes still run.
Exit 1 if any class fails or times out.
"""
import argparse
import os
import signal
import subprocess
import sys
import time
import unittest
from concurrent.futures import ThreadPoolExecutor


def list_classes(modules):
    """module -> ['module.Class', ...] for every class that has tests; a module that
    does not import stays as is, so its own run shows the error."""
    sys.path.insert(0, os.getcwd())
    loader = unittest.TestLoader()
    for mod in modules:
        try:
            suite = loader.loadTestsFromName(mod)
        except Exception:
            print(mod)
            continue
        seen = []
        stack = [suite]
        while stack:
            s = stack.pop(0)
            if isinstance(s, unittest.TestSuite):
                stack.extend(s)
            else:
                c = type(s)
                name = f"{c.__module__}.{c.__qualname__}"
                if c.__module__ != mod or isinstance(s, unittest.loader._FailedTest):
                    name = mod
                if name not in seen:
                    seen.append(name)
        for name in seen:
            print(name)


DEFAULT_TIMEOUT = 300.0
TIMEOUT = "timeout"


def run_one(name, cwd, timeout):
    """-> (name, returncode or TIMEOUT, seconds, output). The class runs in its own session,
    so a timeout kills everything it started (servers, chrome, sleeping grandchildren)."""
    t = time.monotonic()
    p = subprocess.Popen([sys.executable, "-m", "unittest", "-q", name], cwd=cwd,
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                         start_new_session=True)
    try:
        out, _ = p.communicate(timeout=timeout)
        rc = p.returncode
    except subprocess.TimeoutExpired:
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        try:
            out, _ = p.communicate(timeout=5)
        except subprocess.TimeoutExpired:  # a grandchild outside the group still holds the pipe
            out = ""
        rc = TIMEOUT
    return name, rc, time.monotonic() - t, out or ""


def main(argv=None):
    ap = argparse.ArgumentParser(prog="ptest")
    ap.add_argument("-j", type=int, default=min(8, os.cpu_count() or 4))
    ap.add_argument("--cwd", default=".")
    ap.add_argument("--timeout", type=float,
                    default=float(os.environ.get("PTEST_TIMEOUT") or DEFAULT_TIMEOUT),
                    help="seconds per class before it is killed (env PTEST_TIMEOUT)")
    ap.add_argument("--list", action="store_true", help=argparse.SUPPRESS)
    ap.add_argument("modules", nargs="+")
    a = ap.parse_args(argv)
    if a.list:
        list_classes(a.modules)
        return 0
    t0 = time.monotonic()
    def size(m):
        f = os.path.join(a.cwd, *m.split(".")) + ".py"
        return os.path.getsize(f) if os.path.isfile(f) else 0
    mods = sorted(a.modules, key=size, reverse=True)
    p = subprocess.run([sys.executable, os.path.abspath(__file__), "--list", *mods], cwd=a.cwd,
                       stdout=subprocess.PIPE, text=True)
    names = p.stdout.split() if p.returncode == 0 else mods
    failed = []
    with ThreadPoolExecutor(a.j) as ex:
        for name, rc, dt, out in ex.map(lambda n: run_one(n, a.cwd, a.timeout), names):
            if rc == TIMEOUT:
                failed.append(name)
                print(f"TIMEOUT {name} ({dt:.1f}s, limit {a.timeout:g}s)\n{out}", flush=True)
            elif rc and not (rc == 5 and "NO TESTS RAN" in out):  # 5 is ok only when unittest says no tests ran (all skipped by name)
                failed.append(name)
                print(f"FAIL {name} ({dt:.1f}s)\n{out}", flush=True)
            else:
                print(f"ok   {name} ({dt:.1f}s)", flush=True)
    print(f"{len(names)} classes from {len(mods)} modules in {time.monotonic() - t0:.1f}s, "
          f"{'FAILED: ' + ' '.join(failed) if failed else 'OK'}", flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
