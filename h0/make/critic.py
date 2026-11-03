"""Film critic: judges the facts the runtime wrote every 0.5 s (engine stage/critic.ts -> critic.jsonl) against
the lines in events.json. `python3 -m make.critic critic.jsonl [--events events.json] [--strict]` -> critic.json.
Exit 0 ok, 3 the film is bad (or no data/lines), 4 CRITIC_GAPS (not enough facts) -- both only with --strict."""
import argparse
import json
import sys
from pathlib import Path

STEP = 0.5
LINE_DEFAULT_S = 3.0
FACE_MAX = 100          # a face turned more than this from the camera is not seen
BACK_MIN = 120          # ...and more than this is a back
CLOSE_MIN, TWO_MIN = 0.4, 0.25
STATUE_FACTS = 4
JUMP_M = 0.5            # the camera moving more than this between two facts is a cut
SAME_POINT_M = 1.0
OVERLAP_NDC = 0.02
MIN_VISIBLE, MAX_BACK, MAX_SMALL_CLOSE, MAX_SERIES = 0.9, 0.10, 0.15, 3


def load_facts(path):
    out = []
    for line in Path(path).read_text().splitlines():
        if line.strip():
            out.append(json.loads(line))
    return out


def replies(events):
    """[(start_ms, end_ms, who)] of the 'line' events; no dur -> to the next line or 3 s."""
    lines = sorted((e for e in events if e.get("type") == "line" and e.get("who")), key=lambda e: e["ms"])
    out = []
    for i, e in enumerate(lines):
        if e.get("dur") is not None:
            end = e["ms"] + e["dur"] * 1000
        elif i + 1 < len(lines):
            end = lines[i + 1]["ms"]
        else:
            end = e["ms"] + LINE_DEFAULT_S * 1000
        out.append((e["ms"], end, e["who"]))
    return out


def _actor(fact, who):
    return next((a for a in fact.get("actors", []) if a.get("who") == who), None)


def _face_seen(a):
    h = a.get("head_ndc") or [9, 9]
    return abs(h[0]) <= 1 and abs(h[1]) <= 1 and a.get("face_deg", 999) < FACE_MAX and bool(a.get("clear"))


def _frames(facts, start, end, who):
    return [f for f in facts if start <= f["t"] * 1000 <= end and f.get("speaker") == who]


def _dist(a, b):
    return sum((x - y) ** 2 for x, y in zip(a, b)) ** 0.5


def shots(facts):
    """Runs of facts of one plan with no camera cut between them. The runtime's `dcut` (or `shot`) id
    decides when present; older critic.jsonl falls back to plan + camera jump."""
    out = []
    key = next((k for k in ("dcut", "shot") if any(k in f for f in facts)), None)
    for f in facts:
        if key:
            if out and out[-1][-1].get(key) == f.get(key):
                out[-1].append(f)
            else:
                out.append([f])
            continue
        if out and out[-1][-1].get("plan") == f.get("plan") and _dist(out[-1][-1]["cam"], f["cam"]) <= JUMP_M:
            out[-1].append(f)
        else:
            out.append([f])
    return out


def series(facts):
    """Longest run of consecutive shots of the same plan from one point."""
    best = 0
    cur = 0
    first = None
    for s in shots(facts):
        if first is not None and s[0].get("plan") == first[0].get("plan") and _dist(s[0]["cam"], first[0]["cam"]) <= SAME_POINT_M:
            cur += 1
        else:
            first, cur = s, 1
        best = max(best, cur)
    return best


def statues(facts):
    """Actors whose bone_sig stood still for STATUE_FACTS facts in a row."""
    names = []
    for who in sorted({a["who"] for f in facts for a in f.get("actors", [])}):
        run, prev = 0, None
        for f in facts:
            a = _actor(f, who)
            if a is None or not isinstance(a.get("bone_sig"), (int, float)):
                run, prev = 0, None
                continue
            run = run + 1 if prev is not None and a["bone_sig"] == prev else 1
            prev = a["bone_sig"]
            if run >= STATUE_FACTS:
                names.append(who)
                break
    return names


def _overlap(f):
    # the runtime measures bodies in 3D (overlap flag); close head projections alone prove nothing (F9)
    if "overlap" in f:
        return bool(f["overlap"])
    hs = [a["head_ndc"] for a in f.get("actors", []) if a.get("head_ndc")]
    return any(abs(hs[i][0] - hs[j][0]) < OVERLAP_NDC and abs(hs[i][1] - hs[j][1]) < OVERLAP_NDC
               for i in range(len(hs)) for j in range(i + 1, len(hs)))


