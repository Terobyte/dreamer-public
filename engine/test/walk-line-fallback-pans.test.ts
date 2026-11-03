/** Squidward v21 153–157 s: SpongeBob said "Welcome to my pineapple!" walking to the table; follow_side found no
 *  place (MOVE_OUT_OF_FRAME), the fallback base frame was frozen where he started and he walked out of it, three
 *  seconds of Squidward and the logs. A still frame on a walking speaker turns its look after him. */
import { describe, it, expect } from "vitest";
import { createDirector, type DActor, type DRoom } from "../src/runtime/stage/director.js";
import { ndcOf } from "../src/runtime/stage/moves.js";
import type { V3 } from "../src/runtime/stage/camera.js";

const ROOM: DRoom = { outline: [[-4, -4], [4, -4], [4, 4], [-4, 4]], ceiling: 2.6, open: false };
// the logs and the armchair: from more than a metre off his line the probe sees nothing (no side camera for follow_side)
const clear = (cam: V3): boolean => Math.abs(cam[0] - 0.2) <= 1.2;
const sq: DActor = { name: "Squidward", pos: [0, 3], yaw: 180, height: 1.8, level: null, room: "R", walking: false, head: [0, 1.7, 3] };
const bob = (z: number, walking: boolean): DActor => ({ name: "SpongeBob", pos: [0.2, z], yaw: 180, height: 1, level: null, room: "R", walking, walkLeft: walking ? z + 2.5 : 0, head: [0.2, 0.6, z] });

describe("a still frame on a walking speaker", () => {
  it("keeps him in frame to the end of the walk", () => {
    const bad: string[] = [];
    for (const r of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const d = createDirector(() => r, { style: "storybook" });
      d.step({ event: { kind: "narrator", durationS: 4, dt: 0, beat: 0, tags: { first: true } }, actors: [sq, bob(2, false)], room: ROOM, clear });
      let o = d.step({ event: { kind: "line", speaker: "SpongeBob", durationS: 6, dt: 4, beat: 1 }, actors: [sq, bob(2, true)], room: ROOM, clear });
      let cut = o.cut;
      let since = 0;
      for (let i = 1; i <= 9; i++) {
        const z = 2 - 0.5 * i;
        const b = bob(z, i < 9);
        o = d.step({ event: { kind: "tick", dt: 0.5 }, actors: [sq, b], room: ROOM, clear });
        since = o.cut === cut ? since + 0.5 : 0;
        cut = o.cut;
        // as the runtime plays it: a move runs start to end over its duration, a look on an actor is on his head
        const u = o.end ? Math.min(1, since / Math.max(0.1, o.moveDurationS ?? 1)) : 0;
        const cam: V3 = o.end ? [o.cam[0] + (o.end[0] - o.cam[0]) * u, o.cam[1] + (o.end[1] - o.cam[1]) * u, o.cam[2] + (o.end[2] - o.cam[2]) * u] : o.cam;
        const look: V3 = o.lookRef && !Array.isArray(o.lookRef) ? b.head! : o.lookEnd ? [o.look[0] + (o.lookEnd[0] - o.look[0]) * u, o.look[1] + (o.lookEnd[1] - o.look[1]) * u, o.look[2] + (o.lookEnd[2] - o.look[2]) * u] : o.look;
        const p = ndcOf(b.head!, cam, look, o.fov ?? 50, 16 / 9);
        if (!(p.depth > 0.2 && Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1)) bad.push(`${r}:${i}:${o.plan}:${o.move ?? ""}:${(o.warnings ?? []).join("|")}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
