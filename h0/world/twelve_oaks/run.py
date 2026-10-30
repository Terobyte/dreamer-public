"""Twelve Oaks through the Dreamer engine.

Opus on OpenRouter writes SCENE.json and cast.json, `dreamer check` loops fixes,
Muse Image and SAM3D (Modal) fill the engine cache, ready Tripo GLBs are seeded
into it, then `dreamer build` and a cast overlay on top of the built page.

usage: python3 run.py author | assets | build | critic
"""
import base64, hashlib, io, json, os, re, shutil, subprocess, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
ENGINE = Path.home() / "Desktop/Projects/Active/meta-world/engine"
SPECS = ENGINE.parent / "specs"
SAM3D = HERE / "sam3d_par.py"  # copy of meta/h0/sam3d_modal.py with max_containers=40: one GPU per mesh
GWTW = HERE.parent
CACHE, DIST, LOG = HERE / "cache", HERE / "dist", HERE / "log"
for d in (CACHE, LOG):
    d.mkdir(exist_ok=True)

READY = {"oak": "glb/oak.glb", "rotunda": "glb/rotunda.glb", "ironbench": "glb/ironbench.glb",
         "plankbench": "glb/plankbench.glb"}
FILMS = ["refs/film/12oaks_v.jpg", "refs/film/b1.jpg", "refs/film/b3.jpg", "refs/film/Picnic1_v.jpg"]
MODEL = "anthropic/claude-opus-5.5"
CRITIC = "muse-spark-1.3"  # the model pipe2 critics run on
PIPE2 = ENGINE.parent / "h0/pipe2"

# engine/src/assets/templates.ts, copied: the cache key must match byte for byte
TEMPLATES = {
    "object": "single object, front view facing the camera, whole object, plain white background, no shadow",
    "tile": "seamless tileable texture, orthographic front view, flat even lighting, no shadows, no perspective, the pattern repeats with no visible edges",
    "decal": "orthographic front view, flat even lighting, centred, filling the frame, plain flat white background",
}


def full_prompt(kind, prompt):
    return f"{TEMPLATES[kind]}. {prompt}"


def cache_key(kind, prompt, aspect="1:1"):
    base = full_prompt(kind, prompt)
    return hashlib.sha256((base if kind == "object" else f"{base}|{aspect}").encode()).hexdigest()


def size_for(aspect):
    try:
        w, h = (float(x) for x in aspect.split(":"))
        r = w / h
    except Exception:
        return "1024x1024"
    return "2048x1024" if r >= 1.5 else "1024x2048" if r <= 1 / 1.5 else "1024x1024"


# ---------- Opus ----------

def env_key(path, name):
    for line in Path(path).read_text().splitlines():
        if line.startswith(name + "="):
            return line.split("=", 1)[1].strip().strip('"')
    raise SystemExit(f"{name} not in {path}")


