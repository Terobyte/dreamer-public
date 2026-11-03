/** Squidward, Nov 3 (v20 18–24 s, 50 s, 86 s): SpongeBob is a 1 m box, his head bone sits in its middle (0.57 m). The
 *  director asked the probe about that point (seen under a chair seat) while his face stood behind the chair back, and
 *  judged the frame's edge by it while the box's upper half stood in at the edge. The face (`DActor.face`, between the
 *  head bone and the eye) is what the probe and the edge check look at too. */
import { describe, it, expect } from "vitest";
import { cleanEdges, createDirector, type DActor, type DRoom } from "../src/runtime/stage/director.js";
import { ndcOf } from "../src/runtime/stage/moves.js";

const ROOM: DRoom = { outline: [[-4, -4], [4, -4], [4, 4], [-4, 4]], ceiling: 3, open: false };
const sq: DActor = { name: "Squidward", pos: [0.7, 2.0], yaw: 240, height: 1.8, head: [0.7, 1.15, 2.0], level: null, room: "r", walking: false };

describe("the face, not the head bone", () => {
  it("a held frame whose face goes behind the chair (head bone still seen) is cut again", () => {
    let recut = 0, tried = 0;
    for (let seed = 1; seed <= 6; seed++) {
      let s = seed >>> 0;
      const rng = () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 4294967296);
      const d = createDirector(rng, { style: "storybook" });
      const sb: any = { name: "SpongeBob", pos: [-2.25, 0.1], yaw: 60, height: 1.0, head: [-2.25, 0.57, 0.1], face: [-2.25, 0.75, 0.1], level: null, room: "r", walking: false };
      let hide: number[] | null = null;
      const clear = (c: [number, number, number], l: [number, number, number]): boolean =>
        !(hide && Math.hypot(l[0] - sb.face[0], l[1] - sb.face[1], l[2] - sb.face[2]) < 0.02 && Math.hypot(c[0] - hide[0], c[1] - hide[1], c[2] - hide[2]) < 0.3);
      let out = d.step({ event: { kind: "line", speaker: "SpongeBob", durationS: 6, dt: 0.5, tags: { look: true } }, actors: [sq, sb], room: ROOM, rng, clear });
      for (let k = 0; k < 2; k++) out = d.step({ event: { kind: "tick", dt: 0.5 }, actors: [sq, sb], room: ROOM, rng, clear });
      if (out.end) continue;
      const p = ndcOf(sb.head, out.cam, out.look, out.fov ?? 50, 16 / 9);
      if (!(p.depth > 0.2 && Math.abs(p.x) < 1 && Math.abs(p.y) < 1)) continue;
      tried++;
      hide = [...out.cam];
      const cut0 = out.cut;
      for (let k = 0; k < 4; k++) out = d.step({ event: { kind: "tick", dt: 0.5 }, actors: [sq, sb], room: ROOM, rng, clear });
      if (out.cut !== cut0) recut++;
    }
    expect(tried).toBeGreaterThan(0);
    expect(recut).toBe(tried);
  });

  it("the box's face at the frame's edge counts as cut though its head bone is past the edge", () => {
    const A = 16 / 9;
    const cam: any = [0, 1.2, 3], look: any = [0, 1.0, 0];
    const sqC: DActor = { ...sq, pos: [0, 0], head: [0, 1.15, 0] };
    // a fov that puts SpongeBob's head bone (0.57) past the bottom edge, his face (0.8) on it
    const sb: any = { name: "SpongeBob", pos: [0.3, 1.8], yaw: 0, height: 1.0, head: [0.3, 0.57, 1.8], face: [0.3, 0.8, 1.8], level: null, room: "r", walking: false };
    let fov = 50;
    for (; fov > 20; fov -= 0.5) {
      const ph = ndcOf(sb.head, cam, look, fov, A), pf = ndcOf(sb.face, cam, look, fov, A);
      if (Math.abs(ph.y) > 1.3 && Math.abs(pf.y) > 0.92 && Math.abs(pf.y) < 1.1) break;
    }
    const out = { plan: "close", cut: 1, cam, look, fov };
    const pf0 = ndcOf(sb.face, cam, look, fov, A);
    expect(Math.abs(pf0.y)).toBeGreaterThan(0.92);
    const o: any = cleanEdges(out, [sqC, sb], A);
    const pf = ndcOf(sb.face, o.cam, o.look, o.fov, A);
    const r = Math.max(Math.abs(pf.x), Math.abs(pf.y));
    expect(r < 0.9 || r > 1.3).toBe(true);
  });
});

/** Squidward, Nov 3 (v7 21–25 s): the director's probe saw SpongeBob's face point past a chair's scroll while the top
 *  of his box (the eye, where the film critic asks) stood behind it; the frame showed the side of a box behind a chair.
 *  A head counts as seen when both its face and its eye are. */
describe("the face and the eye", () => {
  it("a held frame whose eye goes behind the chair (face point still seen) is cut again", () => {
    let recut = 0, tried = 0;
    for (let seed = 1; seed <= 6; seed++) {
      let s = seed >>> 0;
      const rng = () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 4294967296);
      const d = createDirector(rng, { style: "storybook" });
      const sb: any = { name: "SpongeBob", pos: [-2.25, 0.1], yaw: 60, height: 1.0, head: [-2.25, 0.57, 0.1], face: [-2.25, 0.75, 0.1], eye: [-2.25, 0.92, 0.1], level: null, room: "r", walking: false };
      let hide: number[] | null = null;
      const clear = (c: [number, number, number], l: [number, number, number]): boolean =>
        !(hide && Math.hypot(l[0] - sb.eye[0], l[1] - sb.eye[1], l[2] - sb.eye[2]) < 0.02 && Math.hypot(c[0] - hide[0], c[1] - hide[1], c[2] - hide[2]) < 0.3);
      let out = d.step({ event: { kind: "line", speaker: "SpongeBob", durationS: 6, dt: 0.5, tags: { look: true } }, actors: [sq, sb], room: ROOM, rng, clear });
      for (let k = 0; k < 2; k++) out = d.step({ event: { kind: "tick", dt: 0.5 }, actors: [sq, sb], room: ROOM, rng, clear });
      if (out.end) continue;
      const p = ndcOf(sb.head, out.cam, out.look, out.fov ?? 50, 16 / 9);
      if (!(p.depth > 0.2 && Math.abs(p.x) < 1 && Math.abs(p.y) < 1)) continue;
      tried++;
      hide = [...out.cam];
      const cut0 = out.cut;
      for (let k = 0; k < 4; k++) out = d.step({ event: { kind: "tick", dt: 0.5 }, actors: [sq, sb], room: ROOM, rng, clear });
      if (out.cut !== cut0) recut++;
    }
    expect(tried).toBeGreaterThan(0);
    expect(recut).toBe(tried);
  });
});
