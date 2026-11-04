/** Squidward v37/v38 street 135–142 s: follow_side held SpongeBob 2 m off and Squidward, walking beside him on the
 *  camera's side, stood 0.8–1.5 m from the lens, 1.2–2 frame heights tall; the user: "очень тесная, воздуха нет".
 *  A walk shot frames every walker of the beat whole, head to feet, and stands as far back as that takes. */
import { describe, it, expect } from "vitest";
import type { V3 } from "../src/runtime/stage/camera.js";
import type { DActor, DRoom } from "../src/runtime/stage/director.js";
import { ndcOf, resolveMove, type Ctx } from "../src/runtime/stage/moves.js";

const STREET: DRoom = { outline: [[0, -6], [40, -6], [40, 14], [0, 14]], ceiling: 3.5, open: true };
const act = (name: string, pos: [number, number], height: number): DActor =>
  ({ name, pos, yaw: 90, height, level: null, room: "street", walking: true, head: [pos[0], height * 0.92, pos[1]] });

describe("a walk shot frames every walker whole", () => {
  const bob = act("SpongeBob", [10, 5], 0.65);
  const sq = act("Squidward", [10, 4], 1.9);
  let s = 3;
  const ctx: Ctx = {
    actors: [bob, sq], room: STREET, fov: 45, aspect: 16 / 9, durationS: 4, speaker: "SpongeBob",
    rng: () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296),
    walk: { SpongeBob: { to: [18, 5] }, Squidward: { to: [18, 4] } },
  };

  it("follow_side on one of two walkers keeps both inside the frame, head and feet", () => {
    const r = resolveMove("follow_side", { actor: "SpongeBob" }, ctx);
    expect(r.end).not.toBeNull();
    for (const [p, u] of [[r.from, 0], [r.end!, 1]] as const) {
      const at = (a: DActor, y: number): V3 => {
        const w = ctx.walk![a.name]!;
        return [a.pos[0] + (w.to[0] - a.pos[0]) * u, y, a.pos[1] + (w.to[1] - a.pos[1]) * u];
      };
      const l = p.look;
      const look: V3 = Array.isArray(l) ? l : ((): V3 => { const h = at(bob, bob.head![1]); return [h[0] + l.o[0], h[1] + l.o[1], h[2] + l.o[2]]; })();
      for (const a of [bob, sq])
        for (const pt of [at(a, a.head![1]), at(a, 0)]) {
          const n = ndcOf(pt, p.pos, look, p.fov!, ctx.aspect);
          expect(n.depth).toBeGreaterThan(0.1);
          expect(Math.abs(n.x)).toBeLessThanOrEqual(0.85 + 1e-6);
          expect(Math.abs(n.y)).toBeLessThanOrEqual(0.85 + 1e-6);
        }
    }
  });
});
