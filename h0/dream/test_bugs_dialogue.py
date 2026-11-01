"""Bug proofs for Mind.update (dialogue.py): B44, B45. Run: python3 -m unittest test_bugs_dialogue"""

import unittest

from dialogue import Mind


class MindUpdateBugs(unittest.TestCase):

    def test_B44_update_keeps_newest_promised_and_tried(self):
        """B44: with 7 PROMISED/TRIED items the NEWEST six must stay (last items),
        as the scene path does with [-TRIED_KEEP:]; actual keeps the oldest six."""
        m = Mind()
        reply = ("SO FAR: met the crew\n"
                 "PROMISED: p1; p2; p3; p4; p5; p6; p7\n"
                 "TRIED: t1; t2; t3; t4; t5; t6; t7")
        self.assertTrue(m.update(reply))
        self.assertEqual(m.promised, ["p2", "p3", "p4", "p5", "p6", "p7"])
        self.assertEqual(m.tried, ["t2", "t3", "t4", "t5", "t6", "t7"])


    def test_B45_reply_without_labels_keeps_old_lists(self):
        """B45: a truncated reply 'SO FAR: b' with no KNOWS/PROMISED/TRIED labels
        must update so_far only and keep the old knows/promised/tried lists."""
        m = Mind()
        m.so_far = "a"
        m.knows = ["k1"]
        m.promised = ["p1"]
        m.tried = ["t1"]
        self.assertTrue(m.update("SO FAR: b"))
        self.assertEqual(m.so_far, "b")
        self.assertEqual(m.knows, ["k1"])
        self.assertEqual(m.promised, ["p1"])
        self.assertEqual(m.tried, ["t1"])


if __name__ == "__main__":
    unittest.main()
