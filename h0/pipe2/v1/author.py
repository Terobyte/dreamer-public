"""Muse Spark + engine: Spark writes SCENE.json for the dreamer engine from the same two ref frames as 00-squidward,
then fixes it from `dreamer check` reports (stage A) and from `check --built` + the built sheet (stage B).

python3 author.py A        # write + check loop
python3 author.py B        # one fix round after build (reads dist/)
"""
import base64, json, os, subprocess, sys, time, urllib.request
from pathlib import Path
D = Path(__file__).parent
MW = Path("/Users/terobyte/Desktop/Projects/Active/meta-world")
ENGINE = MW / "engine"
KEY = os.environ["META_MODEL_API_KEY"]
RULES = Path("/Users/terobyte/Desktop/Projects/Active/meta/AGENTS.md").read_text()
SPEC = (MW / "specs/engine-scene.md").read_text()
SCHEMA = (ENGINE / "schema/engine-scene.schema.json").read_text()
DEMO = (MW / "specs/examples/demo.scene.json").read_text()
MAX_A = 6

TASK = f"""Build Squidward's living room (SpongeBob) as a walkable 3D scene. The two attached frames are the reference.

This time you do NOT write three.js. You write one SCENE.json for our scene engine ("dreamer"); the engine builds the
walls, doors, collision, navigation, the three.js page and the assets from it, and checks your scene with a linter.

Rules of our engine team (follow them):
{RULES}

## Engine spec (format, checks, author loop)
{SPEC}

## JSON schema
{SCHEMA}

## Example scene
{DEMO}

## What you control
- Assets: declare them in "assets"; the engine adds its own framing template to your prompt and generates them
  (tile/decal: Muse Image, object: Muse Image + SAM3D mesh, normalized and scaled to your `size`). Up to ~16 objects.
- Add two cameras: {{"id": "ref1", "ref": "refs/ref1.jpg", ...}} and {{"id": "ref2", "ref": "refs/ref2.jpg", ...}} at the
  viewpoints of reference frame 1 and 2, so the engine can screenshot the same views side by side.

First write a short list of the visual cues you read from the frames. Then answer with ONE json object - the scene -
in a ```json fenced block, no prose after it. After that I will run `dreamer check` and send you the report."""

def img(p): return {"type": "image_url", "image_url": {"url": "data:image/%s;base64,%s" % ("png" if p.suffix == ".png" else "jpeg", base64.b64encode(p.read_bytes()).decode())}}

def call(messages):
    body = {"model": "muse-spark-1.3", "reasoning_effort": "max", "max_tokens": 64000, "messages": messages}
    req = urllib.request.Request("https://api.meta.ai/v1/chat/completions", json.dumps(body).encode(),
                                 {"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
    t = time.time()
    for attempt in range(3):
        try:
            r = json.load(urllib.request.urlopen(req, timeout=1800)); break
        except Exception as e:
            print("call failed", type(e).__name__, flush=True)
            if attempt == 2: raise
            time.sleep(20)
    print(f"  spark {time.time()-t:.0f}s usage {r.get('usage')}", flush=True)
    return r["choices"][0]["message"]["content"]

def scene_of(txt):
    i = txt.rfind("```json")
    s = txt[i + 7:] if i >= 0 else txt[txt.find("{"):]
    return json.JSONDecoder().raw_decode(s.strip())[0]

def check(built=False):
    rep = D / "work/check.json"
    args = ["node", "--import", "tsx", "bin/dreamer.ts", "check", str(D / "scene.json"), "--report", str(rep)]
    if built: args += ["--built", str(D / "dist")]
    c = subprocess.run(args, cwd=ENGINE, capture_output=True, text=True)
    return c.returncode, (c.stdout + c.stderr)[-12000:]

def save(messages): (D / "work/chat.json").write_text(json.dumps(messages, ensure_ascii=False, indent=1))

def stage_a():
    messages = [{"role": "user", "content": [{"type": "text", "text": TASK}, img(D / "refs/ref1.jpg"), img(D / "refs/ref2.jpg")]}]
    for rnd in range(1, MAX_A + 1):
        txt = call(messages)
        messages.append({"role": "assistant", "content": txt}); save(messages)
        (D / f"work/raw_a{rnd}.txt").write_text(txt)
        try:
            scene = scene_of(txt)
        except Exception as e:
            fb = f"I could not parse your JSON ({e}). Send the whole scene again in one ```json block."
            print(f"A{rnd}: parse fail", flush=True)
        else:
            (D / "scene.json").write_text(json.dumps(scene, ensure_ascii=False, indent=1))
            (D / f"work/scene_a{rnd}.json").write_text(json.dumps(scene, ensure_ascii=False, indent=1))
            code, out = check()
            print(f"A{rnd}: check exit {code}", flush=True)
            (D / f"work/check_a{rnd}.txt").write_text(out)
            if code == 0:
                return True
            fb = f"`dreamer check` exit {code}:\n```\n{out}\n```\nFix every error and send the whole scene again in one ```json block."
        messages.append({"role": "user", "content": fb}); save(messages)
    return False

def stage_b():
    messages = json.loads((D / "work/chat.json").read_text())
    code, out = check(built=True)
    (D / "work/check_b.txt").write_text(out)
    content = [{"type": "text", "text": f"""The engine built your scene with the generated assets. Attached: the sheet (each reference frame next to the
same camera in the built scene) and the top view. `dreamer check --built` exit {code}:
```
{out}
```
Compare the built views with the references and fix what is wrong: layout, placement, sizes, colours, missing things.
Keep asset prompts unchanged unless an asset is clearly wrong (a changed prompt regenerates that asset).
Send the whole scene again in one ```json block."""}]
    for p in ("dist/sheet.png", "dist/top.png"):
        if (D / p).exists(): content.append(img(D / p))
    messages.append({"role": "user", "content": content})
    txt = call(messages)
    messages.append({"role": "assistant", "content": txt}); save(messages)
    (D / "work/raw_b.txt").write_text(txt)
    scene = scene_of(txt)
    (D / "work/scene_a_final.json").write_text((D / "scene.json").read_text())
    (D / "scene.json").write_text(json.dumps(scene, ensure_ascii=False, indent=1))
    code, out = check()
    print(f"B: check exit {code}", flush=True); print(out[-3000:])
    return code == 0

if __name__ == "__main__":
    ok = stage_a() if sys.argv[1] == "A" else stage_b()
    print("OK" if ok else "NOT OK")
