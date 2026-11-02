import subprocess
import ptest


def _fake_list_run(*a, **k):
    class R:
        returncode = 0
        stdout = "mymod.MyClass\n"
    return R()


def test_exit_code_5_is_failure(monkeypatch, capsys):
    monkeypatch.setattr(subprocess, "run", _fake_list_run)
    monkeypatch.setattr(ptest, "run_one", lambda n, cwd, timeout: (n, 5, 0.1, "out"))
    rc = ptest.main(["mymod"])
    assert rc == 1, f"exit code 5 must be FAIL (rc=1), got {rc}"
    out = capsys.readouterr().out
    assert "FAIL" in out, f"output must contain FAIL, got: {out!r}"
