import { describe, it, expect } from "vitest";
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, PlaneGeometry } from "three";
import { createSight } from "../src/runtime/stage/sight.js";

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
