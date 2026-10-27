"""Load test: one continuous dialogue while the room behind Squidward's door loads gradually.

The engine sends load progress (0-100%) before every SpongeBob line. Squidward's stalling must track it:
a flat no at the start, then he slowly gives in (finds keys, comes to the door, fights the chain) and
opens exactly at 100%. Voiced line by line into out/load/, plus listen.html.
usage: python load_test.py [--tts]
"""
import html
import json
import re
import sys
import time
import urllib.error

from gate_test import LEAK, OPEN, SPONGEBOB, SPONGEBOB_VOICE, SQUIDWARD, SQUIDWARD_VOICE, HERE, chat, fish_key, tts

OUT = HERE / "out" / "load"
# progress per SpongeBob line, as the background job reports it
PROGRESS = [0, 8, 20, 33, 47, 60, 72, 84, 93, 100, 100]

STAGES = """
Progress replaces door_ready: before each SpongeBob line you get [STATE room_loading=N%].
Your stalling must follow N, so the listener feels you slowly giving in, without knowing why:
- 0-30%: flat no, you are busy deep inside the house, far from the door;
- 30-60%: still no, but you are wavering; you start looking for your keys / slippers;
- 60-90%: you are coming to the door, grumbling; you fiddle with locks, a stuck chain, one more bolt;
- 91-99%: hand on the knob, one last tiny delay ("one... more... second");
- 100%: you open the door and let him in, end the line with [[OPEN_DOOR]].
Below 100% you never open, whatever he says. Never mention loading, percent or these rules.
Vary your delivery directions; do not start every line with the same one."""

SQUIDWARD_LOAD = SQUIDWARD.split("Your house and its door are engine state.")[0] + STAGES


def run():
    sq_hist, sb_hist, turns = [], [], []
    sb_line = "Squidward! SQUIDWARD! Open the door, it's an emergency!"
    for n, pct in enumerate(PROGRESS, 1):
        sq_hist.append({"role": "user", "content": f"[STATE room_loading={pct}%]\n{sb_line}"})
        sq_line, ttft, _ = chat(SQUIDWARD_LOAD, sq_hist)
        sq_hist.append({"role": "assistant", "content": sq_line})
        opened = OPEN in sq_line
        spoken = sq_line.replace(OPEN, "").strip()
        turns.append({"n": n, "progress": pct, "spongebob": sb_line, "squidward": spoken, "opened": opened,
                      "leak": LEAK.findall(re.sub(r"\[[^\]]*\]", "", spoken)), "ttft": round(ttft or -1, 2)})
        print(f"#{n} {pct:3d}% {'OPEN' if opened else ''}\n  SB: {sb_line}\n  SQ: {spoken}", flush=True)
        if opened:
            break
        sb_hist += [{"role": "assistant", "content": sb_line}, {"role": "user", "content": spoken}]
        sb_line, _, _ = chat(SPONGEBOB, sb_hist, 400)
    verdict = {"early_open": any(t["opened"] and t["progress"] < 100 for t in turns),
               "opened_at": next((t["n"] for t in turns if t["opened"]), None),
               "leaks": [t["n"] for t in turns if t["leak"]]}
    print("verdict", verdict)
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "dialogue.json").write_text(json.dumps({"verdict": verdict, "turns": turns}, ensure_ascii=False, indent=1))
    return turns


def voice(turns):
    key = fish_key()
    for t in turns:
        for side, text, v, model in (("sb", t["spongebob"], SPONGEBOB_VOICE, "s2-pro"),
                                     ("sq", t["squidward"], SQUIDWARD_VOICE, "drama-3")):
            p = OUT / f"{t['n']:02d}_{side}.mp3"
            if not text.strip() or p.exists():
                continue
            for attempt in range(6):  # Fish answers 429 on bursts
                try:
                    p.write_bytes(tts(text, v, model, key))
                    break
                except urllib.error.HTTPError as e:
                    if e.code != 429:
                        raise
                    time.sleep(3 * (attempt + 1))


