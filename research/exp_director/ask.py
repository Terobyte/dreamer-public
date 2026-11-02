"""Experiment: Spark contributor directs the Koshakan bedroom in Sonnet's story.js format.
usage: python3 ask.py <round> [sheet.png prev.json]"""
import json, sys, base64
from pathlib import Path
H0 = "/Users/terobyte/Desktop/Projects/Active/meta/h0"
sys.path.insert(0, H0)
from make import core
from pipe2.ledger import Ledger, load_prices
from pipe2.spark import Spark

OUT = Path(__file__).parent
DEMO = Path("/Users/terobyte/Desktop/Projects/Active/anymove/runs/koshakan/demo")
rnd = int(sys.argv[1])
anims = json.loads((DEMO / "anims.json").read_text())
clips = {k: round(v["dur"], 2) for k, v in anims.items()}
story = (DEMO / "story.js").read_text()
example = story[story.index("const SP = [2.35, 2.2];"):story.index("const meadow") if "const meadow" in story else None]
example = example[:example.index("\n};") + 3]
helpers = story[story.index("const DEG"):story.index("const bedroom")]

task = f"""You are the film director of a 3D picture-book film (three.js). Write the staging (actor segments) and the shot list
for ONE scene: the bedroom. A player engine will play your JSON exactly; you will not see it before it plays.

## Scene text (0-based line index, speaker, voiced duration in seconds)
0 Narrator: "Outside, the first birds were waking up. Inside, Mirai was still asleep, curled up small and warm." (10.449 s)
1 Narrator: "Ever since the day Mirai was born, Mama had called her by one special word." (7.152 s)
2 Narrator: "Mama bent down and whispered, warm against her ear:" (4.969 s)
3 Mama: "Wake up, Koshakanym." (2.276 s)
4 Narrator: "It was Mama's word. Just for Mirai." (3.715 s)
Timing: 2.5 s before line 0, 0.45 s gap between lines, 3.2 s after the last line.

## Cast
- Mirai: a little lamb girl, 1.0 m tall. Mama: her mother (sheep-woman), 1.6 m tall.
- Clips (in place; you move the actor; durations in s): {json.dumps(clips)}
- Walk speed on the walk clip: mama_walk 0.91 m/s, mirai_walk 0.74 m/s. Bones you can aim at: "head".

## World (metres, y up, floor y=0; yaw degrees: 0 faces +Z, 90 faces +X)
- Bedroom: floor rectangle x in [-3.6, 0], z in [0, 3.6], ceiling 2.7 m. Walls are solid; the camera may stand outside a wall
  only if the shot sets "cut": true (exterior walls and ceilings are hidden for that shot).
- Doors: front door of the house at (x=-1.8, z=0) in the bedroom's z=0 wall leads outside to a meadow (z<0);
  inner door at (x=0, z=0.6) leads to the bathroom (x in [0, 3.2]).
- Bed: centre (-1.25, 2.5), 1.1 wide (x) by 2.05 long (z), frame height 0.95 incl. posts; headboard and pillow at the z=3.6 wall.
- Nightstand with a lamp: centre (-0.36, 3.3), 0.55 x 0.42, 0.95 high (with lamp).
- Bookshelf: (-3.32, 2.65) against the x=-3.6 wall, 1.0 wide, 1.45 high, facing +X.
- Rug: round, centre (-1.15, 1.05), diameter 1.7.
- Window: in the back wall z=3.6, centre x=-1.15, sill ~0.9 m, top ~2.2 m, sunrise outside.
- Pictures on the walls x=0 (z 2.55-3.0) and x=-3.6 (z ~0.95).

## Output format: one JSON object
{{"actors": {{"Mirai": {{"segs": [...]}}, "Mama": {{"segs": [...]}}}}, "shots": [...], "notes": "one paragraph: your intent"}}
It maps 1:1 onto this JavaScript format (a different scene by another director, for the format only, do not copy its
coordinates). Helpers used there:
```js
{helpers}
```
Example scene:
```js
{example}
```
In JSON: write a walk as {{"walk": "mama_walk", "a": [x, z], "b": [x, z], "at": ..., "y": 0, "yaw1": deg, "xf": s}} (the
player expands it with walk()); write a look at a bone as {{"a": "Mirai", "b": "head", "o": [dx, dy, dz]}}.
Times: a number (s), "prev" (= the end of the previous entry), "L<i>", "L<i>e", "L<i>+1.2", "END", "END-0.6".
Segment fields: at, to | dur, clip, loop (default true), p0 [x,y,z], p1, yaw, yaw1, xf (crossfade s), speed, hide.
Shot fields: name, at, to | dur, from {{pos, look, fov}}, end {{pos, look, fov}}, cut, shake (0.002-0.008), ease.
Every second of the scene must be covered by segments for both actors and by shots. Answer with the JSON only.
"""
msgs = [{"role": "system", "content": "You are a film director. Answer one JSON object only."}]
if rnd == 0:
    msgs.append({"role": "user", "content": task})
else:
    sheet, prev = sys.argv[2], json.loads(Path(sys.argv[3]).read_text())
    b64 = base64.b64encode(Path(sheet).read_bytes()).decode()
    msgs += [{"role": "user", "content": task}, {"role": "assistant", "content": json.dumps(prev)},
             {"role": "user", "content": [
                 {"type": "text", "text": "Here is what the player rendered from your JSON: 9 frames evenly spaced over the "
                  "scene, left to right, top to bottom, subtitles show the current line. Look at every frame critically "
                  "as a director: composition, who is visible, faces, distance, anything inside walls or furniture, "
                  "anyone floating or sunk. Then answer the full corrected JSON (same format)."},
                 {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}}]}]
ledger = Ledger(OUT / f"events{rnd}.jsonl", load_prices(), 2.0, 2)
ans = Spark(core._spark_transport(), ledger).ask("exp", "bedroom", rnd, msgs, "high")
print("valid", ans.valid, "err", ans.error, "spent", round(ledger.spent, 4), "latency", round(ans.latency_s or 0))
if ans.valid and isinstance(ans.scene, dict):
    (OUT / f"spark{rnd}.json").write_text(json.dumps(ans.scene, ensure_ascii=False, indent=1))
    print("notes:", ans.scene.get("notes"))
