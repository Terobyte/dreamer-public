"""Scene bank: every scene once, text only (--text), then one sheet to read side by side.
usage: python3 h0/dream/bank.py --max-dollars 0.15 [--scenes roof,bus] [--jobs 4] --out sheet.md
       python3 h0/dream/bank.py --talk spark-open,wonder --runs 2 --max-dollars 1.0 --out bench.md
Paid: the Wonder director only, unless --talk wonder puts the talk roles on Wonder too
(design doc 2026-10-28, section 7a: the same scene on a weak and a strong model)."""

import argparse
import glob
import json
import os
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import lang  # noqa: E402
from dialogue import _phrases, _spoken, count_action_loops, repeats  # noqa: E402

OUT = os.path.join(HERE, "..", "out", "dream", "bank")
# Phase 1: paid runs go through bench_f1.py only (ceiling + two-FAIL stop live there);
# bench_f1 sets this in the child env, a bare `python3 bank.py` refuses
BENCH_ENV = "DREAM_BENCH_F1"


def run_scene(scene, dollars, speed, talk="spark-open", max_seconds=None, language="en"):
    """One text-only dream -> its run dir (the sim prints outdir=...).
    max_seconds is handed to sim.py as is; None keeps the sim's own default."""
    cmd = [sys.executable, os.path.join(HERE, "sim.py"), "--profile", "bank", "--scene", scene,
           "--text", "--speed", str(speed), "--max-transitions", "1",
           "--max-dollars", str(dollars), "--talk", talk, "--lang", language]
    if max_seconds is not None:
        cmd += ["--max-seconds", str(max_seconds)]
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, cwd=HERE, timeout=1200)
    except subprocess.TimeoutExpired as exc:
        # B53: one dead run is reported as failed, it must not kill the batch
        # F2: keep partial output so the ledger can charge actual spend, not $0 or cap
        partial = ""
        # F4: TimeoutExpired carries bytes even with text=True; decode, never str(bytes)
        for v in (exc.stdout, exc.stderr):
            if isinstance(v, bytes):
                v = v.decode("utf-8", "replace")
            if v:
                partial += v + "\n"
        cand = None
        # sim.py prints rundir= as soon as the run dir exists, outdir= only at the end
        for line in partial.splitlines():
            if line.startswith(("rundir=", "outdir=")):
                try:
                    cand = os.path.realpath(line.split()[0].split("=", 1)[1])
                except Exception:
                    cand = None
                break
        if cand and os.path.isdir(cand):
            try:
                with open(os.path.join(cand, "log.jsonl"), encoding="utf-8") as f:
                    rows = [json.loads(l) for l in f]
                spent = max([r.get("dollars") or 0 for r in rows if r.get("type") == "cost"] or [0])
                return None, "sim timed out after 1200s partial_outdir=%s partial_spent=%.4f" % (cand, spent)
            except Exception:
                pass
        return None, "sim timed out after 1200s"
    log = p.stdout + p.stderr
    # sim.py prints outdir= even when it dies (validation failure exits 1), so the
    # exit code decides: a broken dream must not be scored as a finished run
    if p.returncode != 0:
        return None, "sim exited %s\n%s" % (p.returncode, log)
    for line in p.stdout.splitlines():
        if line.startswith("outdir="):
            return os.path.realpath(line.split()[0][len("outdir="):]), log
    return None, log


# design doc 2026-10-28, 7.4: "I <emphasis>dare</emphasis> you" in r1 -- tags are
# stripped first, then the narrow pattern ("don't you dare" is not a dare)
_DARE = re.compile(r"\bI dare you\b|\bdare you to\b|race me|you go first", re.I)
MATTR_WINDOW = 100


def _mattr_tokens(text):
    """Tokens for `vocab`: [a-z']+ of the spoken text, lower case (own tokenizer:
    _phrases may change with --lang, this must not)."""
    return re.findall(r"[a-z']+", _spoken(text).lower())


def mattr(tokens, window=MATTR_WINDOW):
    """Moving-average type-token ratio: mean share of unique tokens over every
    window of `window` tokens; a text shorter than the window is one window."""
    if not tokens:
        return 0.0
    if len(tokens) <= window:
        return len(set(tokens)) / len(tokens)
    counts, uniq, total, n = {}, 0, 0.0, 0
    for i, tok in enumerate(tokens):
        counts[tok] = counts.get(tok, 0) + 1
        if counts[tok] == 1:
            uniq += 1
        if i >= window:
            old = tokens[i - window]
            counts[old] -= 1
            if counts[old] == 0:
                uniq -= 1
        if i >= window - 1:
            total += uniq / window
            n += 1
    return total / n


def _silence_turns(rows):
    """Gaps between neighbouring lines holding >= 2 `silence` rows (7.4)."""
    turns, run, seen_line = 0, 0, False
    for r in rows:
        if r["type"] == "line":
            if seen_line and run >= 2:
                turns += 1
            run, seen_line = 0, True
        elif r["type"] == "silence" and seen_line:
            run += 1
    return turns


