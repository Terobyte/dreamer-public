"""Phase 1 bench: the only paid entry point of the plan (design doc 2026-10-28, 7.2, 7.5).
usage: python3 h0/dream/bench_f1.py --step 1.0 --runs 1          # paid: one bank run + ledger
       python3 h0/dream/bench_f1.py --score RUN_DIR [RUN_DIR ...] [--step 1.1]   # free recount
The wrapper refuses before spending: exit 2 when ledger dollars + 0.20 * runs would pass the
phase ceiling ($1.80; the 1.5 spike counts against $1.83), exit 3 when the step already
failed its gate twice. After a run it appends {step, runs, dollars, metrics, gate} to
h0/out/dream/bank/f1_ledger.jsonl and prints the metric table with medians and PASS/FAIL."""

import argparse
import json
import os
import statistics
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import bank  # noqa: E402
import lang  # noqa: E402

OUT = os.path.realpath(os.path.join(HERE, "..", "out", "dream", "bank"))
LEDGER = os.path.join(OUT, "f1_ledger.jsonl")
CEILING = 1.80
SPIKE_CEILING = 1.83
PER_RUN = 0.20
SPEED = 8
MAX_SECONDS = 67.5

# a rule is (metric, op, threshold[, mode]); mode "median" (default) compares the median
# over the runs, "each" needs every run to pass; threshold ("ref", metric, factor) is
# factor * the reference median (1.2c against 1.2b). A null metric fails its run.
LIVELINESS = [("lines", ">=", 10), ("hero_lines", ">=", 4), ("actor_lines", ">=", 4),
              ("silences_per_line", "<=", 4)]
NO_LOOPS = [("action_loops", "==", 0, "each"), ("dare_lines", "==", 0, "each")]
GATES = {
    "1.0": [("dare_lines", "==", 0, "each")],
    "1.1": [("words_per_line", "<=", 18), ("remarks_per_line", "<=", 2.5),
            ("action_loops", "==", 0, "each"), ("lock_rejects_per_line", "<=", 0.3)] + LIVELINESS,
    "1.2b": [("silence_turns", ">=", 2), ("silences_per_line", ">=", 0.5),
             ("max_actor_streak", "<=", 2), ("hero_share", ">=", 0.35), ("hero_share", "<=", 0.65)]
            + NO_LOOPS + LIVELINESS,
    "1.2c": [("words_per_line", "<=", ("ref", "words_per_line", 1.10)),
             ("remarks_per_line", "<=", ("ref", "remarks_per_line", 1.10)),
             ("lock_rejects_per_line", "<=", ("ref", "lock_rejects_per_line", 1.10))]
            + NO_LOOPS + LIVELINESS,
    "1.3": [("events_ratio", ">=", 0.8)] + LIVELINESS,
    "1.4": [("goals_done", ">=", 1), ("goal_open_pressure", ">=", 1),
            ("judge_calls_per_line", "<=", 0.25)] + LIVELINESS,
}
GATES["Ф1"] = ([("words_per_line", "<=", 17), ("remarks_per_line", "<=", 2.4),
                ("vocab", ">=", 0.69)] + NO_LOOPS + LIVELINESS
               + [r for r in GATES["1.2b"] + GATES["1.3"] + GATES["1.4"]
                  if r not in LIVELINESS and r not in NO_LOOPS]
               # F8: the final gate keeps the 1.2c regression bars (relative to 1.2b)
               + [r for r in GATES["1.2c"] if r not in LIVELINESS and r not in NO_LOOPS])
CANONICAL_SCENE = "roof"
CANONICAL_TALK = "spark-open"
SPIKE_STEP = "1.5"


def job_count(scene, talk, runs):
    """Paid bank jobs behind one bench call: every scene x every talk x runs."""
    scenes = [s for s in (scene or "").split(",") if s]
    talks = [t for t in (talk or "").split(",") if t]
    return len(scenes) * len(talks) * runs
OPS = {"<=": lambda a, b: a <= b, ">=": lambda a, b: a >= b, "==": lambda a, b: a == b}


