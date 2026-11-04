/** The fallback two (faceTwo) holds its pair whole (Squidward v55 56.6–62 s and 71–78.6 s: SpongeBob's lines, the
 *  plan failed and the ring round the pair stood 1.9 m off; Squidward, 1.8 m tall, was 1.16 frames tall, his eyes cut
 *  by the top edge, SpongeBob a yellow block at the bottom). The fixture is the director's own tape, inputs 0–3917. */
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, it, expect } from "vitest";
import { createDirector } from "../src/runtime/stage/director.js";
import { replayProbe, replayRng } from "../src/runtime/stage/probe-tape.js";
import { ndcOf } from "../src/runtime/stage/moves.js";

const tape = gunzipSync(readFileSync(new URL("./fixtures/squid-facetwo-too-close.jsonl.gz", import.meta.url))).toString("utf8").trim().split("\n").map((l) => JSON.parse(l));

describe("the fallback two holds its pair", () => {
  it("squidward 56 s and 71 s: nobody in frame is taller than the frame", () => {
    const d = createDirector(() => 0.5, { style: "storybook" });
    const bad: string[] = [];
    tape.forEach((i: any, k: number) => {
      const o: any = d.step({ ...i, clear: replayProbe(i.blocked ?? []), rng: replayRng(i.rngs ?? [], () => 0.5) });
      if (k !== 3073 && k !== 3917) return;
      const f = o.fov ?? 50;
      for (const a of i.actors) {
        const p = ndcOf(a.head, o.cam, o.look, f, i.aspect ?? 16 / 9);
        if (!(p.depth > 0.2 && Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1)) continue;
        const tall = a.height / (2 * p.depth * Math.tan((f * Math.PI) / 360));
        if (tall > 1) bad.push(`${k} ${a.name} ${tall.toFixed(2)} ${o.plan}/${o.move}`);
      }
    });
    expect(bad).toEqual([]);
  });
});
