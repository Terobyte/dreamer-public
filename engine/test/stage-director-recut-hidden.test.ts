/** Squidward, Nov 3 (v19 20–24 s): the frame on SpongeBob saw him at the cut; a second later he turned to Squidward and
 *  his head went behind the chair back, and the frame held him hidden four seconds. A held still frame that loses a
 *  head it holds for 0.75 s is cut again. */
import { describe, it, expect } from "vitest";
import { createDirector, type DActor, type DRoom } from "../src/runtime/stage/director.js";
import { ndcOf } from "../src/runtime/stage/moves.js";

const ROOM: DRoom = { outline: [[-4, -4], [4, -4], [4, 4], [-4, 4]], ceiling: 3, open: false };
const sq: DActor = { name: "Squidward", pos: [0.7, 2.0], yaw: 240, height: 1.8, head: [0.7, 1.15, 2.0], level: null, room: "r", walking: false };

describe("a held frame that loses a head is cut again", () => {
  it("SpongeBob's head goes behind the chair after the cut: within ~1 s a new cut sees him or leaves him out", () => {
    for (let seed = 1; seed <= 6; seed++) {
      let s = seed >>> 0;
      const rng = () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 4294967296);
      const d = createDirector(rng, { style: "storybook" });
      const sb: DActor = { name: "SpongeBob", pos: [-2.25, 0.1], yaw: 60, height: 1.0, head: [-2.25, 0.59, 0.1], level: null, room: "r", walking: false };
      let hide: { cam: number[] } | null = null;
      const clear = (c: [number, number, number], l: [number, number, number]): boolean => {
        if (!hide || Math.hypot(l[0] - sb.head![0], l[2] - sb.head![2]) > 0.05) return true;
        return Math.hypot(c[0] - hide.cam[0], c[1] - hide.cam[1], c[2] - hide.cam[2]) > 0.3;  // hidden from the held spot only
      };
      let out = d.step({ event: { kind: "line", speaker: "SpongeBob", durationS: 6, dt: 0.5, tags: { look: true } }, actors: [sq, sb], room: ROOM, rng, clear });
      for (let k = 0; k < 2; k++) out = d.step({ event: { kind: "tick", dt: 0.5 }, actors: [sq, sb], room: ROOM, rng, clear });
      if (out.end) continue;  // a move: not this rule
      hide = { cam: [...out.cam] };  // he turned: from where the camera stands his head is behind the chair now
      const cut0 = out.cut;
      let seen = false;
      for (let k = 0; k < 4; k++) {
        out = d.step({ event: { kind: "tick", dt: 0.5 }, actors: [sq, sb], room: ROOM, rng, clear });
        const p = ndcOf(sb.head!, out.cam, out.look, out.fov ?? 50, 16 / 9);
        const inFrame = p.depth > 0.2 && Math.abs(p.x) < 1 && Math.abs(p.y) < 1;
        if (out.cut !== cut0 && (!inFrame || clear(out.cam as any, sb.head!))) seen = true;
      }
      expect(seen, `seed ${seed}`).toBe(true);
    }
  });
});
