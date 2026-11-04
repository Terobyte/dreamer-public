"""One child process at a time: a scene being played (make.play / place.serve), and one guest build (make).

The scene process prints its page URL as the first line that starts with http:// (make.play, place.serve
both do); Home waits for that line and hands the URL to the page. Children run in their own process
group, so a stop takes make.play's sim and static server threads and any grandchildren with it.
"""
import os
import signal
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

H0 = Path(__file__).resolve().parents[1]
LOGS = Path(__file__).with_name("logs")
URL_TIMEOUT_S = 20.0
KILL_AFTER_S = 3.0
ALIVE_CHECK_S = 1.5
PAGE_TIMEOUT_S = 5.0


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _close(p):
    if p is not None and p.stdout is not None:
        try:
            p.stdout.close()
        except OSError:
            pass


def _kill_group(p, wait=KILL_AFTER_S):
    if p is None:
        return
    if p.poll() is not None:
        try:
            os.killpg(p.pid, signal.SIGTERM)   # the leader is gone, its children may not be
        except (ProcessLookupError, PermissionError):
            pass
        _close(p)
        return
    try:
        os.killpg(p.pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        return
    try:
        p.wait(wait)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        p.wait(wait)
    _close(p)


def _page_answers(url, timeout=PAGE_TIMEOUT_S):
    """GET the scene page until it answers 200 (make.play's static server, place.serve, the fake stub)"""
    import urllib.request
    end = time.time() + timeout
    while time.time() < end:
        try:
            with urllib.request.urlopen(url, timeout=2) as r:
                if r.status == 200:
                    return True
        except OSError:
            pass
        time.sleep(0.2)
    return False


def _log_path(tag):
    LOGS.mkdir(exist_ok=True)
    return LOGS / ("%s-%s.log" % (time.strftime("%Y%m%d-%H%M%S"), tag))


def tail(path, n=5):
    try:
        return Path(path).read_text(errors="replace").splitlines()[-n:]
    except OSError:
        return []


class LaunchError(Exception):
    def __init__(self, msg, log=None, code=502):
        super().__init__(msg)
        self.log = log
        self.code = code


class Scene:
    """the one scene being played"""

    def __init__(self):
        self.mu = threading.Lock()
        self.proc = None
        self.info = None      # {"id", "mode", "url", "log"}
        self.last_log = None
        self.last = None      # the scene that died on its own

    def current(self):
        with self.mu:
            if self.proc is not None and self.proc.poll() is not None:
                self.last = self.info            # it died on its own: keep what it was for /api/session
                _kill_group(self.proc)           # its children, if any; closes the pipe
                self.proc, self.info = None, None
            return dict(self.info) if self.info else None

    def stop(self):
        with self.mu:
            _kill_group(self.proc)
            self.proc, self.info, self.last = None, None, None

    def status(self):
        """{alive, id?, mode?, url?, log}: the page polls it while a scene is open"""
        cur = self.current()
        out = {"alive": cur is not None, "log": tail(self.last_log) if self.last_log else []}
        info = cur or self.last
        if info:
            out.update({k: info[k] for k in ("id", "mode", "url")})
        return out

    def start(self, sid, mode, argv, timeout=URL_TIMEOUT_S):
        """argv: the full command; -> url. The previous scene is stopped first."""
        with self.mu:
            _kill_group(self.proc)
            self.proc, self.info = None, None
            log = _log_path(sid)
            lf = open(log, "w", buffering=1)
            p = subprocess.Popen(argv, cwd=str(H0), stdout=subprocess.PIPE, stderr=lf, stdin=subprocess.DEVNULL,
                                 text=True, bufsize=1, start_new_session=True,
                                 env=dict(os.environ, PYTHONUNBUFFERED="1"))
            url, box = None, {}

            def read():
                try:
                    for line in p.stdout:
                        lf.write(line)
                        if "url" not in box and line.strip().startswith("http://"):
                            box["url"] = line.strip()
                            box["ev"].set()
                except (ValueError, OSError):
                    pass   # the pipe was closed by a stop
                box["ev"].set()
                lf.close()

            box["ev"] = threading.Event()
            threading.Thread(target=read, daemon=True).start()
            box["ev"].wait(timeout)
            url = box.get("url")
            if url is None:
                dead = p.poll() is not None
                _kill_group(p)
                self.last_log = str(log)
                raise LaunchError("the scene exited before it was ready" if dead
                                  else "no page URL in %gs" % timeout, log=str(log), code=502 if dead else 504)
            try:
                p.wait(ALIVE_CHECK_S)      # make.play prints the URL before play() loads the stage
            except subprocess.TimeoutExpired:
                pass
            if p.poll() is not None or not _page_answers(url):
                _kill_group(p)
                self.last_log = str(log)
                raise LaunchError("the scene stopped right after it started" if p.poll() is not None
                                  else "the scene page did not answer", log=str(log), code=502)
            self.proc = p
            self.info = {"id": sid, "mode": mode, "url": url, "log": str(log)}
            self.last_log = str(log)
            return url


class Build:
    """the one guest build: a prepare step in a thread (the chapter), then `python -m make ...`"""

    def __init__(self):
        self.mu = threading.Lock()
        self.proc = None
        self.thread = None
        self.run = None
        self.log = None
        self.stopped = False

    def busy(self):
        with self.mu:
            return (self.thread is not None and self.thread.is_alive()) or \
                (self.proc is not None and self.proc.poll() is None)

    def state(self, run):
        """(alive, exit code or None) for this run; (False, None) if this Home did not start it"""
        with self.mu:
            if self.run is None or Path(run).resolve() != self.run:
                return False, None
            if self.thread is not None and self.thread.is_alive():
                return True, None
            if self.proc is None:
                return False, (1 if self.stopped else None)
            code = self.proc.poll()
            return code is None, code

    def begin(self, run, prepare):
        """prepare() -> argv for make, or None (it failed and said why itself). Raises 429 if busy."""
        if self.busy():
            raise LaunchError("a build is already running", code=429)
        with self.mu:
            self.run, self.proc, self.stopped = Path(run).resolve(), None, False
            self.log = _log_path(Path(run).name)

            def go():
                argv = prepare()
                with self.mu:
                    if argv is None or self.stopped:
                        return
                    with open(self.log, "w", buffering=1) as lf:
                        self.proc = subprocess.Popen(argv, cwd=str(H0), stdout=lf, stderr=subprocess.STDOUT,
                                                     stdin=subprocess.DEVNULL, start_new_session=True,
                                                     env=dict(os.environ, PYTHONUNBUFFERED="1"))

            self.thread = threading.Thread(target=go, daemon=True)
            self.thread.start()

    def stop(self):
        with self.mu:
            self.stopped = True
            _kill_group(self.proc)


def python():
    return sys.executable
