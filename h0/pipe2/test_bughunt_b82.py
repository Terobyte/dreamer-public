import json
import subprocess

from pipe2.engine import Engine


def _fake_cli(args):
    if "--report" in args:
        report = args[args.index("--report") + 1]
        with open(report, "w", encoding="utf-8") as f:
            json.dump({"errors": [], "warnings": []}, f)
    return subprocess.CompletedProcess(args, 0, "", "")


def _private_dirs(root):
    return [p for p in root.iterdir() if p.is_dir()]


def test_check_cli_work_directories_are_removed(tmp_path, monkeypatch):
    monkeypatch.setattr("pipe2.engine.tempfile.tempdir", str(tmp_path))
    engine = Engine(tmp_path / "engine", shots=False)
    monkeypatch.setattr(engine, "_run", _fake_cli)
    engine.check({"name": "check-trigger"}, tmp_path / "work")
    engine.check_full({"name": "full-trigger"}, tmp_path / "work")
    leftovers = _private_dirs(tmp_path / "work")
    assert leftovers == [], f"expected temporary check directories to be removed, found {leftovers!r}"


def test_build_staging_directory_is_removed(tmp_path, monkeypatch):
    monkeypatch.setattr("pipe2.engine.tempfile.tempdir", str(tmp_path))
    engine = Engine(tmp_path / "engine", shots=False)
    monkeypatch.setattr(engine, "_run", _fake_cli)
    engine.build({"name": "build-control"}, tmp_path / "dist", "none", None)
    assert _private_dirs(tmp_path) == []
