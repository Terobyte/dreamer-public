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

/** Squidward, Nov 3 ("32 секунда ужасно, камера откуда-то из мольберта"): the close of his face stood 30 cm from the
 *  canvas, which filled a third of the frame. The rays to the head and the chest passed beside it, so the probe said
 *  clear. A thing within arm's reach of the lens anywhere in the frame is a bad frame too. */
describe("sight: nothing right in front of the lens", () => {
  const cam: [number, number, number] = [0, 1.2, 2], look: [number, number, number] = [0, 1.5, 0];
  it("a canvas 40 cm ahead at the side of the frame blocks, though the head and chest rays miss it", () => {
    const w = new Group();
    w.add(box(0.6, 0.8, 0.03, -0.45, 1.2, 1.6));
    expect(createSight(w, () => [])(cam, look)).toBe(false);
  });
  it("the same canvas 2 m to the side does not", () => {
    const w = new Group();
    w.add(box(0.6, 0.8, 0.03, -2.4, 1.2, 1.6));
    expect(createSight(w, () => [])(cam, look)).toBe(true);
  });
  it("the floor under a low camera looking down does not", () => {
    const w = new Group();
    const ground = new Mesh(new PlaneGeometry(50, 50), new MeshBasicMaterial());
    ground.rotation.x = -Math.PI / 2;
    w.add(ground);
    expect(createSight(w, () => [])([0, 0.5, 1.0], [0, 0.45, 0])).toBe(true);
    expect(createSight(w, () => [])([0, 1.4, 1.0], [0, 0.6, 0])).toBe(true);
  });
});

/** Squidward, Nov 3: the stage asks the probe from its first frame, the props' GLBs swap in after (main.ts awaits
 *  glbSwaps last); the probe kept the meshes of its first call and never saw the easel. A model added to the world
 *  later counts, a placeholder taken out does not. */
describe("sight: the world as it is now, not as it was at the first frame", () => {
  it("a GLB that lands after the first probe blocks; the placeholder it replaced does not", () => {
    const w = new Group();
    const placeholder = box(0.2, 0.2, 0.2, 5, 0.1, 5);
    w.add(placeholder);
    const clear = createSight(w, () => []);
    expect(clear([0, 0.8, 3], [0, 0.8, -1])).toBe(true);
    w.remove(placeholder);
    w.add(box(1.4, 1.0, 0.1, 0, 0.5, 1));
    expect(clear([0, 0.8, 3], [0, 0.8, -1])).toBe(false);
  });
});

describe("sight: a camera inside a prop's box", () => {
  it("between the easel's legs, every ray free, is still a bad spot (Squidward 25 s)", () => {
    const w = new Group();
    const easel = new Group();
    easel.userData.kind = "prop";
    easel.add(box(0.05, 1.7, 0.05, -0.6, 0.85, 0), box(0.05, 1.7, 0.05, 0.6, 0.85, 0), box(0.05, 1.7, 0.05, 0, 0.85, 1.1));
    w.add(easel);
    // standing between the legs, looking out past the back leg's side
    expect(createSight(w, () => [])([0, 1.2, 0.5], [-3, 1.2, 3])).toBe(false);
  });
  it("the room's shell around the camera is not a prop", () => {
    const w = new Group();
    w.add(box(6, 2.6, 0.1, 0, 1.3, -3), box(6, 2.6, 0.1, 0, 1.3, 3));
    expect(createSight(w, () => [])([0, 1.2, 0.5], [2, 1.2, 0.5])).toBe(true);
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

/** Squidward, Nov 3 (v23 17.8–21.3 s, 40 s): SpongeBob stood right behind a chair back; the camera behind the chair
 *  saw the back of the chair and the side of his box. The probe left the last 25 cm before the face uncounted (so a
 *  pillow under a lying head does not block) and the chair back stood inside them. Near the target only what lies
 *  under it is let go; a thing standing between the lens and the face blocks at any distance. */
describe("sight: a chair back right in front of the face", () => {
  const face: [number, number, number] = [0, 0.75, 0];
  it("a panel 15 cm in front of the face, the camera behind it: blocked", () => {
    const w = new Group();
    w.add(box(0.6, 1.4, 0.04, 0, 0.7, 0.15));
    const clear = createSight(w, () => []);
    expect(clear([0, 1.1, 3], face)).toBe(false);
  });
  it("a pillow under a lying head still does not block", () => {
    const w = new Group();
    w.add(box(0.6, 0.15, 0.4, 0, 0.6, 0));
    const clear = createSight(w, () => []);
    expect(clear([0, 1.6, 2.5], [0, 0.72, 0])).toBe(true);
  });
});
