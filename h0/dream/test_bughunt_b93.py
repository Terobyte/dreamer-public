# gate wiring: runs under tools/ptest.py (unittest) with cwd h0/dream
"""B93: null token counts fall back to the estimates, as missing ones do."""
import unittest

import llm


class B93(unittest.TestCase):
    def test_piece_parts_uses_estimates_when_usage_counts_are_null(self):
        prompt_tokens = 17
        expected = ("hello", prompt_tokens, llm._tokens("hello"))
        # control: absent provider counts already use the estimates
        self.assertEqual(llm._piece_parts({"content": "hello", "usage": {}}, prompt_tokens), expected)
        piece = {"content": "hello", "usage": {"prompt_tokens": None, "completion_tokens": None}}
        self.assertEqual(llm._piece_parts(piece, prompt_tokens), expected)

    def test_real_counts_win(self):
        piece = {"content": "hello", "usage": {"prompt_tokens": 3, "completion_tokens": 0}}
        self.assertEqual(llm._piece_parts(piece, 17), ("hello", 3, 0))


if __name__ == "__main__":
    unittest.main()
