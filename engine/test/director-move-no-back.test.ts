/** A move's frame never fills with someone's back (Koshakan meadow t3, 59.8–62.3 s: a recut on a tick took a close on
 *  Mirai from right behind Mama, 0.44 m off her head, Mama's back 158–175° to the lens and three frame heights tall).
 *  The base frame was judged for backs (showsBack); the move picker's `attempt` never was. The fixture is the
 *  director's own tape (FILM_DIRTAPE=1, inputs 2899–3298): probe answers and random draws replay the film exactly. */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { createDirector } from "../src/runtime/stage/director.js";
import { replayProbe, replayRng } from "../src/runtime/stage/probe-tape.js";
import { ndcOf } from "../src/runtime/stage/moves.js";

const tape = readFileSync(new URL("./fixtures/kosh-meadow-close-over-back.jsonl", import.meta.url), "utf8").trim().split("\n").map((l) => JSON.parse(l));

/** the worst back (deg) a standing actor whose head is in the frame shows the lens */
const worstBack = (o: { cam: number[]; look: number[]; fov?: number }, actors: any[], aspect: number): number => {
  let worst = 0;
  for (const a of actors) {
    if (a.lying || a.walking || a.offstage) continue;
    const p = ndcOf(a.head, o.cam as any, o.look as any, o.fov ?? 50, aspect);
    if (!(p.depth > 0.2 && Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1)) continue;
    const r = ((a.faceYaw ?? a.yaw) * Math.PI) / 180;
    const t = [o.cam[0] - a.pos[0], o.cam[2] - a.pos[1]];
    const c = (Math.sin(r) * t[0] + Math.cos(r) * t[1]) / Math.hypot(t[0], t[1]);
    worst = Math.max(worst, (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI);
  }
  return worst;
};

describe("a move does not show anyone's back", () => {
  it("koshakan meadow 60 s: the recut on Mirai is not taken from behind Mama", () => {
    const d = createDirector(() => 0.5, { style: "storybook" });
    let o: any;
    for (const i of tape) o = d.step({ ...i, clear: replayProbe(i.blocked ?? []), rng: replayRng(i.rngs ?? [], () => 0.5) });
    const last = tape[tape.length - 1];
    const kind = o.move ?? o.plan;
    if (["wide", "master", "ots"].includes(kind)) return;
    const back = worstBack(o, last.actors, last.aspect ?? 16 / 9);
    // a move is held to the director's own bar for anyone in it (OTHER_BACK_OK); any frame stays off the back line
    // (a profile two of a face-to-face pair stands at ~110°, a close from behind at 165°)
    if (o.move) expect(back).toBeLessThanOrEqual(110);
    expect(back).toBeLessThanOrEqual(120);
  });
});
