from pipe2.floor import attach_refs


def _with_ref(tmp_path, prop_id):
    frame = tmp_path / "bedroom.png"
    frame.write_bytes(b"frame")
    scene = {"assets": {"a": {"kind": "object"}},
             "props": [{"id": prop_id, "asset": "a", "room": "bedroom"}]}
    plan = {"rooms": {"bedroom": {"refs": [str(frame)]}}}
    attach_refs(scene, plan, tmp_path / "run")
    return scene["assets"]["a"]["ref"]


def test_numbered_container_id_still_uses_redraw(tmp_path):
    ref = _with_ref(tmp_path, "bedroom_table_1")
    assert ref.get("mode") == "redraw", f"expected redraw mode for table container, got {ref!r}"
    assert ref["what"] == "table with everything standing on it and inside it"


def test_unqualified_container_id_uses_redraw(tmp_path):
    ref = _with_ref(tmp_path, "bedroom_table")
    assert ref.get("mode") == "redraw"
    assert ref["what"] == "table with everything standing on it and inside it"


def test_descriptive_suffix_container_ids_use_redraw(tmp_path):
    assert _with_ref(tmp_path, "bedroom_nightstand_left")["what"].startswith("nightstand with")
    assert _with_ref(tmp_path, "bedroom_shelf_small")["what"].startswith("shelf with")


def test_non_container_what_is_not_a_bare_suffix(tmp_path):
    ref = _with_ref(tmp_path, "bedroom_lamp_1")
    assert "mode" not in ref and ref["what"] == "lamp 1"