def _ratio(a, b):
    return None if not b else a / b


def derive(m):
    """Shares and ratios the gates speak in, from one run's bank.score dict."""
    d = dict(m)
    lines = m.get("lines") or 0
    d["hero_share"] = _ratio(m.get("hero_lines") or 0, lines)
    d["lock_rejects_per_line"] = _ratio(m["lock_rejects"], lines) if "lock_rejects" in m else None
    d["judge_calls_per_line"] = _ratio(m.get("judge_calls") or 0, lines)
    d["events_ratio"] = _ratio(m.get("events_fired") or 0, m.get("events_planned") or 0)
    return d


def score_run(rundir):
    """bank.score plus what the gates need straight from the log (goal_open pressure)."""
    with open(os.path.join(rundir, "log.jsonl"), encoding="utf-8") as f:
        rows = [json.loads(l) for l in f]
    m = bank.score(rows)
    m["goal_open_pressure"] = sum(
        1 for r in rows if r["type"] == "pressure"
        and any(isinstance(v, dict) and v.get("goal_open")
                for v in (r.get("pressure") or {}).values()))
    return m


def _median(values):
    return statistics.median(values) if values else None


def evaluate(step, runs, ref=None):
    """-> {"gate": "PASS"|"FAIL", "rows": [...]} for the metrics of GATES[step] over
    the runs' score dicts. Median of n runs (two = their mean); "each" rules and a
    null metric decide per run. ref = medians of the reference step (1.2c vs 1.2b)."""
    data = [derive(m) for m in runs]
    rows, ok_all = [], True
    for rule in GATES[step]:
        metric, op, thr = rule[:3]
        mode = rule[3] if len(rule) > 3 else "median"
        if isinstance(thr, tuple):
            base = (ref or {}).get(thr[1])
            thr = None if base is None else round(base * thr[2], 4)
        values = [d.get(metric) for d in data]
        median = None if any(v is None for v in values) else _median(values)
        if thr is None or any(v is None for v in values):
            ok = False
        elif mode == "each":
            ok = all(OPS[op](v, thr) for v in values)
        else:
            ok = OPS[op](median, thr)
        ok_all = ok_all and ok
        rows.append({"metric": metric, "values": values, "median": median,
                     "rule": "%s %s %s" % (mode, op, thr), "ok": ok})
    return {"gate": "PASS" if ok_all else "FAIL", "rows": rows}


def load_ledger(path):
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as f:
        return [json.loads(l) for l in f if l.strip()]


def ref_medians(ledger, step):
    """Medians of the latest record of `step` (a PASS wins over a later FAIL)."""
    recs = [r for r in ledger if r.get("step") == step and r.get("metrics")]
    if not recs:
        return None
    passed = [r for r in recs if r.get("gate") == "PASS"]
    rec = (passed or recs)[-1]
    data = [derive(m) for m in rec["metrics"]]
    keys = set().union(*(d.keys() for d in data))
    return {k: _median([d[k] for d in data]) for k in keys
            if all(isinstance(d.get(k), (int, float)) for d in data)}


