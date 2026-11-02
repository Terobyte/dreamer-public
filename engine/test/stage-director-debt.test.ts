import { describe, it, expect } from "vitest";
import { createDirector, smoothCam, type DActor, type DEvent, type DRoom } from "../src/runtime/stage/director.js";
import { insideInset, legalCameraPoint, roomRect } from "../src/runtime/stage/camera.js";

const rng = () => 0.5;
const act = (name: string, pos: [number, number], o: Partial<DActor> = {}): DActor => ({ name, pos, yaw: 0, height: 1.7, level: null, room: "r", walking: false, ...o });
const line = (speaker: string, shot?: string): DEvent => ({ kind: "line", speaker, durationS: 3, dt: 0, ...(shot ? { shot } : {}) }) as DEvent;
const step = (event: DEvent, actors: DActor[], room: DRoom) => createDirector(rng).step({ event, actors, room, rng });
const rect = (w: number, h: number): Array<[number, number]> => [[0, 0], [w, 0], [w, h], [0, h]];
const L: Array<[number, number]> = [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]];
const ang = (f: [number, number], dx: number, dz: number) => {
  const h = Math.hypot(dx, dz);
  if (h < 1e-9) return 0;
  const cos = Math.max(-1, Math.min(1, (f[0] * dx + f[1] * dz) / h));
  return (Math.acos(cos) * 180) / Math.PI;
};

