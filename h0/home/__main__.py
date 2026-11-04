"""python3 -m home [--port 8800] [--fake]   (cwd: h0/)"""
import argparse
import atexit
import signal
import sys

from .server import serve


def main(argv=None):
    ap = argparse.ArgumentParser(prog="home")
    ap.add_argument("--port", type=int, default=8800)
    ap.add_argument("--fake", action="store_true", help="no network, no money: stub scenes, make --fake, canned voice")
    a = ap.parse_args(argv)
    srv, home = serve(a.port, a.fake)
    atexit.register(home.shutdown)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    print("Dreamer Home: http://localhost:%d/%s" % (srv.server_address[1], "  (fake)" if a.fake else ""), flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        home.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