def print_table(step, runs, result):
    print("step %s, %d run(s)" % (step, len(runs)))
    print("%-24s %-28s %10s  %-22s %s" % ("metric", "runs", "median", "rule", "ok"))
    for r in result["rows"]:
        med = "-" if r["median"] is None else ("%.3f" % r["median"]).rstrip("0").rstrip(".")
        print("%-24s %-28s %10s  %-22s %s" % (
            r["metric"], json.dumps(r["values"])[:28], med, r["rule"], "ok" if r["ok"] else "FAIL"))
    extra = ("transitions", "vocab", "words_per_line", "remarks_per_line", "lines", "spent")
    print("sheet: " + "  ".join("%s=%s" % (k, [m.get(k) for m in runs]) for k in extra))
    print("gate %s: %s" % (step, result["gate"]))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--step", help="1.0 | 1.1 | 1.2b | 1.2c | 1.3 | 1.4 | Ф1 | 1.5")
    ap.add_argument("--runs", type=int, default=1)
    ap.add_argument("--score", nargs="*", help="run dirs to re-score for free (no ledger)")
    ap.add_argument("--ledger", default=LEDGER)
    ap.add_argument("--out", default=OUT)
    ap.add_argument("--scene", default="roof")
    ap.add_argument("--talk", default="spark-open")
    ap.add_argument("--lang", default="en", choices=lang.LANGS,
                    help="spike 1.5: ru for the Russian spike; a gate is en only")
    ap.add_argument("--owner-go", action="store_true",
                    help="the owner allowed one run past two gate fails (7.5)")
    args = ap.parse_args(argv)
    # F13: --score with nargs="*" and no dirs parses to [], which is falsy --
    # `is not None` catches that case and refuses instead of falling through
    # to the paid path below
    if args.score is not None:
        if not args.score:
            print("refused: --score needs at least one run dir")
            return 2
        lang.set_lang(args.lang)  # F2: score in the run language, not always en
        runs = [score_run(d) for d in args.score]
        for d, m in zip(args.score, runs):
            print("%s %s" % (os.path.basename(d), json.dumps(m, ensure_ascii=False)))
        if args.step and args.step in GATES:
            ref = None
            if args.step in ("1.2c", "Ф1"):
                ref = ref_medians(load_ledger(args.ledger), "1.2b")
            print_table(args.step, runs, evaluate(args.step, runs, ref))
        return 0
    if not args.step:
        ap.error("--step or --score is required")
    step = args.step
    if args.runs < 1:
        print("refused: --runs must be >= 1, got %s; an empty batch has no median"
              % (args.runs,))
        return 2
    # F10: a typo in --step must not buy a bank run and ledger it as n/a
    if step not in GATES and step != SPIKE_STEP:
        print("refused: unknown step %r (gated: %s; ungated: %s)"
              % (step, " ".join(sorted(GATES)), SPIKE_STEP))
        return 2
    # F9: an official gate is roof/Spark Open only; anything else (or a comma
    # list, which also multiplies the paid jobs) refuses before spending
    if step in GATES and (args.scene != CANONICAL_SCENE or args.talk != CANONICAL_TALK):
        print("refused: step %s is gated on --scene %s --talk %s, got --scene %s --talk %s"
              % (step, CANONICAL_SCENE, CANONICAL_TALK, args.scene, args.talk))
        return 2
    # 7.2 row 1.5: until the spike is read, every gated bench runs in English,
    # so a gated step with --lang ru refuses before spending
    if step in GATES and args.lang != "en":
        print("refused: step %s is gated in English, got --lang %s (7.2 row 1.5)"
              % (step, args.lang))
        return 2
    jobs = job_count(args.scene, args.talk, args.runs)
    if jobs == 0:
        print("refused: an empty --scene/--talk runs every scene/model, the cost is unbounded")
        return 2
    ledger = load_ledger(args.ledger)
    spent = sum(r.get("dollars") or 0 for r in ledger)
    ceiling = SPIKE_CEILING if step == SPIKE_STEP else CEILING
    if spent + PER_RUN * jobs > ceiling + 1e-9:
        print("refused: ledger $%.2f + %d job(s) x $%.2f > ceiling $%.2f (7.5)"
              % (spent, jobs, PER_RUN, ceiling))
        return 2
    mine = [r.get("gate") for r in ledger if r.get("step") == step]
    fails = mine.count("FAIL")
    # the owner's go covers one run right after the second fail: any record
    # after it (PASS or incomplete) spends the go
    second = [i for i, g in enumerate(mine) if g == "FAIL"][1:2]
    go = (args.owner_go and fails == 2 and args.runs == 1
          and second and second[0] == len(mine) - 1)
    if fails >= 2 and not go:
        print("refused: step %s already failed its gate twice; the owner decides (7.5)" % step)
        return 3
    ref = None
    if step in ("1.2c", "Ф1"):
        ref = ref_medians(ledger, "1.2b")
        if not ref:
            print("refused: %s is relative to 1.2b, and the ledger has no 1.2b run" % step)
            return 4
    stamp = time.strftime("%Y%m%d_%H%M%S")
    sheet = os.path.join(args.out, "f1_%s_%s.md" % (step.replace(".", "_"), stamp))
    cmd = [sys.executable, os.path.join(HERE, "bank.py"), "--scenes", args.scene,
           "--talk", args.talk, "--runs", str(args.runs), "--speed", str(SPEED),
           "--max-dollars", str(PER_RUN), "--max-seconds", str(MAX_SECONDS),
           "--lang", args.lang, "--out", sheet]
    print("$ " + " ".join(cmd), flush=True)
    p = subprocess.run(cmd, capture_output=True, text=True, cwd=HERE, timeout=3600,
                       env=dict(os.environ, **{bank.BENCH_ENV: "1"}))
    sys.stdout.write(p.stdout)
    sys.stderr.write(p.stderr)
    lang.set_lang(args.lang)  # F5: score the paid run in its own language, not always en
    run_dirs = [l[len("run="):].strip() for l in p.stdout.splitlines() if l.startswith("run=")]
    # the gate is a median over --runs runs: fewer runs, or a bank that exited
    # non-zero, means the batch is unfinished and nothing goes into the ledger
    # money spent on it still goes into the ledger (gate "incomplete": not a FAIL,
    # not a 1.2b reference), or a retry would see the old total and pass the ceiling
    if p.returncode != 0 or len(run_dirs) != args.runs:
        dollars = 0.0
        for d in run_dirs:
            try:
                dollars += score_run(d).get("spent") or 0
            except Exception:  # any broken log: charge the cap, never skip the ledger
                dollars += PER_RUN
        # a run that never printed its dir may still have spent up to its cap
        dollars = round(dollars + PER_RUN * max(args.runs - len(run_dirs), 0), 4)
        os.makedirs(os.path.dirname(os.path.abspath(args.ledger)), exist_ok=True)
        with open(args.ledger, "a", encoding="utf-8") as f:
            f.write(json.dumps({"step": step, "t": stamp, "runs": run_dirs, "dollars": dollars,
                                "gate": "incomplete", "bank_exit": p.returncode, "sheet": sheet,
                                "lang": args.lang},
                               ensure_ascii=False) + "\n")
        print("bank exited %s with %d of %d run(s); nothing scored, $%.4f charged to the ledger"
              % (p.returncode, len(run_dirs), args.runs, dollars))
        return 1
    try:
        runs = [score_run(d) for d in run_dirs]
    except Exception as exc:  # money is spent already: charge the cap, never skip the ledger
        dollars = round(PER_RUN * args.runs, 4)
        os.makedirs(os.path.dirname(os.path.abspath(args.ledger)), exist_ok=True)
        with open(args.ledger, "a", encoding="utf-8") as f:
            f.write(json.dumps({"step": step, "t": stamp, "runs": run_dirs, "dollars": dollars,
                                "gate": "incomplete", "score_error": str(exc)[:200],
                                "sheet": sheet}, ensure_ascii=False) + "\n")
        print("scoring failed (%s); $%.4f charged to the ledger" % (exc, dollars))
        return 1
    dollars = round(sum(m.get("spent") or 0 for m in runs), 4)
    result = evaluate(step, runs, ref) if step in GATES else {"gate": "n/a", "rows": []}
    os.makedirs(os.path.dirname(args.ledger) or ".", exist_ok=True)
    with open(args.ledger, "a", encoding="utf-8") as f:
        f.write(json.dumps({"step": step, "t": stamp, "runs": run_dirs, "dollars": dollars,
                            "metrics": runs, "gate": result["gate"], "sheet": sheet,
                            "lang": args.lang},
                           ensure_ascii=False) + "\n")
    print_table(step, runs, result)
    print("dollars this bench $%.4f, ledger total $%.4f of $%.2f" % (dollars, spent + dollars, ceiling))
    return 0 if result["gate"] in ("PASS", "n/a") else 1


if __name__ == "__main__":
    sys.exit(main())
