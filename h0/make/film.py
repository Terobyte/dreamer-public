"""make film: play book scenes on the engine page and record them into one mp4 with every voice.

  cd h0 && python3 -m make.film runs/<a> [runs/<b> ...] --out film.mp4 [--max 600] [--size 1280x720]

Per run: the dist gets the current runtime (an old world plays with today's engine), make.play serves the
scene, engine/bin/record.mjs films the page with ?film=1 (no controls on screen) and logs when every event
arrived. Playwright never records sound, so each voiced event's wav is laid under the picture at that moment
(ffmpeg adelay); the scene ends TAIL_MS after book_end. Scenes are joined in the order given.
"""
import argparse
import json
import os
import queue
import shutil
import socket
import subprocess
import sys
import threading
from pathlib import Path

from make import critic
from make.play import static_url

H0 = Path(__file__).resolve().parents[1]
ENGINE = H0.parent / "engine"
TAIL_MS = 2500
READY_MS = 300  # after the page is ready (world built) the first frame is drawn; the head before it is black
critic_code = 0  # worst critic exit code of the last film() run
END = ("book_end", "stop")


def page_url(run_dir, static_port, sim_port):
    style = os.environ.get("FILM_CAMERA_STYLE")  # K2 director style id (storybook, spielberg, ozu...); empty = current default storybook, "legacy" = pre-K2 frames
    return static_url(run_dir, static_port, sim_port) + "&film=1" + (f"&camera_style={style}" if style else "")


def mux_cmd(video, events, sim_outdir, dst):
    """ffmpeg argv: the page video + each voiced event's wav delayed to the ms the page got it."""
    readies = [int(e["ms"]) for e in events if e.get("type") == "ready"]
    start = min(readies) + READY_MS if readies else 0
    voiced = []
    for e in events:
        if not e.get("audio"):
            continue
        p = Path(sim_outdir) / e["audio"]
        if p.is_file():
            voiced.append((max(0, int(e["ms"]) - start), str(p)))
        else:
            print(f"film: no wav {p}, that line stays silent", flush=True)
    ends = [int(e["ms"]) for e in events if e.get("type") in END]
    args = ["ffmpeg", "-y", "-v", "error"] + (["-ss", "%.2f" % (start / 1000)] if start else []) + ["-i", str(video)]
    if voiced:
        for _, p in voiced:
            args += ["-i", p]
        f = "".join(f"[{i + 1}:a]adelay={ms}|{ms},aresample=44100[a{i}];" for i, (ms, _) in enumerate(voiced))
        f += "".join(f"[a{i}]" for i in range(len(voiced))) + f"amix=inputs={len(voiced)}:normalize=0[a]"
        args += ["-filter_complex", f, "-map", "0:v", "-map", "[a]"]
    else:
        args += ["-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", "-map", "0:v", "-map", "1:a", "-shortest"]
    if ends:
        args += ["-t", "%.2f" % ((max(ends) + TAIL_MS - start) / 1000)]
    args += ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-c:a", "aac", "-b:a", "160k", str(dst)]
    return args


def concat_cmd(parts, dst, list_file):
    Path(list_file).write_text("".join(f"file '{p}'\n" for p in parts))
    return ["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", str(list_file), "-c", "copy", str(dst)]


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _lines(proc):
    q = queue.Queue()

    def pump():
        for line in proc.stdout:
            print(f"  play: {line.rstrip()}", flush=True)
            q.put(line.strip())
        q.put(None)
    threading.Thread(target=pump, daemon=True).start()
    return q


def _next(q, pred, timeout):
    while True:
        line = q.get(timeout=timeout)
        if line is None:
            raise RuntimeError("make.play exited early")
        if pred(line):
            return line


def _record(cmd, play, poll_s=1.0):
    """B78: record.mjs waits for the page's end, which a dead make.play never sends: while it
    records, make.play is polled, and its exit stops the recorder at once with the real cause."""
    rec = subprocess.Popen(cmd, cwd=ENGINE)
    try:
        while True:
            try:
                return rec.wait(timeout=poll_s)
            except subprocess.TimeoutExpired:
                code = play.poll()
                if code is not None:
                    raise RuntimeError(f"make.play exit {code} while recording "
                                       "(its log is the 'play:' lines above)")
    finally:
        if rec.poll() is None:
            rec.kill()
            rec.wait()