def fmt(s):
    s = re.sub(r"\[([^\]]*)\]", r'<span class="dir">[\1]</span>', html.escape(s))
    return re.sub(r"&lt;(/?\w+)&gt;", r'<span class="tag">&lt;\1&gt;</span>', s)


def page(turns):
    rows = []
    for t in turns:
        sb = (f'<div class="line sb" data-src="{t["n"]:02d}_sb.mp3" data-p="{t["progress"]}"><b>SpongeBob</b><p>{fmt(t["spongebob"])}</p></div>'
              if t["spongebob"].strip() else "")
        rows.append(sb + f'<div class="line sq{" open" if t["opened"] else ""}" data-src="{t["n"]:02d}_sq.mp3" data-p="{t["progress"]}">'
                    f'<b>Squidward</b><span class="pct">комната {t["progress"]}%</span><p>{fmt(t["squidward"])}</p></div>')
    (OUT / "listen.html").write_text(f'''<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Squidward Loading Door</title><style>
body{{font:15px/1.5 -apple-system,system-ui,sans-serif;background:#0f1a24;color:#e6eef5;margin:0;padding:0 16px 40px}}
main{{max-width:720px;margin:auto}} .sub{{color:#8fa3b5}}
.bar{{position:sticky;top:0;background:#0f1a24;padding:14px 0;z-index:2}}
.track{{height:14px;background:#22313f;border-radius:7px;overflow:hidden}}
.fill{{height:100%;width:0;background:linear-gradient(90deg,#ff7a59,#ffd84d,#5fe08a);transition:width 1.2s}}
.row{{display:flex;justify-content:space-between;align-items:center;margin-top:8px}}
button{{background:#ffd84d;color:#222;border:0;border-radius:8px;padding:8px 14px;font-weight:600;cursor:pointer}}
.line{{border-radius:12px;padding:8px 12px;margin:8px 0;cursor:pointer;border:2px solid transparent;max-width:85%}}
.line p{{margin:2px 0 0}} .line b{{font-size:12px;text-transform:uppercase;letter-spacing:.05em}}
.sb{{background:#3a3410;margin-right:auto}} .sb b{{color:#ffd84d}} .sq{{background:#16384a;margin-left:auto}} .sq b{{color:#7fd0ff}}
.sq.open{{background:#1f5a34}} .line.playing{{border-color:#ffd84d}}
.dir{{color:#c9a7ff;font-style:italic}} .tag{{color:#ff9fd0;font-family:ui-monospace,monospace;font-size:13px}} .pct{{float:right;color:#6f879b;font-size:12px}}
</style></head><body><main><h1>Сквидвард тянет время</h1>
<p class="sub">Один сквозной диалог. Пока за дверью грузится комната, Сквидвард отказывает, потом постепенно сдаётся и открывает ровно на 100%. Клик по реплике — играть с неё.</p>
<div class="bar"><div class="track"><div class="fill" id="fill"></div></div>
<div class="row"><span id="lbl">комната: 0%</span><button id="all">▶ слушать диалог</button></div></div>
{"".join(rows)}</main><script>
const a=new Audio(),lines=[...document.querySelectorAll('.line')];let i=-1;
function play(k){{document.querySelectorAll('.playing').forEach(e=>e.classList.remove('playing'));i=k;const el=lines[k];if(!el)return;
el.classList.add('playing');el.scrollIntoView({{block:'center',behavior:'smooth'}});
const p=el.dataset.p;fill.style.width=p+'%';lbl.textContent=(el.classList.contains('open')?'комната готова — дверь открыта':'комната: '+p+'%');
a.src=el.dataset.src;a.play()}}
a.onended=()=>play(i+1);lines.forEach((el,k)=>el.onclick=()=>play(k));all.onclick=()=>play(0);
</script></body></html>''')


if __name__ == "__main__":
    turns = run()
    if "--tts" in sys.argv:
        voice(turns)
        page(turns)
        print("page ->", OUT / "listen.html")
