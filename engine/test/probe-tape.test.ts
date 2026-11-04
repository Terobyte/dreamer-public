/** The sight probe on the tape: a film's director inputs replay in a test only with the answers the world gave
 *  (Koshakan k3 32.63 s: the replay without them took a wide that held Mirai; the film's director had been told
 *  no and held Mama alone). The page writes the probe's "no"s of each step; the replay answers from them. */
import { describe, it, expect } from "vitest";
import { tapeProbe, replayProbe } from "../src/runtime/stage/probe-tape.js";

describe("probe tape", () => {
  it("writes the blocked queries, rounded, and passes every answer through", () => {
    const world = (cam: number[], look: number[]): boolean => cam[0] < 1;
    const t = tapeProbe(world);
    expect(t.clear([0.12345, 1, 2], [3, 4, 5])).toBe(true);
    expect(t.clear([1.23456, 1, 2], [3, 4, 5.00049])).toBe(false);
    expect(t.blocked).toEqual([[1.235, 1, 2, 3, 4, 5]]);
  });
  it("keeps at most `cap` queries", () => {
    const t = tapeProbe(() => false, 3);
    for (let i = 0; i < 5; i++) t.clear([i, 0, 0], [0, 0, 0]);
    expect(t.blocked.length).toBe(3);
  });
  it("replays: a query within tol of a blocked one is no, every other one yes", () => {
    const clear = replayProbe([[1, 1, 1, 2, 2, 2]], 0.01);
    expect(clear([1.004, 1, 1], [2, 2, 2.006])).toBe(false);
    expect(clear([1.02, 1, 1], [2, 2, 2])).toBe(true);
    expect(clear([1, 1, 1], [2, 2.02, 2])).toBe(true);
  });
});

// Koshakan f5: a back of the head filled the frame; replaying the cut windows lost the director's random draws
describe("rng tape", () => {
  it("records the draws a step takes and replays them in order, then falls back", async () => {
    const { tapeRng, replayRng } = await import("../src/runtime/stage/probe-tape.js");
    let s = 0;
    const src = () => (s += 0.1);
    const t = tapeRng(src);
    const a = [t.rng(), t.rng(), t.rng()];
    expect(t.drawn).toEqual(a);
    const r = replayRng(t.drawn, () => 0.99);
    expect([r(), r(), r(), r()]).toEqual([...a, 0.99]);
  });
});
