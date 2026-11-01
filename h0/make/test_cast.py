"""M6 red: `cast` path A checks cast.json + GLB, errors by field; stage runs on the fixture."""
import json
import shutil
import tempfile
import unittest
from pathlib import Path

from . import cast

FIX = Path(__file__).resolve().parent / "testdata" / "cast"


def _copy():
    d = Path(tempfile.mkdtemp()) / "cast"
    shutil.copytree(FIX, d)
    return d


def _edit(d, who, **kw):
    p = d / "cast.json"
    c = json.loads(p.read_text())
    c[who].update(kw)
    p.write_text(json.dumps(c))


class CheckCast(unittest.TestCase):
    def test_fixture_ok(self):
        self.assertEqual(cast.check_cast(FIX), [])

    def test_height_out_of_range(self):
        for h in (0.4, 2.6, "tall", None, True, False, float("nan"), float("inf")):
            d = _copy()
            _edit(d, "Jane Eyre", height_m=h)
            errs = cast.check_cast(d)
            self.assertEqual(len(errs), 1, errs)
            self.assertIn("Jane Eyre.height_m", errs[0])

    def test_unknown_voice(self):
        d = _copy()
        _edit(d, "Edward Rochester", voice="nobody")
        errs = cast.check_cast(d)
        self.assertEqual(len(errs), 1, errs)
        self.assertIn("Edward Rochester.voice", errs[0])

    def test_glb_missing_and_unreadable(self):
        d = _copy()
        (d / "jane.glb").unlink()
        self.assertIn("Jane Eyre.glb", cast.check_cast(d)[0])
        d = _copy()
        (d / "rochester.glb").write_bytes(b"not a glb")
        self.assertIn("Edward Rochester.glb", cast.check_cast(d)[0])

    def test_missing_cast_json(self):
        d = Path(tempfile.mkdtemp())
        self.assertIn("cast.json", cast.check_cast(d)[0])

    def test_height_endpoints_accepted(self):
        for h in (0.5, 2.5):
            d = _copy()
            _edit(d, "Jane Eyre", height_m=h)
            self.assertEqual(cast.check_cast(d), [], h)

    def test_voice_id_rejected_label_accepted(self):
        import json as _json
        voices = _json.loads(cast.VOICES.read_text())
        vid = voices["woman"]
        self.assertNotEqual(vid, "woman")
        d = _copy()
        _edit(d, "Jane Eyre", voice=vid)
        errs = cast.check_cast(d)
        self.assertEqual(len(errs), 1, errs)
        self.assertIn("Jane Eyre.voice", errs[0])
        d = _copy()
        _edit(d, "Jane Eyre", voice="woman")
        self.assertEqual(cast.check_cast(d), [])

    def test_glb_truncated_rejected(self):
        d = _copy()
        (d / "jane.glb").write_bytes(b"glTF")
        errs = cast.check_cast(d)
        self.assertTrue(any("Jane Eyre.glb" in e for e in errs), errs)

    def test_glb_path_must_stay_inside(self):
        import shutil as _shutil
        d = _copy()
        _shutil.copyfile(FIX / "jane.glb", d.parent / "outside.glb")
        outside_abs = str((d.parent / "outside.glb").resolve())
        for g in ("../outside.glb", outside_abs):
            import json as _json
            p = d / "cast.json"
            c = _json.loads(p.read_text())
            c["Jane Eyre"]["glb"] = g
            p.write_text(_json.dumps(c))
            errs = cast.check_cast(d)
            self.assertTrue(any("Jane Eyre.glb" in e for e in errs), (g, errs))

    def test_voice_unhashable_is_field_error(self):
        for v in ([], {}):
            d = _copy()
            _edit(d, "Jane Eyre", voice=v)
            errs = cast.check_cast(d)
            self.assertEqual(len(errs), 1, errs)
            self.assertIn("Jane Eyre.voice", errs[0])

    def test_glb_json_payload_must_parse(self):
        import struct as _struct
        payload = b"nope"
        total = 12 + 8 + len(payload)
        blob = (_struct.pack("<III", 0x46546C67, 2, total)
                + _struct.pack("<I4s", len(payload), b"JSON") + payload)
        d = _copy()
        (d / "jane.glb").write_bytes(blob)
        errs = cast.check_cast(d)
        self.assertTrue(any("Jane Eyre.glb" in e for e in errs), errs)

    def test_glb_nul_byte_is_field_error(self):
        d = _copy()
        _edit(d, "Jane Eyre", glb="bad\0name.glb")
        errs = cast.check_cast(d)
        self.assertEqual(len(errs), 1, errs)
        self.assertIn("Jane Eyre.glb", errs[0])

    def test_glb_empty_json_object_rejected(self):
        import struct as _struct
        payload = b"{}"
        total = 12 + 8 + len(payload)
        blob = (_struct.pack("<III", 0x46546C67, 2, total)
                + _struct.pack("<I4s", len(payload), b"JSON") + payload)
        d = _copy()
        (d / "jane.glb").write_bytes(blob)
        errs = cast.check_cast(d)
        self.assertTrue(any("Jane Eyre.glb" in e for e in errs), errs)

    def test_glb_version_only_rejected(self):
        import struct as _struct
        payload = b'{"asset":{"version":"2.0"}}'
        total = 12 + 8 + len(payload)
        blob = (_struct.pack("<III", 0x46546C67, 2, total)
                + _struct.pack("<I4s", len(payload), b"JSON") + payload)
        d = _copy()
        (d / "jane.glb").write_bytes(blob)
        errs = cast.check_cast(d)
        self.assertTrue(any("Jane Eyre.glb" in e for e in errs), errs)

    def test_sex_required(self):
        import json as _json
        d = _copy()
        p = d / "cast.json"
        c = _json.loads(p.read_text())
        del c["Jane Eyre"]["sex"]
        p.write_text(_json.dumps(c))
        errs = cast.check_cast(d)
        self.assertEqual(len(errs), 1, errs)
        self.assertIn("Jane Eyre.sex", errs[0])

    def test_sex_must_be_male_or_female(self):
        d = _copy()
        _edit(d, "Jane Eyre", sex="other")
        errs = cast.check_cast(d)
        self.assertEqual(len(errs), 1, errs)
        self.assertIn("Jane Eyre.sex", errs[0])

    def test_look_required(self):
        import json as _json
        for look in (None, "", "  "):
            d = _copy()
            if look is None:
                p = d / "cast.json"
                c = _json.loads(p.read_text())
                del c["Jane Eyre"]["look"]
                p.write_text(_json.dumps(c))
            else:
                _edit(d, "Jane Eyre", look=look)
            errs = cast.check_cast(d)
            self.assertEqual(len(errs), 1, errs)
            self.assertIn("Jane Eyre.look", errs[0])


    def test_glb_mesh_without_primitives_rejected(self):
        import struct as _struct
        import json as _json
        doc = {"asset": {"version": "2.0"}, "scene": 0,
               "scenes": [{"nodes": [0]}], "nodes": [{"mesh": 0}],
               "meshes": [{"name": "body"}]}
        payload = _json.dumps(doc).encode()
        total = 12 + 8 + len(payload)
        blob = (_struct.pack("<III", 0x46546C67, 2, total)
                + _struct.pack("<I4s", len(payload), b"JSON") + payload)
        d = _copy()
        (d / "jane.glb").write_bytes(blob)
        errs = cast.check_cast(d)
        self.assertTrue(any("Jane Eyre.glb" in e for e in errs), errs)

    def test_glb_dangling_scene_node_rejected(self):
        import struct as _struct
        import json as _json
        doc = {"asset": {"version": "2.0"}, "scene": 0,
               "scenes": [{"nodes": [99]}], "nodes": [{"mesh": 0}],
               "meshes": [{"primitives": [{"attributes": {"POSITION": 0}}]}]}
        payload = _json.dumps(doc).encode()
        total = 12 + 8 + len(payload)
        blob = (_struct.pack("<III", 0x46546C67, 2, total)
                + _struct.pack("<I4s", len(payload), b"JSON") + payload)
        d = _copy()
        (d / "jane.glb").write_bytes(blob)
        errs = cast.check_cast(d)
        self.assertTrue(any("Jane Eyre.glb" in e for e in errs), errs)

    def test_glb_orphan_mesh_rejected(self):
        import struct as _struct
        import json as _json
        doc = {"asset": {"version": "2.0"}, "scene": 0,
               "scenes": [{"nodes": [0]}], "nodes": [{}, {"mesh": 0}],
               "meshes": [{"primitives": [{"attributes": {"POSITION": 0}}]}]}
        payload = _json.dumps(doc).encode()
        total = 12 + 8 + len(payload)
        blob = (_struct.pack("<III", 0x46546C67, 2, total)
                + _struct.pack("<I4s", len(payload), b"JSON") + payload)
        d = _copy()
        (d / "jane.glb").write_bytes(blob)
        errs = cast.check_cast(d)
        self.assertTrue(any("Jane Eyre.glb" in e for e in errs), errs)


