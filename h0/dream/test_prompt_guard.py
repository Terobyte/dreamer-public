"""F5 guard: comic.html whisper hook must not break the pov harness.

The pov order tests extract the snapshot/pov cases and the snapshot-listener
body into a node harness without the rest of the page. A bare promptTake()
call there throws ReferenceError (red gate: 3 failures). The whisper must
stay, but guarded.
usage: cd h0/dream && python3 -m unittest -q test_prompt_guard
"""
import os
import re
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))


def _html():
    with open(os.path.join(HERE, "comic.html"), encoding="utf-8") as f:
        return f.read()


class PromptGuardTest(unittest.TestCase):
    def test_snapshot_and_status_hooks_are_guarded(self):
        html = _html()
        snap = re.search(r'case "snapshot":(.*?)break;', html, re.S).group(1)
        status = re.search(r'es\.addEventListener\("snapshot", \(e\) => \{(.*?)\n  \}\);',
                           html, re.S).group(1)
        for chunk in (snap, status):
            if "promptTake" in chunk:
                self.assertIn("typeof promptTake", chunk,
                              "bare promptTake() throws in the extracted harness; "
                              "guard it with typeof")
        # F5 contract still holds: whisper rendered from waiting_for/prompt_text
        self.assertIn("waiting_for", html)
        self.assertIn("prompt_text", html)


if __name__ == "__main__":
    unittest.main()