def _max_actor_streak(rows):
    best = cur = 0
    for r in rows:
        if r["type"] != "line":
            continue
        cur = cur + 1 if r.get("role") == "actor" else 0
        best = max(best, cur)
    return best


def _goal_first_line(rows):
    """Lines of the first scene up to the first `goal done` (the closing line
    counts); None without a done goal."""
    n = 0
    for r in rows:
        if r["type"] == "transition":
            return None
        if r["type"] == "line":
            n += 1
        elif r["type"] == "goal" and r.get("status") == "done":
            return n
    return None


def _events_first_scene(rows):
    """Spec 7.4: both metrics are bounded by the first scene up to the first
    transition (or, with no transition yet, up to the latest row seen). Planned
    counts every schedule entry due by the sim-time reached there."""
    idx = next((i for i, r in enumerate(rows) if r["type"] == "schedule"), None)
    if idx is None:
        return 0, 0
    sched = rows[idx]
    planned_all = list(sched.get("events") or [])
    rest = rows[idx + 1:]
    tpos = next((i for i, r in enumerate(rest) if r["type"] == "transition"), None)
    bound = rest[:tpos] if tpos is not None else rest
    t0 = sched.get("t") or 0
    if tpos is not None:
        t_end = rest[tpos].get("t") or 0
    else:
        due = [r.get("t") or 0 for r in bound if r["type"] in ("line", "silence", "event")]
        if not due:
            return 0, 0
        t_end = max(due)
    speed = next((r.get("speed") for r in rows
                  if r["type"] == "snapshot" and r.get("speed")), 1)
    t_sim = max(0, (t_end - t0) * speed)
    fired = sum(1 for r in bound if r["type"] == "event")
    planned = sum(1 for ev in planned_all if (ev.get("t") or 0) <= t_sim)
    return fired, planned


