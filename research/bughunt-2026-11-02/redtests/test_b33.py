import ast
from pathlib import Path


def _load_author_fn():
    src_path = Path(__file__).resolve()
    # find repo root containing h0/world/twelve_oaks/run.py
    candidates = [src_path.parent] + list(src_path.parents)
    run_path = None
    for base in candidates:
        p = base / "h0/world/twelve_oaks/run.py"
        if p.exists():
            run_path = p
            break
    assert run_path is not None, "run.py not found"
    text = run_path.read_text()
    tree = ast.parse(text)
    node = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "author")
    mod = ast.Module(body=[node], type_ignores=[])
    ns = {}
    # stubs so author() can run N rounds with validation errors every round
    ns["first_messages"] = lambda: []
    ns["opus"] = lambda msgs, tag: "<scene>{}</scene>"
    ns["blocks"] = lambda t: ({"x": 1}, None)
    ns["save"] = lambda scene, cast: None
    ns["check"] = lambda path: {"errors": [{"code": "E1"}], "warnings": []}
    exec(compile(mod, str(run_path), "exec"), ns)
    return ns["author"]


def test_author_exhausted_rounds_no_nameerror(capsys):
    author = _load_author_fn()
    try:
        author(rounds=2)
    except NameError as e:
        assert False, f"author() raised NameError: {e}"
