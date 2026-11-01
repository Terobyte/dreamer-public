"""The architect must cite task refs by filename, so the prompt has to name them.
Live Koshakan bathroom/bedroom: images were attached without names, the model guessed
`bathroom.png`, every round failed `reference must be an existing image inside task refs`."""
import unittest

from pipe2.fakes import FakeEngine, FakeSpark
from pipe2.floor import Floor
from pipe2.test_floor import RED, FloorCase, answer, plan, skeleton


class ArchitectSeesRefNames(FloorCase):
    def test_prompt_lists_ref_paths_relative_to_refs(self):
        d = self.task_dir / "refs" / "bathroom"
        d.mkdir(parents=True)
        (d / "0.png").write_bytes(b"\x89PNG\r\n\x1a\n")
        (d / "1.png").write_bytes(b"\x89PNG\r\n\x1a\n")
        spark = FakeSpark({"architect": [answer({"skeleton": skeleton(), "plan": plan()})]})
        Floor(self.task_dir, self.run_dir, self.deps(spark, FakeEngine([RED, RED, RED]))).run()
        text = self.architect_calls(spark)[0]["messages"][0]["content"][0]["text"]
        self.assertIn("bathroom/0.png", text)
        self.assertIn("bathroom/1.png", text)


if __name__ == "__main__":
    unittest.main()
