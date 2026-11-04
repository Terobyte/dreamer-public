/** Koshakan k11 4.3–8.3 s: the establishing frame stood 1.23 m from Mama at fov 44; her head bone was at ndc y 0.75,
 *  inside the edge, and the top of her head was out of the frame for four seconds. A head is not a point: near the
 *  camera its size reaches the edge before its bone does. */
import { describe, it, expect } from "vitest";
import { cleanEdges, type DActor, type DirectorOut } from "../src/runtime/stage/director.js";
import { ndcOf } from "../src/runtime/stage/moves.js";
import type { V3 } from "../src/runtime/stage/camera.js";

const mama = { name: "Mama", pos: [-2.71, 2.65], head: [-2.71, 1.35, 2.65] as V3, height: 1.5 } as unknown as DActor;
const mirai = { name: "Mirai", pos: [-1.35, 2.72], head: [-1.35, 0.63, 2.72] as V3, height: 1.1, lying: true } as unknown as DActor;
const frame = { cam: [-3.25, 1.37, 1.55], look: [-1.94, 0.83, 2.58], fov: 44, plan: "wide" } as unknown as DirectorOut;

describe("the edge sees the whole head, not its bone", () => {
  it("Mama's head top (15 cm over the bone) is inside the frame and Mirai stays in", () => {
    const o = cleanEdges(frame, [mama, mirai], 16 / 9, { fov: 44, maxFov: 50 });
    const top: V3 = [mama.head![0], mama.head![1] + 0.15, mama.head![2]];
    const t = ndcOf(top, o.cam, o.look, o.fov ?? 44, 16 / 9);
    expect(Math.abs(t.y), `look ${o.look} fov ${o.fov}`).toBeLessThanOrEqual(1);
    const m = ndcOf(mirai.head!, o.cam, o.look, o.fov ?? 44, 16 / 9);
    expect(Math.max(Math.abs(m.x), Math.abs(m.y))).toBeLessThanOrEqual(1);
  });
});
