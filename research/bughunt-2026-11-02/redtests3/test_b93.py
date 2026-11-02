"""B93: null token counts should fall back to estimated counts."""

import llm


def test_piece_parts_uses_estimates_when_usage_counts_are_null():
    prompt_tokens = 17
    piece = {
        "content": "hello",
        "usage": {"prompt_tokens": None, "completion_tokens": None},
    }

    # Control: absent provider counts already use the documented estimates.
    assert llm._piece_parts({"content": "hello", "usage": {}}, prompt_tokens) == (
        "hello", prompt_tokens, llm._tokens("hello")
    )

    try:
        actual = llm._piece_parts(piece, prompt_tokens)
    except Exception as exc:
        actual = f"{type(exc).__name__}: {exc}"

    expected = ("hello", prompt_tokens, llm._tokens("hello"))
    assert actual == expected, f"expected estimated usage {expected!r}; actual {actual!r}"
