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
from dialogue import _phrases, repeats  # noqa: E402

OUT = os.path.join(HERE, "..", "out", "dream", "bank")


def run_scene(scene, dollars, speed, talk="spark-open"):
    """One text-only dream -> its run dir (the sim prints outdir=...)."""
    cmd = [sys.executable, os.path.join(HERE, "sim.py"), "--profile", "bank", "--scene", scene,
           "--text", "--speed", str(speed), "--max-transitions", "1",
           "--max-dollars", str(dollars), "--talk", talk]
    p = subprocess.run(cmd, capture_output=True, text=True, cwd=HERE, timeout=1200)
    for line in p.stdout.splitlines():
        if line.startswith("outdir="):
            return os.path.realpath(line.split()[0][len("outdir="):]), p.stdout + p.stderr
    return None, p.stdout + p.stderr


def _spoken(text):
    """Words only: drop [remarks] and <tags>."""
    return re.sub(r"\[[^\]]*\]|<[^>]+>", " ", text)


def score(rows):
    """Craft signals only, the taste call stays with a human reader."""
    lines = [(r.get("who") or "?", r.get("text") or "") for r in rows if r["type"] == "line"]
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
    return {"lines": len(lines), "repeats": rep, "bits": bits,
            "hero_q": "%d/%d" % (sum("?" in t for t in hero), len(hero)),
            # craft signals for the weak-vs-strong bench: how much is said per line,
            # how varied the vocabulary is, how thick the stage directions are
            "words_per_line": round(len(words) / max(1, len(lines)), 1),
            "vocab": round(len(set(words)) / max(1, len(words)), 2),
            "remarks_per_line": round(remarks / max(1, len(lines)), 2),
            "build": any(r["type"] == "build" and r.get("phase") == "start" for r in rows),
            "transition": any(r["type"] == "transition" for r in rows),
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
    args = ap.parse_args()
    names = [s for s in args.scenes.split(",") if s] or sorted(
        os.path.basename(p)[:-5] for p in glob.glob(os.path.join(HERE, "scenes", "*.json"))
        if not p.endswith("start.json"))
    talks = [t for t in args.talk.split(",") if t]
    jobs = [(n, t) for n in names for t in talks for _ in range(args.runs)]
    with ThreadPoolExecutor(args.jobs) as ex:
        done = list(ex.map(lambda j: j + run_scene(j[0], args.max_dollars, args.speed, j[1]), jobs))
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    out, total = [], 0.0
    for name, talk, rundir, log in done:
        head = "%s / %s" % (name, talk) if len(talks) > 1 else name
        if not rundir:
            out.append("## %s\n\nrun failed:\n```\n%s\n```\n" % (head, log[-1500:]))
            continue
        rows = [json.loads(l) for l in open(os.path.join(rundir, "log.jsonl"), encoding="utf-8")]
        s = score(rows)
        total += s["spent"]
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
