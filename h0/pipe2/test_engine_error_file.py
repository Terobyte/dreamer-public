"""L53: an EngineError writes the whole CLI output to a file and keeps only the head in its message."""

from pathlib import Path

from pipe2.engine import ENGINE_ERROR_HEAD, EngineError


def test_whole_output_in_a_file_head_in_the_message():
    raw = "\n".join("error %d" % i for i in range(500))
    e = EngineError(2, raw)
    assert e.raw == raw and e.code == 2
    assert Path(e.path).read_text(encoding="utf-8") == raw
    msg = str(e)
    assert "error 0" in msg and "error %d" % (ENGINE_ERROR_HEAD - 1) in msg
    assert "error 499" not in msg
    assert "460 more lines" in msg and e.path in msg
    Path(e.path).unlink()


def test_short_output_whole_in_the_message():
    e = EngineError(1, "boom")
    assert "boom" in str(e) and "more lines" not in str(e)
    Path(e.path).unlink()