def _glb_blob(doc, bin_bytes=None):
    import struct as _struct
    payload = json.dumps(doc).encode()
    payload += b" " * (-len(payload) % 4)
    chunks = _struct.pack("<I4s", len(payload), b"JSON") + payload
    if bin_bytes is not None:
        bin_bytes += b"\0" * (-len(bin_bytes) % 4)
        chunks += _struct.pack("<I4s", len(bin_bytes), b"BIN\0") + bin_bytes
    return _struct.pack("<III", 0x46546C67, 2, 12 + len(chunks)) + chunks


def _tri_doc(**over):
    doc = {"asset": {"version": "2.0"}, "scene": 0,
           "scenes": [{"nodes": [0]}], "nodes": [{"mesh": 0}],
           "meshes": [{"primitives": [{"attributes": {"POSITION": 0}}]}],
           "accessors": [{"bufferView": 0, "componentType": 5126, "count": 3,
                          "type": "VEC3"}],
           "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": 36}],
           "buffers": [{"byteLength": 36}]}
    doc.update(over)
    return doc


class GlbGeometry(unittest.TestCase):
    """F5/F7: the reachable mesh must carry loadable POSITION geometry."""

    def _errs(self, blob):
        d = _copy()
        (d / "jane.glb").write_bytes(blob)
        return [e for e in cast.check_cast(d) if "Jane Eyre.glb" in e]

    def test_valid_triangle_accepted(self):
        self.assertEqual(self._errs(_glb_blob(_tri_doc(), b"\0" * 36)), [])

    def test_attribute_without_accessors_rejected(self):  # F7
        doc = _tri_doc()
        for k in ("accessors", "bufferViews", "buffers"):
            doc.pop(k)
        self.assertTrue(self._errs(_glb_blob(doc)))

    def test_no_position_attribute_rejected(self):
        doc = _tri_doc(meshes=[{"primitives": [{"attributes": {"NORMAL": 0}}]}])
        self.assertTrue(self._errs(_glb_blob(doc, b"\0" * 36)))

    def test_accessor_index_out_of_range_rejected(self):
        doc = _tri_doc(meshes=[{"primitives": [{"attributes": {"POSITION": 5}}]}])
        self.assertTrue(self._errs(_glb_blob(doc, b"\0" * 36)))

    def test_accessor_without_buffer_view_rejected(self):
        doc = _tri_doc(accessors=[{"componentType": 5126, "count": 3, "type": "VEC3"}])
        self.assertTrue(self._errs(_glb_blob(doc, b"\0" * 36)))

    def test_accessor_overflows_buffer_view_rejected(self):
        doc = _tri_doc(accessors=[{"bufferView": 0, "componentType": 5126,
                                   "count": 30, "type": "VEC3"}])
        self.assertTrue(self._errs(_glb_blob(doc, b"\0" * 36)))

    def test_bin_chunk_missing_or_short_rejected(self):
        self.assertTrue(self._errs(_glb_blob(_tri_doc())))
        self.assertTrue(self._errs(_glb_blob(_tri_doc(), b"\0" * 8)))

    def test_buffer_view_outside_buffer_rejected(self):
        doc = _tri_doc(bufferViews=[{"buffer": 0, "byteOffset": 24, "byteLength": 36}])
        self.assertTrue(self._errs(_glb_blob(doc, b"\0" * 36)))

    def test_external_buffer_uri_rejected(self):
        doc = _tri_doc(buffers=[{"byteLength": 36, "uri": "mesh.bin"}])
        self.assertTrue(self._errs(_glb_blob(doc)))

    def test_bad_accessor_fields_rejected(self):
        for acc in ({"bufferView": 0, "componentType": 1, "count": 3, "type": "VEC3"},
                    {"bufferView": 0, "componentType": 5126, "count": 0, "type": "VEC3"},
                    {"bufferView": 0, "componentType": 5126, "count": 3, "type": "VEC9"},
                    {"bufferView": 0, "componentType": 5126, "count": 3, "type": "SCALAR"}):
            doc = _tri_doc(accessors=[acc])
            self.assertTrue(self._errs(_glb_blob(doc, b"\0" * 36)), acc)

    def test_malformed_field_types_are_field_errors(self):  # F8
        bad = [
            _tri_doc(nodes=[{"mesh": 0, "children": 7}]),
            _tri_doc(nodes=[{"mesh": 0, "children": [[0]]}]),
            _tri_doc(accessors=[{"bufferView": 0, "componentType": [5126], "count": 3,
                                 "type": "VEC3"}]),
            _tri_doc(accessors=[{"bufferView": 0, "componentType": 5126, "count": 3,
                                 "type": ["VEC3"]}]),
            _tri_doc(meshes=[{"primitives": [{"attributes": {"POSITION": [0]}}]}]),
            _tri_doc(meshes=[{"primitives": [{"attributes": {"POSITION": 0},
                                              "indices": {"a": 1}}]}]),
            _tri_doc(asset={"version": 2}),
            _tri_doc(scenes=[{"nodes": 0}]),
        ]
        for doc in bad:
            self.assertTrue(self._errs(_glb_blob(doc, b"\0" * 36)), doc)


