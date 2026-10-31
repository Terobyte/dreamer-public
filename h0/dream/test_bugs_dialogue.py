"""Bug proofs for Mind.update (dialogue.py): B44, B45. Run: python3 -m pytest -q test_bugs_dialogue.py"""

from dialogue import Mind


def test_B44_update_keeps_newest_promised_and_tried():
    """B44: with 7 PROMISED/TRIED items the NEWEST six must stay (last items),
    as the scene path does with [-TRIED_KEEP:]; actual keeps the oldest six."""
    m = Mind()
    reply = ("SO FAR: met the crew\n"
             "PROMISED: p1; p2; p3; p4; p5; p6; p7\n"
             "TRIED: t1; t2; t3; t4; t5; t6; t7")
    assert m.update(reply) is True
    assert m.promised == ["p2", "p3", "p4", "p5", "p6", "p7"]
    assert m.tried == ["t2", "t3", "t4", "t5", "t6", "t7"]


def test_B45_reply_without_labels_keeps_old_lists():
    """B45: a truncated reply 'SO FAR: b' with no KNOWS/PROMISED/TRIED labels
    must update so_far only and keep the old knows/promised/tried lists."""
    m = Mind()
    m.so_far = "a"
    m.knows = ["k1"]
    m.promised = ["p1"]
    m.tried = ["t1"]
    assert m.update("SO FAR: b") is True
    assert m.so_far == "b"
    assert m.knows == ["k1"]
    assert m.promised == ["p1"]
    assert m.tried == ["t1"]
