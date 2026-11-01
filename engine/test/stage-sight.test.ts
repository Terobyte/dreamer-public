import { describe, it, expect } from "vitest";
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, PlaneGeometry } from "three";
import { createSight, markNoblock, isPlantId } from "../src/runtime/stage/sight.js";

const box = (w: number, h: number, d: number, x: number, y: number, z: number): Mesh => {
  const m = new Mesh(new BoxGeometry(w, h, d), new MeshBasicMaterial());
  m.position.set(x, y, z);
  return m;
};

describe("sight: raycast probe for the director", () => {
  const world = new Group();
  const footboard = box(1.4, 1.0, 0.1, 0, 0.5, 2);
  world.add(footboard);
  const ground = new Mesh(new PlaneGeometry(50, 50), new MeshBasicMaterial());
  ground.rotation.x = -Math.PI / 2;
  world.add(ground);
  const actor = new Group();
  actor.add(box(0.4, 1, 0.4, 0, 0.5, 0));
  world.add(actor);
  const clear = createSight(world, () => [actor]);

  it("furniture between camera and head blocks", () => {
    expect(clear([0, 0.8, 4], [0, 0.8, 0])).toBe(false);
  });
  it("a camera above the footboard sees", () => {
    expect(clear([0, 2.2, 4], [0, 0.9, 0])).toBe(true);
  });
  it("the actor itself and the ground under the sightline never block", () => {
    expect(clear([3, 0.9, 0], [0, 0.9, 0])).toBe(true);
  });
});

describe("sight: vegetation never blocks (noblock)", () => {
  const field = (flag: boolean): Group => {
    const w = new Group();
    for (let i = 0; i < 200; i++) {
      const m = box(0.4, 0.4, 0.4, (i % 10) * 0.2 - 0.9, 0.2, -0.4 + Math.floor(i / 10) * 0.08);
      if (flag) m.userData.noblock = true;
      w.add(m);
    }
    const a = new Group();
    a.add(box(0.4, 0.95, 0.4, 0, 0.475, -0.5));
    w.add(a);
    return w;
  };
  const cam: [number, number, number] = [0, 1.2, 2], look: [number, number, number] = [0, 0.3, -0.5];
  it("200 tufts with noblock: clear", () => {
    const w = field(true);
    expect(createSight(w, () => [w.children[200]])(cam, look)).toBe(true);
  });
  it("same boxes without the mark: blocked", () => {
    const w = field(false);
    expect(createSight(w, () => [w.children[200]])(cam, look)).toBe(false);
  });
  it("a bed back without the mark still blocks", () => {
    const w = new Group();
    w.add(box(1.4, 1.0, 0.1, 0, 0.5, 1));
    expect(createSight(w, () => [])([0, 0.8, 3], [0, 0.8, -1])).toBe(false);
  });
  it("a grass_tuft prop with GLB meshes marked by id does not block", () => {
    expect(isPlantId("grass_tuft")).toBe(true);
    expect(isPlantId("bed_back")).toBe(false);
    const w = new Group();
    const glb = new Group();
    const part = box(1, 1, 1, 0, 0.5, 1);
    glb.add(part);
    markNoblock(glb, "grass_tuft");
    w.add(glb);
    expect(createSight(w, () => [])([0, 0.8, 3], [0, 0.8, -1])).toBe(true);
    const bed = new Group();
    bed.add(box(1, 1, 1, 0, 0.5, 1));
    markNoblock(bed, "bed");
    expect(createSight(bed, () => [])([0, 0.8, 3], [0, 0.8, -1])).toBe(false);
  });
});
