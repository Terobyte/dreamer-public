"""B88: a malformed on-disk tone cache should fall back to the director."""
import json

import voice_tone


SCORE = {"scene": "room", "beats": [{"id": 1, "kind": "line", "who": "Hero", "text": "Hello."}]}


def test_empty_tone_cache_falls_back_to_director(tmp_path):
    key = voice_tone.hashlib.sha256(
        json.dumps({"v": voice_tone.VERSION, "prompt": voice_tone.tone_prompt(SCORE)},
                   ensure_ascii=False).encode()
    ).hexdigest()
    cache_file = tmp_path / f"tone-{key}.json"
    cache_file.write_text("", encoding="utf-8")

    calls = []

    def director(prompt):
        calls.append(prompt)
        return '{"tones": [{"id": 1, "tone": "warm"}]}'

    try:
        result = voice_tone.add_tones(SCORE, director, str(tmp_path))
    except Exception as exc:
        actual = {"exception": f"{type(exc).__name__}: {exc}", "director_calls": len(calls)}
    else:
        actual = {"warnings": result[1], "tone": result[0]["beats"][0].get("tone"),
                  "director_calls": len(calls)}

    # Control: without the corrupt-cache trigger, the same fake director answers normally.
    clean, clean_warnings = voice_tone.add_tones(SCORE, lambda _: '{"tones": [{"id": 1, "tone": "warm"}]}')
    assert clean["beats"][0]["tone"] == "warm"
    assert clean_warnings == []
    expected = {"warnings": [], "tone": "warm", "director_calls": 1}
    assert actual == expected, f"expected corrupt-cache fallback {expected!r}; actual {actual!r}"