def opus(messages, tag, reasoning=True, max_tokens=48000):
    key = env_key(Path.home() / "Desktop/Projects/Active/music-video/.env", "OPENROUTER_API_KEY")
    body = {"model": MODEL, "messages": messages, "max_tokens": max_tokens, "usage": {"include": True}}
    if reasoning:
        body["reasoning"] = {"effort": "medium"}
    req = urllib.request.Request("https://openrouter.ai/api/v1/chat/completions", json.dumps(body).encode(),
                                 {"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    t = time.time()
    with urllib.request.urlopen(req, timeout=1800) as r:
        d = json.load(r)
    (LOG / f"{tag}.json").write_text(json.dumps(d, indent=1))
    u = d.get("usage", {})
    print(f"{tag}: {time.time() - t:.0f}s in {u.get('prompt_tokens')} out {u.get('completion_tokens')} cost ${u.get('cost')}")
    return d["choices"][0]["message"]["content"]


def muse_chat(messages, tag, max_tokens=32000):
    """Muse Wonder on api.meta.ai (OpenAI-compatible, sees images)."""
    body = {"model": CRITIC, "messages": messages, "max_tokens": max_tokens, "reasoning_effort": "low", "stream": False}
    req = urllib.request.Request("https://api.meta.ai/v1/chat/completions", json.dumps(body).encode(),
                                 {"Authorization": f"Bearer {os.environ['META_MODEL_API_KEY']}",
                                  "Content-Type": "application/json"})
    t = time.time()
    with urllib.request.urlopen(req, timeout=1800) as r:
        d = json.load(r)
    (LOG / f"{tag}.json").write_text(json.dumps(d, indent=1))
    u = d.get("usage", {})
    print(f"{tag}: {time.time() - t:.0f}s in {u.get('prompt_tokens')} out {u.get('completion_tokens')}", flush=True)
    return d["choices"][0]["message"]["content"]


def img_part(path):
    path = HERE / path
    data = base64.b64encode(path.read_bytes()).decode()
    mime = "image/png" if path.suffix == ".png" else "image/jpeg"
    return {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{data}"}}


def blocks(text):
    s = re.search(r"<scene>\s*(.*?)\s*</scene>", text, re.S)
    c = re.search(r"<cast>\s*(.*?)\s*</cast>", text, re.S)
    strip = lambda x: re.sub(r"^```\w*\s*|\s*```$", "", x.strip())
    return json.loads(strip(s.group(1))), (json.loads(strip(c.group(1))) if c else None)


def check(scene_path, built=None):
    cmd = ["node", "--import", "tsx", "bin/dreamer.ts", "check", str(scene_path), "--report", str(LOG / "report.json")]
    if built:
        cmd += ["--built", str(built)]
    subprocess.run(cmd, cwd=ENGINE, capture_output=True, text=True)
    return json.loads((LOG / "report.json").read_text())


def short(report):
    out = [f"{i['code']} {i.get('path', '')}: {i.get('msg', i.get('message', ''))} {json.dumps(i.get('fix')) if i.get('fix') else ''}"
           for i in report["errors"]]
    out += [f"(warn) {i['code']} {i.get('path', '')}: {i.get('msg', i.get('message', ''))}" for i in report["warnings"]]
    return "\n".join(out[:80])


def save(scene, cast):
    (HERE / "SCENE.json").write_text(json.dumps(scene, indent=1, ensure_ascii=False))
    if cast is not None:
        (HERE / "cast.json").write_text(json.dumps(cast, indent=1))


def first_messages():
    spec = (SPECS / "engine-scene.md").read_text()
    schema = (ENGINE / "schema/engine-scene.schema.json").read_text()
    example = (SPECS / "examples/demo-flat.scene.json").read_text()
    staging = (Path.home() / "Desktop/Projects/Active/meta/h0/dream/scenes/twelve_oaks.json").read_text()
    big = (f"# Engine spec\n{spec}\n\n# JSON schema\n{schema}\n\n# Example scene that passes check\n{example}\n\n"
           f"# Novel cues\n{(HERE / 'refs/cues.md').read_text()}\n\n# Scene staging (dialogue engine)\n{staging}")
    msgs = [{"role": "system", "content": [{"type": "text", "text": big, "cache_control": {"type": "ephemeral"}}]},
            {"role": "user", "content": [{"type": "text", "text": (HERE / "brief.md").read_text()},
                                         *[img_part(f) for f in FILMS]]}]
    return msgs


def finish(msgs, text, k0, rounds, call=None, tag="author"):
    """Save, check, and loop fixes from round k0 on."""
    call = call or (lambda m, t: opus(m, t, reasoning=False, max_tokens=14000))
    for k in range(k0, rounds):
        if text is None:
            text = call(msgs, f"{tag}{k}")
        msgs.append({"role": "assistant", "content": text})
        try:
            scene, cast = blocks(text)
        except Exception as e:
            print(f"  parse: {e}")
            return
        save(scene, cast)
        rep = check(HERE / "SCENE.json")
        print(f"  check: {len(rep['errors'])} errors, {len(rep['warnings'])} warnings", flush=True)
        if not rep["errors"]:
            return
        msgs.append({"role": "user", "content": "dreamer check found errors. Fix them and return both blocks in full again. Think briefly.\n" + short(rep)})
        text = None
    print(f"{tag}: still errors after all rounds")


def cont():
    """author0 hit max_tokens mid-scene: let Opus finish the same text with no reasoning (prefill)."""
    msgs = first_messages()
    part = json.loads((LOG / "author0.json").read_text())["choices"][0]["message"]["content"]
    part = part[:part.rfind("},\n") + 3]  # cut back to the last whole line
    msgs.append({"role": "assistant", "content": part})
    msgs.append({"role": "user", "content": "Your reply was cut off by the token limit right after the text above. "
                 "Output ONLY the missing remainder, starting with the very next line, through the end of the </cast> block. "
                 "Do not repeat anything already written, no preamble."})
    rest = opus(msgs, "author0b", reasoning=False, max_tokens=12000)
    (LOG / "author0b.txt").write_text(rest)
    msgs[-2:] = []
    finish(msgs, part + rest.lstrip("`\n").removeprefix("json\n"), 1, 3)


def author(rounds=4):
    msgs = first_messages()
    for k in range(rounds):
        text = opus(msgs, f"author{k}")
        msgs.append({"role": "assistant", "content": text})
        try:
            scene, cast = blocks(text)
        except Exception as e:
            msgs.append({"role": "user", "content": f"Could not parse your blocks: {e}. Return both blocks again, strict JSON."})
            continue
        save(scene, cast)
        rep = check(HERE / "SCENE.json")
        print(f"  check: {len(rep['errors'])} errors, {len(rep['warnings'])} warnings")
        if not rep["errors"]:
            return
        msgs.append({"role": "user", "content": "dreamer check found errors. Fix them and return both blocks in full again.\n" + short(rep)})
    print(f"{tag}: still errors after all rounds")


def critic():
    """The pipe2 assets critic (meta-world/h0/pipe2, read only) on the whole scene: its prompt,
    its model, frozen asset prompts with one reissue, and no fix rounds - red means roll back."""
    sys.path.insert(0, str(PIPE2.parent))
    from pipe2.spark import parse_scene
    shots = sorted((DIST / "shots").glob("*.png"))
    scene = json.loads((HERE / "SCENE.json").read_text())
    cast = json.loads((HERE / "cast.json").read_text())
    text = (PIPE2 / "prompts/critic_assets.md").read_text()
    fields = {"ROOM": "twelve_oaks (the whole scene: the lawn and the house rooms)",
              "PARTIAL": json.dumps({**scene, "cast": cast}, ensure_ascii=False, indent=1),
              "REPORT": short(check(HERE / "SCENE.json")) or "green",
              "SKELETON": "none: the fragment is the whole scene. `cast` is the animated characters, not checked by the engine."}
    for k, v in fields.items():
        text = text.replace("{{%s}}" % k, v)
    text += "\n\nThe first %d images are frames from the film, the look to match; then the shots (%s, top-down plan last)." % (
        len(FILMS), ", ".join(p.stem for p in shots))
    msgs = [{"role": "user", "content": [{"type": "text", "text": text}, *[img_part(f) for f in FILMS],
                                         *[img_part(p.relative_to(HERE)) for p in shots],
                                         img_part((DIST / "top.png").relative_to(HERE))]}]
    answer = muse_chat(msgs, "critic0")
    (LOG / "critic0.txt").write_text(answer)
    try:
        cand = parse_scene(answer)
    except ValueError as e:
        print(f"critic: bad answer ({e}), scene kept")
        return
    new_cast = cand.pop("cast", cast)
    old = scene.get("assets", {})
    for key, spec in (cand.get("assets") or {}).items():  # pipe2 _freeze, one reissue
        if key in old and isinstance(spec, dict):
            wants = spec.pop("reissue", False) and not getattr(critic, "reissued", False)
            spec["prompt"] = old[key].get("prompt", "") + (" #v2" if wants else "")
            critic.reissued = getattr(critic, "reissued", False) or wants
    shutil.copy(HERE / "SCENE.json", LOG / "SCENE.before_critic.json")
    shutil.copy(HERE / "cast.json", LOG / "cast.before_critic.json")
    save(cand, new_cast)
    rep = check(HERE / "SCENE.json")
    if rep["errors"]:
        print(f"critic: check red ({len(rep['errors'])} errors), rolled back\n" + short(rep))
        shutil.copy(LOG / "SCENE.before_critic.json", HERE / "SCENE.json")
        shutil.copy(LOG / "cast.before_critic.json", HERE / "cast.json")
    else:
        print(f"critic: green, {len(rep['warnings'])} warnings; findings in log/critic0.txt")


# ---------- assets ----------

def muse(prompt, size):
    body = json.dumps({"model": "muse-image-1.0", "prompt": prompt, "n": 1, "size": size}).encode()
    for attempt in range(3):
        try:
            req = urllib.request.Request("https://api.meta.ai/v1/images/generations", body,
                                         {"Authorization": f"Bearer {os.environ['META_MODEL_API_KEY']}",
                                          "Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=240) as r:
                return base64.b64decode(json.load(r)["data"][0]["b64_json"])
        except Exception as e:
            print(f"  muse retry {attempt}: {e}")
            time.sleep(3)
    return None


def assets():
    scene = json.loads((HERE / "SCENE.json").read_text())
    jobs, meshes = [], []
    for aid, a in scene["assets"].items():
        kind, prompt, aspect = a["kind"], a.get("prompt", ""), a.get("aspect", "1:1")
        key = cache_key(kind, prompt, aspect)
        if prompt.startswith("READY "):
            src = GWTW / "scene" / READY[prompt.split()[1]]
            if not (CACHE / f"{key}.glb").exists():
                shutil.copy(src, CACHE / f"{key}.glb")
            continue
        target = CACHE / (f"{key}.glb" if kind == "object" else f"{key}.png")
        if target.exists():
            continue
        img = CACHE / (f"{key}.src.png" if kind == "object" else f"{key}.png")
        if not img.exists():
            jobs.append((aid, img, full_prompt(kind, prompt), size_for(aspect) if kind != "object" else "1024x1024"))
        if kind == "object":
            meshes.append((key, img))
    print(f"assets: {len(jobs)} images, {len(meshes)} meshes")

    def one(j):
        aid, path, prompt, size = j
        data = muse(prompt, size)
        if data:
            Image.open(io.BytesIO(data)).save(path, "PNG")  # Muse answers WebP; pngjs in the engine needs real PNG
        return aid, bool(data)
    with ThreadPoolExecutor(16) as ex:
        for aid, ok in ex.map(one, jobs):
            print(f"  image {aid}: {'ok' if ok else 'FAILED'}")

    meshes = [(k, p) for k, p in meshes if p.exists()]
    if meshes:
        tmp = HERE / "sam3d_in"
        shutil.rmtree(tmp, ignore_errors=True)
        tmp.mkdir()
        for k, p in meshes:
            shutil.copy(p, tmp / f"{k}.png")
        pngs = ",".join(str(tmp / f"{k}.png") for k, _ in meshes)
        subprocess.run(["modal", "run", str(SAM3D), "--out", str(HERE / "sam3d_out"), "--pngs", pngs], check=False)
        for k, _ in meshes:
            g = HERE / "sam3d_out" / f"{k}.glb"
            if g.exists():
                shutil.copy(g, CACHE / f"{k}.glb")
            else:
                print(f"  mesh {k[:10]}: FAILED")


# ---------- build + cast overlay ----------

def build():
    shutil.rmtree(DIST, ignore_errors=True)
    r = subprocess.run(["node", "--import", "tsx", "bin/dreamer.ts", "build", str(HERE / "SCENE.json"), "--out", str(DIST),
                        "--assets", "cache", "--cache", str(CACHE)], cwd=ENGINE, capture_output=True, text=True)
    print(r.stdout[-1500:], r.stderr[-1500:])
    rt = (DIST / "runtime.js").read_text()
    rt = rt.replace("window.__dreamer = api;", "window.__dreamer = api; window.__dw = { scene, camera, renderer, hooks: [] };", 1)
    rt = rt.replace("    renderer.render(scene, camera);\n    requestAnimationFrame(frame);",
                    "    for (const h of window.__dw.hooks) h(dt);\n    renderer.render(scene, camera);\n    requestAnimationFrame(frame);", 1)
    # shots wait for __ready: hand it to cast.js, so the characters are in the frame
    rt = re.sub(r"window\.__ready = true", "window.__engine_ready = true", rt)
    assert "window.__dw" in rt and "h(dt)" in rt and "__engine_ready" in rt, "runtime patch did not apply"
    (DIST / "runtime.js").write_text(rt)
    anim = DIST / "anim"
    anim.mkdir()
    for f in (GWTW / "anim").glob("*"):
        if f.suffix in (".glb", ".json"):
            shutil.copy(f, anim / f.name)
    # the same three the engine bundled, so cast objects and the renderer agree
    three = ENGINE / "node_modules/three"
    shutil.copytree(three / "build", DIST / "vendor/three/build")
    for sub in ("loaders", "utils"):
        shutil.copytree(three / "examples/jsm" / sub, DIST / "vendor/three/examples/jsm" / sub)
    shutil.copy(HERE / "cast.json", DIST / "cast.json")
    shutil.copy(HERE / "cast.js", DIST / "cast.js")
    html = (DIST / "index.html").read_text().replace(
        '<script type="module" src="runtime.js"></script>',
        '<script type="importmap">{"imports":{"three":"./vendor/three/build/three.module.js","three/addons/":"./vendor/three/examples/jsm/"}}</script>\n'
        '<script type="module" src="runtime.js"></script>\n<script type="module" src="cast.js"></script>')
    (DIST / "index.html").write_text(html)


if __name__ == "__main__":
    {"author": author, "cont": cont, "assets": assets, "build": build, "critic": critic}[sys.argv[1]]()
