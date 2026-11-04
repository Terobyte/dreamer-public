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