def score(rows):
    """Craft signals only, the taste call stays with a human reader. Metrics of
    design doc 7.4: a metric whose events are not in the log yet reads 0,
    goal_first_line None."""
    lines = [(r.get("who") or "?", r.get("text") or "") for r in rows if r["type"] == "line"]
    kinds = [r["type"] for r in rows]
    by = {}
    for who, t in lines:
        by.setdefault(who, []).append(t)
    bits = {}
    for who, own in by.items():
        # a bit = a phrase in 3+ of one speaker's lines over the whole run
        seen = {}
        for t in own:
            for ph in _phrases(t):
                seen[ph] = seen.get(ph, 0) + 1
        top = sorted((n, ph) for ph, n in seen.items() if n >= 3)
        if top:
            bits[who] = ["%s x%d" % (ph, n) for n, ph in top[-3:]]
    rep = sum(1 for i, (_, t) in enumerate(lines) if repeats(t, [x for _, x in lines[max(0, i - 8):i]]))
    hero = [r.get("text") or "" for r in rows if r["type"] == "line" and r.get("role") == "hero"]
    spent = max([r.get("dollars") or 0 for r in rows if r["type"] == "cost"] or [0])
    words = [w.lower() for _, t in lines for w in _spoken(t).split()]
    remarks = sum(len(r.get("remarks") or []) for r in rows if r["type"] == "line")
    roles = [r.get("role") for r in rows if r["type"] == "line"]
    tokens = [tok for _, t in lines for tok in _mattr_tokens(t)]
    prompt_tokens = [r.get("tokens") or 0 for r in rows if r["type"] == "prompt"]
    events_fired, events_planned = _events_first_scene(rows)
    return {"lines": len(lines), "repeats": rep, "bits": bits,
            "hero_q": "%d/%d" % (sum("?" in t for t in hero), len(hero)),
            # craft signals for the weak-vs-strong bench: how much is said per line,
            # how varied the vocabulary is, how thick the stage directions are
            "words_per_line": round(len(words) / max(1, len(lines)), 1),
            "vocab": round(mattr(tokens), 3),
            "remarks_per_line": round(remarks / max(1, len(lines)), 2),
            "dare_lines": sum(1 for _, t in lines if _DARE.search(" ".join(_spoken(t).split()))),
            "hero_lines": roles.count("hero"),
            "actor_lines": roles.count("actor"),
            "silence_turns": _silence_turns(rows),
            "silences_per_line": round(kinds.count("silence") / max(1, len(lines)), 3),
            "max_actor_streak": _max_actor_streak(rows),
            "goals_done": sum(1 for r in rows if r["type"] == "goal" and r.get("status") == "done"),
            "goal_first_line": _goal_first_line(rows),
            "judge_calls": kinds.count("judge"),
            "max_prompt_tokens": max(prompt_tokens or [0]),
            "auto_touch": kinds.count("auto_touch"),
            # 1.3: the schedule is code's, so the log says how much of it was kept
            "events_planned": events_planned,
            "events_fired": events_fired,
            # 1.1: the detector of dialogue.py reads the log, the three counts are events
            "action_loops": count_action_loops(rows),
            "loop_cuts": kinds.count("loop_cut"),
            "lock_rejects": kinds.count("lock_reject"),
            "turn_skips": kinds.count("turn_skip"),
            "build": any(r["type"] == "build" and r.get("phase") == "start" for r in rows),
            "transition": any(r["type"] == "transition" for r in rows),
            "transitions": kinds.count("transition"),
            "director_fail": sum(1 for r in rows if r["type"] == "director_fail"),
            "invalid": sum(1 for r in rows if r["type"] == "invalid"),
            "spent": round(spent, 4)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-dollars", type=float, default=0.15, help="per scene")
    ap.add_argument("--scenes", default="")
    ap.add_argument("--jobs", type=int, default=4)
    ap.add_argument("--speed", type=float, default=8.0)
    ap.add_argument("--out", default=os.path.join(OUT, "sheet.md"))
    ap.add_argument("--talk", default="spark-open",
                    help="comma list of talk models to compare, e.g. spark-open,wonder")
    ap.add_argument("--runs", type=int, default=1, help="runs per scene per talk model")
    ap.add_argument("--max-seconds", type=float, default=None,
                    help="real seconds per run, passed to sim.py (bench: 67.5)")
    ap.add_argument("--lang", default="en", choices=lang.LANGS,
                    help="spike 1.5: ru switches the rules and the repeat tokens")
    args = ap.parse_args()
    lang.set_lang(args.lang)  # F1: score in the run language, not always en
    if os.environ.get(BENCH_ENV) != "1":
        print("refused: bank.py is paid, run it through bench_f1.py (ceiling, ledger)")
        sys.exit(2)
    # F12: roof3.json is the gate-regression fixture scene (design doc 7.2), not
    # a bench scene -- the default list must skip it like it skips start.json
    names = [s for s in args.scenes.split(",") if s] or sorted(
        os.path.basename(p)[:-5] for p in glob.glob(os.path.join(HERE, "scenes", "*.json"))
        if not p.endswith(("start.json", "roof3.json")))
    talks = [t for t in args.talk.split(",") if t]
    jobs = [(n, t) for n in names for t in talks for _ in range(args.runs)]
    # the env flag alone is not a pass: the shared ceiling holds here too,
    # counted on the expanded job list (an empty --scenes means every scene)
    import bench_f1
    # the 1.5 spike is outside the $1.80 phase ceiling, so its dollars are counted
    # only when this very run is the spike (--lang ru), the same rule as bench_f1
    spent = sum(r.get("dollars") or 0 for r in bench_f1.load_ledger(bench_f1.LEDGER)
                if args.lang != "en" or r.get("step") != bench_f1.SPIKE_STEP)
    # F4: --lang ru only ever reaches bank.py through the 1.5 spike (bench_f1
    # refuses --lang ru on every gated step), so the spike's $1.83 applies here too
    ceiling = bench_f1.SPIKE_CEILING if args.lang != "en" else bench_f1.CEILING
    if spent + args.max_dollars * len(jobs) > ceiling + 1e-9:
        print("refused: ledger $%.2f + %d job(s) x $%.2f > ceiling $%.2f"
              % (spent, len(jobs), args.max_dollars, ceiling))
        sys.exit(2)
    with ThreadPoolExecutor(args.jobs) as ex:
        done = list(ex.map(lambda j: j + run_scene(j[0], args.max_dollars, args.speed, j[1],
                                                   args.max_seconds, args.lang), jobs))
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    out, total = [], 0.0
    for name, talk, rundir, log in done:
        head = "%s / %s" % (name, talk) if len(talks) > 1 else name
        if not rundir:
            out.append("## %s\n\nrun failed:\n```\n%s\n```\n" % (head, log[-1500:]))
            if "timed out" in log:
                m = re.search(r"partial_spent=([0-9.]+)", log)
                if m:
                    print("timeout=%s spent=%s" % (head, m.group(1)), flush=True)
                else:
                    print("timeout=%s" % head, flush=True)
            continue
        with open(os.path.join(rundir, "log.jsonl"), encoding="utf-8") as f:
            rows = [json.loads(l) for l in f]
        s = score(rows)
        total += s["spent"]
        print("run=%s" % rundir, flush=True)  # bench_f1 reads the run dirs from here
        out.append("## %s  (%s)\n\n`%s`\n" % (head, os.path.basename(rundir), json.dumps(s, ensure_ascii=False)))
        for r in rows:
            if r["type"] == "line":
                out.append("- **%s**: %s" % (r.get("who"), r.get("text")))
            elif r["type"] in ("build", "transition", "director_nudge", "memory_compact"):
                keep = {k: r[k] for k in ("phase", "bridge", "destination", "note", "who", "tried")
                        if r.get(k)}
                out.append("  - _%s_ %s" % (r["type"], json.dumps(keep, ensure_ascii=False)[:300]))
        out.append("")
    with open(args.out, "w", encoding="utf-8") as f:
        f.write("# scene bank, total $%.4f\n\n" % total + "\n".join(out))
    print("sheet=%s total=$%.4f" % (os.path.realpath(args.out), total))


if __name__ == "__main__":
    main()
