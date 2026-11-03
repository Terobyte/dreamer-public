/** Squidward v22 142–145 s: after "Fine. One hour. Then I paint." both got up and walked to the door; the cut for the
 *  walk picked a close on Squidward at random, he walked into the lens and out of the frame, an empty room for two
 *  seconds. A cut for a walk the speaker makes follows him, line or not. */
import { describe, it, expect } from "vitest";
import { createDirector, type DActor, type DRoom } from "../src/runtime/stage/director.js";
import { ndcOf } from "../src/runtime/stage/moves.js";
import type { V3 } from "../src/runtime/stage/camera.js";

const ROOM: DRoom = { outline: [[-5, -5], [5, -5], [5, 5], [-5, 5]], ceiling: 3, open: false };
const sq = (z: number, walking: boolean): DActor => ({ name: "Squidward", pos: [0, z], yaw: 0, height: 1.8, level: null, room: "R", walking, walkLeft: walking ? 4 - z : 0, head: [0, 1.7, z] });
const bob = (z: number, walking: boolean): DActor => ({ name: "SpongeBob", pos: [0.7, z + 0.3], yaw: 0, height: 1, level: null, room: "R", walking, walkLeft: walking ? 4 - z : 0, head: [0.7, 0.6, z + 0.3] });

describe("the cut for a walk", () => {
  it("keeps the walking speaker in frame", () => {
    const bad: string[] = [];
    for (const r of [0.05, 0.2, 0.35, 0.5, 0.65, 0.8, 0.95]) {
      const d = createDirector(() => r, { style: "storybook" });
      d.step({ event: { kind: "narrator", durationS: 4, dt: 0, beat: 0, tags: { first: true } }, actors: [sq(-2, false), bob(-2, false)], room: ROOM });
      let o = d.step({ event: { kind: "line", speaker: "Squidward", durationS: 3, dt: 4, beat: 1 }, actors: [sq(-2, false), bob(-2, false)], room: ROOM });
      let cut = o.cut;
      let since = 0;
      for (let i = 1; i <= 8; i++) {
        const z = -2 + 0.5 * i;
        const s = sq(z, i < 8);
        o = d.step({ event: { kind: "tick", dt: 0.5 }, actors: [s, bob(z, i < 8)], room: ROOM });
        since = o.cut === cut ? since + 0.5 : 0;
        cut = o.cut;
        if (i < 3) continue; // a cut no sooner than asl.min
        const u = o.end ? Math.min(1, since / Math.max(0.1, o.moveDurationS ?? 1)) : 0;
        const cam: V3 = o.end ? [o.cam[0] + (o.end[0] - o.cam[0]) * u, o.cam[1] + (o.end[1] - o.cam[1]) * u, o.cam[2] + (o.end[2] - o.cam[2]) * u] : o.cam;
        const look: V3 = o.lookRef && !Array.isArray(o.lookRef) ? s.head! : o.lookEnd ? [o.look[0] + (o.lookEnd[0] - o.look[0]) * u, o.look[1] + (o.lookEnd[1] - o.look[1]) * u, o.look[2] + (o.lookEnd[2] - o.look[2]) * u] : o.look;
        const p = ndcOf(s.head!, cam, look, o.fov ?? 50, 16 / 9);
        if (!(p.depth > 0.5 && Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1)) bad.push(`${r}:${i}:${o.plan}:${o.move ?? ""}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
