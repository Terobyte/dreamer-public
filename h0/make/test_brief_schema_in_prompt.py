"""Live Spark cannot open make/schema/brief.json: the brief prompt must carry the schema itself."""
import unittest

from make import brief


class TestBriefSchemaInPrompt(unittest.TestCase):
    def test_prompt_carries_schema_enums(self):
        seen = []

        def ask(messages):
            seen.append(messages)
            raise brief.BriefFailed("stop after first call")

        with self.assertRaises(brief.BriefFailed):
            brief.make_brief("a room", ask)
        text = "\n".join(m["content"] for m in seen[0])
        for word in ("size_m", "provider_hint", "where", "want", "old_woman", "fandom"):
            self.assertIn(word, text, f"{word!r} from schema/brief.json is not in the prompt Spark sees")


if __name__ == "__main__":
    unittest.main()
