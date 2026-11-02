import importlib.util
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]


def _load():
    mod_path = REPO / "h0" / "world" / "twelve_oaks" / "run.py"
    assert mod_path.exists(), f"run.py missing: {mod_path}"
    spec = importlib.util.spec_from_file_location("twelve_oaks_run_b34", mod_path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_ready_sources_exist():
    mod = _load()
    assert isinstance(mod.READY, dict) and mod.READY, "READY mapping empty"
    # same expression the production asset step uses: GWTW / "scene" / READY[name]
    missing = [str(mod.GWTW / "scene" / rel) for rel in mod.READY.values()
               if not (mod.GWTW / "scene" / rel).exists()]
    assert not missing, f"READY sources missing (shutil.copy -> FileNotFoundError): {missing}"