def analyse(facts, events, duration=None):
    reps = replies(events)
    visible = back = 0
    for start, end, who in reps:
        fr = _frames(facts, start, end, who)
        seen = [a for a in (_actor(f, who) for f in fr) if a and _face_seen(a)]
        if fr and len(seen) * 2 >= len(fr):
            visible += 1
        fr_nb = [f for f in fr if f.get("plan") != "ots"]
        turned = [f for f in fr_nb if (_actor(f, who) or {}).get("face_deg", 0) > BACK_MIN]
        if fr_nb and len(turned) * 2 > len(fr_nb):
            back += 1
    close = [f for f in facts if f.get("plan") == "close" and f.get("actors")]
    small = [f for f in close if any(a.get("height_frac", 1) < CLOSE_MIN for a in f["actors"])]
    two_small = [f for f in facts if f.get("plan") == "two" and any(a.get("height_frac", 1) < TWO_MIN for a in f.get("actors", []))]
    end_ms = max([e[1] for e in reps] + [f["t"] * 1000 for f in facts] + [0])
    dur = duration if duration is not None else end_ms / 1000
    last_t = max((f["t"] for f in facts), default=0)
    # no video length (no --duration, no sibling video for ffprobe): completeness is
    # unverifiable, so the facts must not silently pass the 80% check (F8)
    gaps = bool(facts) and (duration is None or len(facts) < 0.8 * dur / STEP or any(e / 1000 > last_t for _, e, _ in reps))
    n = len(reps)
    return {
        "facts": len(facts), "replies": n, "duration_s": dur,
        "face_visible_frac": visible / n if n else 0.0,
        "close_small_frames": len(small), "close_frames": len(close),
        "close_small_frac": len(small) / len(close) if close else 0.0,
        "two_small_frames": len(two_small),
        "max_series": series(facts),
        "back_replies": back, "back_frac": back / n if n else 0.0,
        "overlap_frames": sum(1 for f in facts if _overlap(f)),
        "statues": statues(facts),
        "CRITIC_GAPS": gaps,
    }


def verdict(m):
    """Exit code under --strict: 3 bad film / no data, 4 gaps, else 0."""
    if not m["facts"] or not m["replies"]:
        return 3
    if (m["face_visible_frac"] < MIN_VISIBLE or m["overlap_frames"] or m["back_frac"] > MAX_BACK
            or m["close_small_frac"] > MAX_SMALL_CLOSE or m["max_series"] > MAX_SERIES):
        return 3
    return 4 if m["CRITIC_GAPS"] else 0


def summary(m):
    return "\n".join([
        f"critic: {m['facts']} facts, {m['replies']} replies",
        f"  face visible: {m['face_visible_frac']:.0%} of replies",
        f"  close too small: {m['close_small_frames']}/{m['close_frames']}, two too small: {m['two_small_frames']}",
        f"  longest same-plan same-point series: {m['max_series']}",
        f"  from the back: {m['back_frac']:.0%} of replies",
        f"  body overlap frames: {m['overlap_frames']}",
        f"  statues: {', '.join(m['statues']) or '-'}",
    ] + (["  CRITIC_GAPS"] if m["CRITIC_GAPS"] else []))


def _sibling_video_duration(jsonl):
    """Real video length next to critic.jsonl (the file record.mjs wrote beside it); None when unreadable (F8)."""
    import subprocess
    d = Path(jsonl).parent
    cands = sorted(d.glob("*.mp4")) + sorted(d.glob("*.webm"))
    for p in cands:
        try:
            r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                                "-of", "csv=p=0", str(p)], capture_output=True, text=True, timeout=30)
            return float(r.stdout.strip())
        except Exception:
            continue
    return None


def run(jsonl, events_path=None, strict=False, duration=None):
    jsonl = Path(jsonl)
    ev = Path(events_path) if events_path else jsonl.with_name("events.json")
    events = json.loads(ev.read_text()) if ev.exists() else []
    if duration is None:
        duration = _sibling_video_duration(jsonl)
    m = analyse(load_facts(jsonl), events, duration)
    jsonl.with_name("critic.json").write_text(json.dumps(m, indent=1, ensure_ascii=False))
    print(summary(m), flush=True)
    return verdict(m) if strict else 0


def main(argv=None):
    ap = argparse.ArgumentParser(prog="make.critic")
    ap.add_argument("jsonl")
    ap.add_argument("--events")
    ap.add_argument("--duration", type=float)
    ap.add_argument("--strict", action="store_true")
    a = ap.parse_args(argv)
    return run(a.jsonl, a.events, a.strict, a.duration)


if __name__ == "__main__":
    sys.exit(main())