def record_scene(run_dir, dst, max_s=600, size="1280x720", lang="en"):
    """One run -> dst mp4 with sound. Raises when the page never reaches book_end/stop."""
    import json
    run_dir = Path(run_dir).resolve()
    rec = run_dir / "film"
    shutil.rmtree(rec, ignore_errors=True)
    rec.mkdir(parents=True)
    from .play import dist_of
    dist = run_dir / dist_of(run_dir)
    subprocess.run(["node", "--import", "tsx", "bin/dreamer.ts", "runtime", str(dist)], cwd=ENGINE, check=True)
    sim_port, static_port = _free_port(), _free_port()
    play = subprocess.Popen([sys.executable, "-u", "-m", "make.play", str(run_dir), "--port", str(sim_port),
                             "--static-port", str(static_port)] + (["--lang", lang] if lang != "en" else []), cwd=H0, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True)
    try:
        q = _lines(play)
        _next(q, lambda l: l.startswith("http://"), 60)
        url = page_url(run_dir, static_port, sim_port)
        code = _record(["node", "bin/record.mjs", url, str(rec), str(max_s), size], play)
        if code != 0:
            raise RuntimeError(f"record.mjs exit {code}: the scene did not reach its end in {max_s}s")
        log = _next(q, lambda l: l.endswith("log.jsonl"), 120)
    finally:
        play.terminate()
        try:
            play.wait(10)
        except subprocess.TimeoutExpired:
            play.kill()
    events = json.loads((rec / "events.json").read_text())
    video = next(rec.glob("*.webm"))
    subprocess.run(mux_cmd(video, events, Path(log).parent, dst), check=True)
    return dst


def _video_duration(p):
    """Real mp4 length in seconds (ffprobe); None when it cannot be read."""
    try:
        r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                            "-of", "csv=p=0", str(p)], capture_output=True, text=True)
        return float(r.stdout.strip())
    except Exception:
        return None


def film(runs, out, max_s=600, size="1280x720", lang="en", strict=False):
    """Returns the output path; the critic's worst exit code (0, or 3/4 under strict) lands in film.critic_code."""
    global critic_code
    critic_code = 0
    out = Path(out).resolve()
    parts = []
    for i, run in enumerate(runs):
        print(f"film: scene {i + 1}/{len(runs)} {run}", flush=True)
        parts.append(record_scene(run, out.with_name(f"{out.stem}.{i + 1:02d}.mp4"), max_s, size, lang))
        jl = Path(run).resolve() / "film" / "critic.jsonl"
        if jl.exists():
            critic_code = max(critic_code, critic.run(jl, strict=strict, duration=_video_duration(parts[-1])))
        elif strict:
            critic_code = max(critic_code, 3)
        sw = Path(run).resolve() / "film" / "stage_warnings.json"
        if sw.exists():
            try:
                warns = json.loads(sw.read_text() or "[]")
            except ValueError:
                warns = []
            for w in warns[:20]:
                print(f"film: stage warning: {w}", flush=True)
            if len(warns) > 20:
                print(f"film: ... {len(warns) - 20} more in {sw}", flush=True)
    if len(parts) == 1:
        shutil.move(parts[0], out)
    else:
        subprocess.run(concat_cmd(parts, out, out.with_suffix(".txt")), check=True)
        for p in parts:
            Path(p).unlink()
        out.with_suffix(".txt").unlink()
    print(f"film: {out}", flush=True)
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(prog="make.film")
    ap.add_argument("runs", nargs="+")
    ap.add_argument("--out", required=True)
    ap.add_argument("--max", type=int, default=600, help="seconds per scene before giving up")
    ap.add_argument("--size", default="1280x720")
    ap.add_argument("--lang", choices=["en", "ru"], default="en")
    ap.add_argument("--strict", action="store_true", help="exit 3 when the critic finds a bad film, 4 on CRITIC_GAPS")
    a = ap.parse_args(argv)
    film(a.runs, a.out, a.max, a.size, lang=a.lang, strict=a.strict)
    return critic_code if a.strict else 0


if __name__ == "__main__":
    sys.exit(main())
