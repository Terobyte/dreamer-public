# Dreamer

Give Dreamer a book, a sentence, or a real street address, and it builds a walkable 3D world and stages a living scene in it: characters with their own voices who either act the chapter as written or improvise, and a director who steers without pushing. The bet that made it work is a division of labour. **Code builds the space** (rooms in metres, doors, nav, placement). **Muse Image paints only surfaces** (seamless tiles and flat decals). **SAM 3D Objects makes the things** that stand in the room. Everything runs in parallel, so a world is minutes, not hours, and a wrong one can be rebuilt and compared against the reference.

Built solo in 9 days (Oct 27 to Nov 4, 2026; 568 commits) for the Meta AI Developer Hackathon, Indie track. A hosted live build is linked in the submission.

## What it does

| You give | Dreamer makes | Where |
|---|---|---|
| **A book** (Koshakan, a picture book written by the author's wife; Conan Doyle's 221B Baker Street) | The room from the chapter, the cast with voices, the scene played as written. Press **G** inside and it switches to freestyle. | `h0/make`, `h0/dream` |
| **A sentence** ("Mirai finds a tiny lost kitten in the meadow") | Muse Spark writes a short chapter with that world's cast, `make` stages it in the ready world. Measured on Nov 4: 3 min 04 s, $0.07. | `h0/home` (Create tab) |
| **A real place** (Kozbagarov St. 7, a yard in Semey, Kazakhstan) | The yard from OpenStreetMap, satellite tiles and Street View frames. Stand in it, hold Space, say what should open, and a shop grows onto the ground floor of the house while you watch. | `h0/place` |

Dreamer Home (`h0/home/README.md`) is the one page that fronts all of it: **Book / Freestyle / Create**.

## Try it

A fresh clone has the code but not the built worlds (they live outside the repo, see Limitations), so start with the fake mode: no network, no keys, no money.

```sh
cd h0
python3 -m home --fake        # http://localhost:8800/  stub scenes, canned chapter, make --fake
```

With keys (variable names below) the same page serves the real thing:

```sh
cd h0
python3 -m home               # Book / Freestyle / Create against live Muse, SAM 3D and Fish
```

The engine on its own, with the shipped example scene:

```sh
cd engine && npm install
node --import tsx bin/dreamer.ts check ../specs/examples/demo.scene.json
node --import tsx bin/dreamer.ts build ../specs/examples/demo.scene.json --out /tmp/demo --assets none
```

Everything the gate runs (Python suites in parallel, then engine vitest and tsc):

```sh
sh tools/gate.sh
```

## How a world gets made

```
 book chapter  |  one-line idea  |  lat/lon + frames (h0/place, its own road to scene.json)
      |              |
      v              v
   brief  --- Muse Spark, one JSON call (h0/make/brief.py)
      |
    refs  --- real pictures of the place: Wikimedia Commons, fandom, Openverse, Tavily (h0/make/refs/)
      |
      +---------------+---------------+
      v               v               v
   world           cast            story
  (pipe2)      ready GLBs +      Spark writes the
   Spark lays   voices (Fish)    score, or the
   out rooms,                    chapter is cut
   critics check                 into beats as written
   against refs
      |
      |  engine: dreamer check / build / shots
      |  Muse Image -> tiles + decals, SAM 3D on Modal -> GLB, all at once
      v
   stage  --- places, voices, start positions  (stage.json)
      |
    play  --- Spark dialogue + director, Fish voices, SSE into the three.js page
```

The full map, module by module, is `research/feature_map.md` (section 1 is this picture with file names; section 3 is "need X, use Y").

### The engine (`engine/`, TypeScript, Node 22)

A scene is one JSON file (`engine/schema/engine-scene.schema.json`, described in `specs/engine-scene.md`): rooms as polygons in metres, walls, openings, stairs, props, decals, lights, cameras, routes. `dreamer check` runs eight stages (schema, plan, openings, stairs, props, decals, cameras, nav) and reports every error with a path and a fix hint; `dreamer build` writes geometry, a 4 cm walkability grid, the three.js runtime page and a contact sheet of shots; `dreamer stitch` sews separately built places into one world. Props that are not in the asset cache get a grey placeholder, so a build never blocks on a model.

