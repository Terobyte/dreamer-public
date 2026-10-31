"""Regression test for dream/server.py keep-alive smuggling (bugs.md B30)."""
import json
import socket
import unittest

from server import Viewer


class FakeSim:
    def __init__(self):
        self.calls = []

    def submit(self, kind, value=None):
        self.calls.append((kind, value))


class KeepAliveSmugglingTest(unittest.TestCase):
    def test_B30_rejected_post_body_is_not_served_as_next_request(self):
        sim = FakeSim()
        viewer = Viewer(sim=sim, run=None, root=".")
        port = viewer.start(port=0)
        self.addCleanup(viewer.stop)

        host = "127.0.0.1:%d" % port
        smuggled_body = json.dumps({"text": "hello"}).encode()
        # the body of the foreign request is a complete request with no Origin header
        smuggled = (
            "POST /say HTTP/1.1\r\nHost: %s\r\nContent-Type: application/json\r\n"
            "Content-Length: %d\r\n\r\n" % (host, len(smuggled_body))
        ).encode() + smuggled_body
        first = (
            "POST /say HTTP/1.1\r\nHost: %s\r\nOrigin: http://evil.example\r\n"
            "Content-Type: application/json\r\nContent-Length: %d\r\nConnection: keep-alive\r\n\r\n"
            % (host, len(smuggled))
        ).encode() + smuggled

        with socket.create_connection(("127.0.0.1", port), timeout=10) as sock:
            sock.sendall(first)
            sock.shutdown(socket.SHUT_WR)  # EOF after the pipelined bytes: no timing guesses
            received = b""
            while True:
                chunk = sock.recv(65536)
                if not chunk:
                    break
                received += chunk

        statuses = [line.split(b" ")[1] for line in received.split(b"\r\n") if line.startswith(b"HTTP/1.1 ")]
        self.assertEqual(statuses[0], b"403", received)
        self.assertNotIn(b"200", statuses[1:], received)
        self.assertEqual(sim.calls, [], "rejected request's body reached the sim: %r" % sim.calls)


if __name__ == "__main__":
    unittest.main()
