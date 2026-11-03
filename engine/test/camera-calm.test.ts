/** Koshakan k12_storybook film, Nov 3: the K2 camera read as jerky and trembling. Each test is one cause. */
import { describe, it, expect } from "vitest";
import { BoxGeometry, Group, Mesh, MeshBasicMaterial } from "three";
import { STYLES } from "../src/runtime/stage/styles.js";
import { createSight } from "../src/runtime/stage/sight.js";
import { createDirector, type DActor, type DRoom } from "../src/runtime/stage/director.js";
import { ndcOf } from "../src/runtime/stage/moves.js";
import type { V3 } from "../src/runtime/stage/camera.js";

const ROOM: DRoom = { outline: [[-4, -4], [4, -4], [4, 4], [-4, 4]], ceiling: 3, open: false };
const act = (name: string, pos: [number, number], yaw: number): DActor => ({ name, pos, yaw, height: 1.7, level: null, room: "R", walking: false });

describe("camera calm", () => {
  it("a camera inside furniture is not a clear view (k12: the first frame sat inside the bed)", () => {
    const world = new Group();
    const bed = new Mesh(new BoxGeometry(2, 0.5, 2), new MeshBasicMaterial());
    bed.position.set(0, 0.25, 2);
    world.add(bed);
    const clear = createSight(world, () => []);
    expect(clear([0, 0.3, 2], [0, 1.2, -1])).toBe(false);
    expect(clear([0, 1.2, 4.5], [0, 1.2, -1])).toBe(true);
  });

  it("storybook: one narrator sentence per second does not cut faster than asl.min (k12: 3 cuts in 1.5 s)", () => {
    const d = createDirector(() => 0.5, { style: "storybook" });
    const A = [act("Mama", [0, 0], 0), act("Mirai", [0, 1.2], 180)];
    const cuts = new Set<number>();
    for (let i = 0; i < 10; i++) {
      const o = d.step({ event: { kind: "narrator", durationS: 1, dt: i === 0 ? 0 : 1, beat: i }, actors: A, room: ROOM });
      cuts.add(o.cut);
    }
    expect(cuts.size).toBeLessThanOrEqual(1 + Math.floor(10 / STYLES.storybook.asl[0]));
  });

  it("storybook shoots rarely: narrator beats keep the base frames, a scene start and a spoken line get a move", () => {
    const d = createDirector(() => 0.5, { style: "storybook" });
    const A = [act("Mama", [0, 0], 0), act("Mirai", [0, 1.2], 180)];
    const first = d.step({ event: { kind: "narrator", durationS: 8, dt: 0, beat: 0, tags: { first: true } }, actors: A, room: ROOM });
    expect(first.move).toBe("establishing");
    const nar = d.step({ event: { kind: "narrator", durationS: 8, dt: 8, beat: 1 }, actors: A, room: ROOM });
    expect(nar.move).toBeUndefined();
    const line = d.step({ event: { kind: "line", speaker: "Mama", durationS: 3, dt: 8, beat: 2 }, actors: A, room: ROOM });
    expect(line.move).toBeTruthy();
  });

  // k12_calm (Nov 3): the Koshakan bedroom, 3.6 x 4 m, Mirai lying on the bed by the wall, Mama not in yet
  const BED: DRoom = { outline: [[-2.6, -0.6], [1.0, -0.6], [1.0, 3.4], [-2.6, 3.4]], ceiling: 2.6, open: false };
  const mirai = (): DActor => ({ ...act("Mirai", [-1.21, 2.63], 180), height: 0.95, lying: true, head: [-1.21, 0.45, 2.85] });
  const mama = (): DActor => ({ ...act("Mama", [-0.7, 2.2], 300), head: [-0.7, 1.15, 2.2] });
  const inFrame = (o: { cam: V3; look: V3; fov?: number }, h: V3): boolean => {
    const p = ndcOf(h, o.cam, o.look, o.fov ?? 50, 16 / 9);
    return p.depth > 0.2 && Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1;
  };

  it("the opening shot has the lying child in frame (k12_calm 6–16 s: an empty room, Mirai under the frame)", () => {
    const d = createDirector(() => 0.5, { style: "storybook" });
    const o = d.step({ event: { kind: "narrator", durationS: 8, dt: 0, beat: 0, tags: { first: true } }, actors: [mirai()], room: BED });
    expect(inFrame(o, mirai().head!)).toBe(true);
  });

  it("a spoken line to a lying listener keeps both in frame (k12_calm 32–40 s: Mama alone, huge)", () => {
    const d = createDirector(() => 0.5, { style: "storybook" });
    const A = [mama(), mirai()];
    d.step({ event: { kind: "narrator", durationS: 6, dt: 0, beat: 0, tags: { first: true } }, actors: A, room: BED });
    const o = d.step({ event: { kind: "line", speaker: "Mama", durationS: 4, dt: 6, beat: 1, tags: { look: true } }, actors: A, room: BED });
    expect(inFrame(o, mama().head!)).toBe(true);
    expect(inFrame(o, mirai().head!)).toBe(true);
  });

  it("a line by Mama sitting by lying Mirai keeps both in frame (k13_true 30 s: a close over Mirai, Mama alone)", () => {
    const d = createDirector(() => 0.5, { style: "storybook" });
    const sit: DActor = { ...act("Mama", [-1.65, 2.28], 315), head: [-1.64, 1.02, 2.29] };
    const A = [sit, mirai()];
    d.step({ event: { kind: "narrator", durationS: 6, dt: 0, beat: 0, tags: { first: true } }, actors: A, room: BED });
    d.step({ event: { kind: "narrator", durationS: 6, dt: 6, beat: 1 }, actors: A, room: BED });
    for (const r of [0.1, 0.5, 0.9]) {
      const e = createDirector(() => r, { style: "storybook" });
      e.step({ event: { kind: "narrator", durationS: 6, dt: 0, beat: 0, tags: { first: true } }, actors: A, room: BED });
      const o = e.step({ event: { kind: "line", speaker: "Mama", durationS: 4, dt: 6, beat: 1, tags: { look: true } }, actors: A, room: BED });
      expect(inFrame(o, sit.head!)).toBe(true);
      expect(inFrame(o, mirai().head!)).toBe(true);
    }
  });

  it("the base wide does not look steeply down (k12_calm: 2.2 m, 30–39° down, the walls keystoned)", () => {
    const d = createDirector(() => 0.5);
    const o = d.step({ event: { kind: "narrator", durationS: 6, dt: 0 }, actors: [mama(), mirai()], room: BED });
    const flat = Math.hypot(o.look[0] - o.cam[0], o.look[2] - o.cam[2]);
    expect((Math.atan2(o.cam[1] - o.look[1], flat) * 180) / Math.PI).toBeLessThanOrEqual(20);
    expect(o.cam[1]).toBeLessThanOrEqual(1.7);
  });

  it("storybook is calm: no shake, mostly still plans, camera at a grown-up's eye", () => {
    const s = STYLES.storybook;
    expect(s.shake).toEqual([0, 0]);
    expect(s.move).toBeLessThanOrEqual(0.4);
    expect(s.height[0]).toBeGreaterThanOrEqual(1.0);
  });
});
