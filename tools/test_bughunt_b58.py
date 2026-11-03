"""B58: gate.sh report loop skips a suite whose .rc file is missing and exits 0."""
import subprocess
from pathlib import Path

GATE = Path(__file__).resolve().parent / "gate.sh"


def test_missing_rc_file_is_a_failure(tmp_path):
    src = GATE.read_text()
    tail = src[src.index("# green suites first"):]  # the real report loop of gate.sh
    logs = tmp_path / "logs"
    logs.mkdir()
    for s in ("make", "py", "engine"):
        (logs / f"{s}.rc").write_text("0\n")
        (logs / s).write_text("ok\n")
    # suite `dream` was killed before `echo $? >"$logs/dream.rc"`: no dream.rc on disk
    r = subprocess.run(["bash", "-c", f'logs="{logs}"\n{tail}'], capture_output=True, text=True,
                       cwd=GATE.parent.parent)  # gate.sh runs from the repo root (h0/make is checked there)
    assert r.returncode == 1, (
        f"expected: gate exit 1 when dream.rc is missing (suite did not finish); "
        f"actual: exit {r.returncode}, stdout={r.stdout!r}")
