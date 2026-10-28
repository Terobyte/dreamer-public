"""Red: merge/select must not depend on top-level `import llm` (spec section 7).

memory.py calls Spark for episode merge and fact selection. With a bare
`import llm` that only resolves when cwd is h0/dream, the same code used
as a package (or whenever top-level `llm` is unimportable) silently skips
the merge instead of building it from episodes_raw/.
usage: cd h0/dream && python3 -m unittest test_contract_importpath -q
"""

import os
import sys
import tempfile
import unittest

from fake import FakeTransport


def _load_package_memory():
    root = os.path.dirname(os.path.dirname(
        os.path.dirname(os.path.abspath(__file__))))
    if root not in sys.path:
        sys.path.insert(0, root)
    import h0.dream.memory as pkg_mem
    return pkg_mem


class ImportPathTest(unittest.TestCase):
    def test_merge_from_raw_without_toplevel_llm(self):
        pkg_mem = _load_package_memory()
        saved = sys.modules.get("llm", "--absent--")
        sys.modules["llm"] = None  # bare `import llm` now raises ImportError
        self.addCleanup(lambda: (
            sys.modules.pop("llm", None)
            if saved == "--absent--"
            else sys.modules.update(llm=saved)))
        m = pkg_mem.Memory(root=tempfile.mkdtemp())
        m.set_core(desire="wants quiet", anxiety="fears shouting",
                   scene="squidward living room",
                   objects=["clarinet"], bridge="none yet")
        fake = FakeTransport(script=["merged summary"])
        m.transport = fake
        m.save_episode_raw("a", "A raw")
        m.save_episode_raw("b", "B raw")
        m.merge_from_raw()
        self.assertEqual(fake.calls, 1)
        self.assertEqual(len(m.episodes), 1)
        sent = fake.sent[0]["messages"][0]["content"]
        self.assertIn("A raw", sent)
        self.assertIn("B raw", sent)


if __name__ == "__main__":
    unittest.main()