Actors live in `engine/src/runtime/stage/`: procedural idle and gaze, A* on the nav grid, a library of camera moves with director styles, and the bridge that turns the Python sim's events (line, narration, touch, door) into motion on the page.

### The pipelines (`h0/`, Python)

- `h0/make` is the DAG above: every stage hashes its inputs, is cached, and has a dollar ceiling split between stages (`h0/make/core.py`). `python3 -m make "<idea>" --book dream/books/koshakan --scene bedroom --max-dollars 1`, then `python3 -m make.play runs/<id> [--freestyle]`.
- `h0/pipe2` builds a world from a brief: Spark as architect and builder per room (rooms in parallel), two critics that look at the rendered shots next to the reference photos, then merge, seam fixing and a degrade pass. Its `AssetQueue` sends every picture to Muse Image and every object to SAM 3D the moment its prompt exists.
- `h0/place` builds a real place: Overpass buildings and roads, Esri satellite tiles, Street View frames read by Spark into features and a plan, compiled by code into the same `scene.json`. `h0/place/shop.py` turns a spoken wish into an annex on the house and attaches it to the running page without a reload.
- `h0/dream` is the scene runtime: the dialogue loop, the async director (one call in flight, events queued), safety phrases, a narrator, and the book scorer that cuts a chapter into beats without an LLM.
- `h0/live` is the voice loop: mic over WebSocket, Meta ASR on chunks cut at micro-pauses, Spark token stream cut into sentences, Fish PCM straight back to the page.

## Meta tooling, as actually wired

| Model | Where | Used for |
|---|---|---|
| **Muse Spark** `muse-spark-1.3-contributor` (`api.meta.ai/v1/chat/completions`) | `h0/dream/llm.py`, `h0/pipe2/spark.py`, `h0/place/spark.py` | brief, chapter writing, room layout, critics, director, reading a yard from photos. `h0/llm_http.py` is the one HTTP client: an allow-list of hosts, redirects refused, and a guard that refuses the paid `muse-spark-1.3` by regex (`h0/pipe2/test_paid_model.py`). |
| **Muse Spark Open** `meta-models/muse-spark-open-1026` via Baseten | `h0/dream/llm.py` | the live character dialogue in play |
| **Muse Image** `muse-image-1.0` (`/v1/images/generations`, `/v1/images/edits`) | `engine/src/assets/providers/muse-image.ts`, `h0/pipe2/assets.py` | seamless wall/floor tiles, decals (windows, pictures, signs), sky; edits for the sky seam |
| **SAM 3D Objects** | `h0/sam3d_modal.py` on Modal, driven by `h0/pipe2/assets.py` | every prop: a white-background PNG in, a normalised GLB out |
| **Meta ASR** `muse-voice-transcribe-1.0` (`/v1/asr/transcribe`) | `h0/live/rt.py`, `h0/place/serve.py` | the voice wish in the yard, the live voice loop |
| **Immersive Web SDK** | `app/` (`app/src/engine-host.ts`) | the engine world inside IWSDK: Meta locomotion on the engine nav, tested in the IWER emulator |

Voices are Fish Audio (`drama-3` in `h0/dream/voice.py`); Meta has no TTS. Reference search is Wikimedia Commons, fandom wikis, Openverse and Tavily.

## Numbers that were measured