describe("camera debt: legalCameraPoint", () => {
  it("rule 1: side beats the face cone, and the best angle on the side is taken (8x6, actors [3,3],[5,3])", () => {
    const room: DRoom = { outline: rect(8, 6), ceiling: 3, open: false };
    // Best theoretical angles on the allowed side (+z, so dz > 0 relative to [3, 3]):
    // yaw 0: 0° (+z)
    // yaw 45: 0° (+x, +z)
    // yaw 90: infimum 0° (along boundary +x)
    // yaw 135: infimum 45° (face at 135°, nearest +z vector is at +x, angle 45°)
    // yaw 180: infimum 90° (face at 180°, entire 60° cone has dz < 0, does not intersect side)
    // yaw 225: infimum 45° (face at 225°, nearest +z vector is at -x, angle 45°)
    // yaw 270: infimum 0° (along boundary -x)
    // yaw 315: 0° (-x, +z)
    const bestOnSide: Record<number, number> = {
      0: 0,
      45: 0,
      90: 0,
      135: 45,
      180: 90,
      225: 45,
      270: 0,
      315: 0,
    };
    for (const shot of ["close", "ots"] as const) {
      for (const yaw of [0, 45, 90, 135, 180, 225, 270, 315]) {
        const s = step(line("a", shot), [act("a", [3, 3], { yaw }), act("b", [5, 3], { yaw: 270 })], room);
        // Rule 1: camera must be strictly on the required +z side (s.cam[2] > 3)
        expect(s.cam[2]).toBeGreaterThan(3);
        const f: [number, number] = [Math.sin((yaw * Math.PI) / 180), Math.cos((yaw * Math.PI) / 180)];
        const a = ang(f, s.cam[0] - 3, s.cam[2] - 3);
        const best = bestOnSide[yaw];

        if (yaw === 180) {
          // Face cone (<= 60°) does not intersect the allowed side: angle must be > 60°
          expect(a).toBeGreaterThan(60);
          // Tight tolerance comparing against the best achievable angle on the side (90°)
          expect(a).toBeLessThanOrEqual(best + 0.1);
        } else {
          // When <= 60° is achievable together with side, result must be <= 60°
          expect(a).toBeLessThanOrEqual(60.001);
          // Tight tolerance comparing against the best achievable angle on the side
          expect(a).toBeLessThanOrEqual(best + 0.1);
          expect(a).toBeGreaterThanOrEqual(best - 1e-3);
        }
      }
    }
  });
  it("rule 2: a point on the axis is pushed strictly to the required side (20x20, a [2,2] yaw 225, b [2,4], close)", () => {
    const room: DRoom = { outline: rect(20, 20), ceiling: 3, open: false };
    const s = step(line("a", "close"), [act("a", [2, 2], { yaw: 225 }), act("b", [2, 4], { yaw: 0 })], room);
    expect(Math.abs(s.cam[0] - 2)).toBeGreaterThan(1e-6);
    expect(s.cam[0]).toBeGreaterThan(2);
    const law = { outline: room.outline, rect: roomRect(room.outline), height: 3, floorY: 0, side: { origin: [2, 3] as [number, number], normal: [-1, 0] as [number, number], sign: -1 as const } };
    const p = legalCameraPoint([2, 1.5, 6], law);
    expect(p[0]).toBeGreaterThan(2 + 1e-6);
  });
  it("rule 3: L room, wide across the axis stays inside the outline on the required side", () => {
    const room: DRoom = { outline: L, ceiling: 3, open: false };
    for (const pair of [[[8, 1], [8, 3]], [[1, 8], [3, 8]], [[1, 1], [8, 1]], [[2, 2], [2, 8]], [[8, 3], [2, 9]]] as Array<Array<[number, number]>>) {
      const m: [number, number] = [(pair[0][0] + pair[1][0]) / 2, (pair[0][1] + pair[1][1]) / 2];
      const d: [number, number] = [pair[1][0] - pair[0][0], pair[1][1] - pair[0][1]];
      const len = Math.hypot(d[0], d[1]);
      const axis: [number, number] = [d[0] / len, d[1] / len];
      const norm: [number, number] = [-axis[1], axis[0]];
      const toCenter = (5 - m[0]) * norm[0] + (5 - m[1]) * norm[1];
      const side = toCenter < 0 ? -1 : 1;
      // the pair faces the room-center side, so that side stays required (a fresh wide crosses the line only when
      // this side is behind the faces, stage-director-faces.test.ts); the rule here is the L outline
      const yaw = (Math.atan2(norm[0] * side, norm[1] * side) * 180) / Math.PI;
      const s = step(line("a", "wide"), [act("a", pair[0], { yaw }), act("b", pair[1], { yaw })], room);
      expect(insideInset(L, [s.cam[0], s.cam[2]])).toBe(true);
      const signedDot = ((s.cam[0] - m[0]) * norm[0] + (s.cam[2] - m[1]) * norm[1]) * side;
      expect(signedDot).toBeGreaterThan(1e-6);
    }
    const law = { outline: L, rect: roomRect(L), height: 3, floorY: 0, side: { origin: [8, 2] as [number, number], normal: [-1, 0] as [number, number], sign: 1 as const } };
    const p = legalCameraPoint([12, 2, 9], law);
    expect(insideInset(L, [p[0], p[2]])).toBe(true);
    expect((p[0] - 8) * -1).toBeGreaterThan(0);
  });
  it("rule 4: smoothing a follow step of 0.25 s never enters the L notch", () => {
    const room: DRoom = { outline: L, ceiling: 3, open: false };
    const d = createDirector(rng);
    // Director builds follow frame for a walking actor in L room
    const s1 = d.step({ event: { kind: "tick", dt: 0 }, actors: [act("a", [8, 2], { walking: true, yaw: 180 })], room, rng });
    const s2 = d.step({ event: { kind: "tick", dt: 0.25 }, actors: [act("a", [2, 8], { walking: true, yaw: 270 })], room, rng });
    expect(s1.plan).toBe("follow");
    expect(s2.plan).toBe("follow");
    expect(insideInset(L, [s1.cam[0], s1.cam[2]])).toBe(true);
    expect(insideInset(L, [s2.cam[0], s2.cam[2]])).toBe(true);
    const k = 1 - Math.exp(-4 * 0.25);
    const p = smoothCam(s1.cam, s2.cam, k, L);
    expect(insideInset(L, [p[0], p[2]])).toBe(true);
    // Un-snapped direct linear interpolation would land in the notch
    const directLinear: [number, number] = [s1.cam[0] + (s2.cam[0] - s1.cam[0]) * k, s1.cam[2] + (s2.cam[2] - s1.cam[2]) * k];
    expect(insideInset(L, directLinear)).toBe(false);

    for (const [a, b] of [[[8, 1.2, 1], [1.2, 1.5, 8]], [[1, 1.5, 8], [8, 1.5, 1]], [[9, 1.5, 3], [3, 1.5, 9]]] as Array<[[number, number, number], [number, number, number]]>) {
      const sp = smoothCam(a, b, k, L);
      expect(insideInset(L, [sp[0], sp[2]])).toBe(true);
    }
  });
  it("rule 5: no actors, closed 5x5 room with ceiling 0.4 -> camera height within [0.3, ceiling - 0.1]", () => {
    const s = step({ kind: "tick", dt: 0.1 }, [], { outline: rect(5, 5), ceiling: 0.4, open: false });
    expect(s.cam[1]).toBeGreaterThanOrEqual(0.3 - 1e-9);
    expect(s.cam[1]).toBeLessThanOrEqual(0.4 - 0.1 + 1e-9);
  });
  it("rule 6: a 10x0.4 room has no 0.3 m inset point: fallback is the room center", () => {
    const room: DRoom = { outline: rect(10, 0.4), ceiling: 3, open: false };
    const s = step(line("a", "wide"), [act("a", [2, 0.2]), act("b", [4, 0.2])], room);
    expect(s.cam[0]).toBeCloseTo(5, 6);
    expect(s.cam[2]).toBeCloseTo(0.2, 6);
  });
});
