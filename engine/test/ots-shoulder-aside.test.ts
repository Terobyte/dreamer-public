/** Squidward v30 video 146–150 s: an over-the-shoulder on SpongeBob stood 0.7 m right behind Squidward's head, on the
 *  line to SpongeBob; the back of the head filled the frame and hid him. The near shoulder sits to a side of the
 *  frame: its head keeps off the line from the camera to the subject's head. */
import { describe, it, expect } from "vitest";
import { createDirector, type DActor, type DRoom } from "../src/runtime/stage/director.js";

type V3 = [number, number, number];
const ROOM: DRoom = { outline: [[0, 0], [20, 0], [20, 20], [0, 20]], ceiling: 3, open: false };
const act = (name: string, pos: [number, number], yaw: number): DActor => ({ name, pos, yaw, height: 1.7, level: null, room: "r", walking: false });

/** distance from p to the segment a→b */
const off = (a: V3, b: V3, p: V3): number => {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const t = Math.max(0, Math.min(1, (ab[0] * ap[0] + ab[1] * ap[1] + ab[2] * ap[2]) / (ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2)));
  return Math.hypot(ap[0] - ab[0] * t, ap[1] - ab[1] * t, ap[2] - ab[2] * t);
};

describe("over the shoulder", () => {
  it("keeps the near head off the line to the subject", () => {
    const a = act("a", [9, 10], 90), b = act("b", [11, 10], 270);
    for (const who of ["a", "b"]) {
      const d = createDirector(() => 0.5);
      const o = d.step({ event: { kind: "line", speaker: who, durationS: 4, dt: 0, shot: "ots" }, actors: [a, b], room: ROOM });
      expect(o.plan).toBe("ots");
      const [subj, near] = who === "a" ? [a, b] : [b, a];
      const sh: V3 = [subj.pos[0], subj.height * 0.93, subj.pos[1]];
      const nh: V3 = [near.pos[0], near.height * 0.93, near.pos[1]];
      expect(off(o.cam, sh, nh)).toBeGreaterThanOrEqual(0.45);
    }
  });
});