- **SAM 3D on Modal, H100: 30–45 s per object**, output GLB ~1.5 MB; fine for pre-generation, too slow for live, so objects are made while the world builds, never mid-scene (`RESEARCH.md`, H6).
- **Voice on Meta: ~1.0 s from end of speech to text, WER 2.9 %**, by cutting speech at pauses ≥ 160 ms and sending chunks while the player still talks. Whole-utterance Meta ASR was 2.5 s and 6–11 % WER; Deepgram Flux, the reference, 0.9–1.2 s and 1.9 % but English only (`RESEARCH.md` H10, `DEVLOG.md` chapter 1, raw runs in `h0/out/asr_bench.json`).
- **Gaussian splats in WebXR: 13 fps without LoD, 60 fps with a 200K-splat budget** in the IWER emulator on a desktop GPU (`RESEARCH.md` H7, `app/src/splats.ts`).
- **A real yard from scratch: about 16 min; a shop spoken into it: about 2.5 min** (`PROGRESS.md`, Nov 4). On the hosted build a cold-GPU "small bakery with fresh bread" went from claim to built in 184 s for $0.50.
- **Create from one sentence: 3 min 04 s, $0.07** (`h0/home/README.md`).
- The gate: 39 Home tests, 245 Python test files and 233 engine vitest files, all offline; every paid provider is replaced by a fake in tests.

The hypothesis log with every measurement, H0 to H21, is `RESEARCH.md`; the story of what was decided and what broke is `DEVLOG.md` (both in Russian). One documented failure shaped the design: a panorama used as a room (H16) bends walls and floats the floor, which is why Muse now paints only tiles and decals and code owns the geometry (`AGENTS.md`).

## Keys

Read by `h0/keys.py` from the environment first, then a gitignored `.env` in the repo root. Names only; nothing is ever printed.

| Variable | For |
|---|---|
| `META_MODEL_API_KEY` | Muse Spark, Muse Image, Meta ASR |
| `BASETEN_API_KEY` | Muse Spark Open |
| `FISH_AUDIO_API_KEY` | voices |
| `TAVILY_API_KEY` | optional, one of four reference-image sources |
| `DEEPGRAM_API_KEY` | optional, the Flux fallback in `h0/live/rt.py` |
| Modal secret `huggingface` with `HF_TOKEN` | SAM 3D weights; `modal deploy h0/sam3d_modal.py` before a live world build |

## Limitations

- **Built worlds and the cast GLBs are not in this repo.** Home looks for them in sibling directories and hides scenes whose files are missing, so a fresh clone runs `python3 -m home --fake` only. The live scenes are in the hosted build linked from the submission.
- **Needs keys and a Modal account** for anything real; a world build spends money. `make --max-dollars N` caps a run, the world stage defaults to a $20 / 400-call ceiling (`DEFAULT_CAPS` in `h0/make/world.py`), and pipe2 writes every charge to a ledger (`h0/pipe2/ledger.py`).
- **VR is emulator-only.** `app/` runs the engine world inside IWSDK and was checked in IWER; no headset has touched it. That is the next milestone (VR Start, Nov 18).
- **Characters are not generated.** `make` takes a ready `cast.json` plus GLBs; the voice is picked from the Fish library or designed on Modal (`h0/dream/voicedesign.py`).
- **Actors sit and stand, they do not lie down or climb onto things**; collisions between actors are a separation pass, not physics (`research/feature_map.md`, section 5).
- The docs are in Russian; the code and its docstrings are in English.

## Repo map

```
AGENTS.md          the three rules for building a world (code = space, Muse = surfaces, SAM 3D = objects)
engine/            scene JSON -> check / build / shots / stitch, the three.js runtime, actors and camera
h0/make/           brief -> refs -> world / cast / story -> stage -> play, and book -> film
h0/pipe2/          world builder: Spark architect, per-room pipelines, critics, asset queue
h0/place/          a real address -> a yard; a spoken wish -> a shop attached live
h0/dream/          the scene runtime: dialogue, director, narrator, books
h0/live/           the voice loop on Meta ASR
h0/home/           Dreamer Home, the submission page
app/               the IWSDK (WebXR) host for an engine world
specs/             design specs, including engine-scene.md and the example scenes
research/          feature map, friction log, benchmarks
RESEARCH.md        hypotheses H0–H21 with measurements   DEVLOG.md   what happened, day by day
```

## License

MIT, see `LICENSE`. Koshakan is published here with the author's permission.
