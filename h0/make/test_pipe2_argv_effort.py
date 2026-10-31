"""Contract: pipe2 argv keeps --effort as one value (no shell splitting)."""
import unittest
import urllib.request
from pathlib import Path
from unittest import mock

from make import world


class NoNet(unittest.TestCase):
    def setUp(self):
        p = mock.patch.object(urllib.request, "urlopen", side_effect=AssertionError("network"))
        p.start()
        self.addCleanup(p.stop)


class EffortSingleArg(NoNet):
    def test_effort_with_space_stays_single_arg(self):
        a = world.pipe2_argv(Path("t"), Path("r"), effort="builder medium")
        self.assertIn("--effort", a)
        self.assertEqual(a[a.index("--effort") + 1], "builder medium")
        self.assertEqual(len(a), a.index("--effort") + 2)


if __name__ == "__main__":
    unittest.main()