class GlbIndices(unittest.TestCase):
    """F10: primitive indices must be SCALAR with an unsigned integer component type."""

    def _doc(self, idx_acc):
        return _tri_doc(
            meshes=[{"primitives": [{"attributes": {"POSITION": 0}, "indices": 1}]}],
            accessors=[{"bufferView": 0, "componentType": 5126, "count": 3, "type": "VEC3"},
                       {"bufferView": 1, **idx_acc}],
            bufferViews=[{"buffer": 0, "byteOffset": 0, "byteLength": 36},
                         {"buffer": 0, "byteOffset": 36, "byteLength": 36}],
            buffers=[{"byteLength": 72}])

    def _errs(self, doc):
        d = _copy()
        (d / "jane.glb").write_bytes(_glb_blob(doc, b"\0" * 72))
        return [e for e in cast.check_cast(d) if "Jane Eyre.glb" in e]

    def test_valid_indices_accepted(self):
        for ct in (5121, 5123, 5125):
            self.assertEqual(self._errs(self._doc({"componentType": ct, "count": 3,
                                                   "type": "SCALAR"})), [], ct)

    def test_bad_indices_rejected(self):
        for acc in ({"componentType": 5126, "count": 3, "type": "VEC3"},
                    {"componentType": 5126, "count": 3, "type": "SCALAR"},
                    {"componentType": 5120, "count": 3, "type": "SCALAR"},
                    {"componentType": 5122, "count": 3, "type": "SCALAR"},
                    {"componentType": 5125, "count": 1, "type": "VEC3"}):
            errs = self._errs(self._doc(acc))
            self.assertEqual(len(errs), 1, acc)


class HeightHuge(unittest.TestCase):
    def test_huge_int_height_is_field_error(self):  # F9
        for h in (10 ** 1000, -(10 ** 1000)):
            d = _copy()
            _edit(d, "Jane Eyre", height_m=h)
            errs = cast.check_cast(d)
            self.assertEqual(len(errs), 1, errs)
            self.assertIn("Jane Eyre.height_m", errs[0])


if __name__ == "__main__":
    unittest.main()
