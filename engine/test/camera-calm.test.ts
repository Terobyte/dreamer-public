/** Koshakan k12_storybook film, Nov 3: the K2 camera read as jerky and trembling. Each test is one cause. */
import { describe, it, expect } from "vitest";
import { BoxGeometry, Group, Mesh, MeshBasicMaterial } from "three";
import { STYLES } from "../src/runtime/stage/styles.js";
import { createSight } from "../src/runtime/stage/sight.js";
import { createDirector, type DActor, type DRoom } from "../src/runtime/stage/director.js";

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

  it("storybook is calm: no shake, mostly still plans, camera at a grown-up's eye", () => {
    const s = STYLES.storybook;
    expect(s.shake).toEqual([0, 0]);
    expect(s.move).toBeLessThanOrEqual(0.4);
    expect(s.height[0]).toBeGreaterThanOrEqual(1.0);
  });
});
