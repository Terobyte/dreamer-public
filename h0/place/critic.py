"""Look -> fix: Spark compares the ref | result sheet and names the assets to redo (new prompts) and plan fixes.
The new prompts land in features-independent overrides (<run>/overrides.json) that compile applies on top."""
import json
from pathlib import Path

from PIL import Image

from . import prompts, sheet, spark

VIEWS = ["P1_h000", "P1_h060", "P1_h180", "P3_h180", "P4_h000", "P9_h200", "P2_h000"]


def critique(run: Path, refs: Path, effort="high"):
    sh = sheet.make(run, refs, run / "critic_sheet.jpg", VIEWS)
    scene = json.loads((run / "world" / "scene.json").read_text())
    alist = [{"id": k, "kind": v["kind"], "prompt": v["prompt"][:300]} for k, v in scene["assets"].items()]
    plan = json.loads((run / "plan.json").read_text())
    obj, meta = spark.ask(prompts.CRITIC, [spark.img_part(Image.open(sh), 1600),
                                           "Assets:\n" + json.dumps(alist, ensure_ascii=False),
                                           "Plan:\n" + json.dumps(plan, ensure_ascii=False)],
                          effort=effort, log=run / "critic.txt")
    over = json.loads((run / "overrides.json").read_text()) if (run / "overrides.json").exists() else {"assets": {}}
    for r in obj.get("redo", [])[:8]:
        if r.get("id") in scene["assets"]:
            over["assets"][r["id"]] = r["prompt"]
    (run / "overrides.json").write_text(json.dumps(over, ensure_ascii=False, indent=1))
    pp = obj.get("plan_patch") or {}
    if pp:
        rm = tuple(pp.get("props_remove") or ())
        plan["props"] = [p for p in plan.get("props", []) if not (rm and p["id"].startswith(rm))] + list(pp.get("props_add") or [])
        plan["trees"] = plan.get("trees", []) + list(pp.get("trees_add") or [])
        (run / "plan.json").write_text(json.dumps(plan, ensure_ascii=False, indent=1))
    return obj, meta
