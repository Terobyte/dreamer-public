/** k19_true: Mirai lying on the bed had her head inside the pillow. The bed GLB measured along her line:
 *  mattress 0.57 m, pillow from z 2.9 to 3.3 rising to 0.75 m; her head bone at z 2.92, y 0.68 (r ~0.1). */
import { describe, it, expect } from "vitest";
import { BoxGeometry, Group, Mesh, MeshBasicMaterial } from "three";
import { createHeight } from "../src/runtime/stage/sight.js";
import { pillowShift } from "../src/runtime/stage/places.js";

const bedHeight = (x: number, z: number): number | null => (Math.abs(x + 1.25) > 0.55 || z < 1.5 || z > 3.5 ? null : z > 2.9 && z < 3.3 ? 0.75 : 0.57);

describe("head on the pillow, not in it", () => {
  it("a head sunk in the pillow slides toward the foot until the pillow is under it", () => {
    const s = pillowShift([-1.3, 0.68, 2.92], [0, -1], bedHeight, 0.57, 0.1);
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThanOrEqual(0.15);
    // k21_dbg: the head centre cleared after 3 cm, the back of the head (0.1 m toward the pillow) was still in it
    expect(bedHeight(-1.3, 2.92 - s + 0.1)!).toBeLessThanOrEqual(0.6);
  });
  it("a head already clear of the pillow stays", () => {
    expect(pillowShift([-1.3, 0.68, 2.7], [0, -1], bedHeight, 0.57, 0.1)).toBe(0);
  });
  it("a body tucked under the blanket (head bone below the mattress top) still only clears the pillow (k20_true: slid the 0.4 m cap)", () => {
    const s = pillowShift([-1.3, 0.47, 2.92], [0, -1], bedHeight, 0.57, 0.1);
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThanOrEqual(0.15);
  });
  it("never slides more than the cap", () => {
    expect(pillowShift([-1.3, 0.68, 3.25], [0, -1], (x, z) => (z > 2.0 ? 0.75 : 0.57), 0.57, 0.1, 0.3)).toBe(0.3);
  });

  it("the height probe finds the top of the furniture under a point, actors skipped", () => {
    const world = new Group();
    const mattress = new Mesh(new BoxGeometry(1, 0.57, 2), new MeshBasicMaterial());
    mattress.position.set(0, 0.285, 0);
    const pillow = new Mesh(new BoxGeometry(0.8, 0.18, 0.4), new MeshBasicMaterial());
    pillow.position.set(0, 0.66, 0.7);
    const actor = new Mesh(new BoxGeometry(0.3, 2, 0.3), new MeshBasicMaterial());
    actor.position.set(0, 1, -0.5);
    // k21_dbg: the probe hit the ceiling (3.4 m) over the bed and never saw the pillow
    const ceiling = new Mesh(new BoxGeometry(8, 0.1, 8), new MeshBasicMaterial());
    ceiling.position.set(0, 2.65, 0);
    world.add(mattress, pillow, actor, ceiling);
    const h = createHeight(world, () => [actor]);
    expect(h(0, 0, 1.5)).toBeCloseTo(0.57, 2);
    expect(h(0, 0.7, 1.5)).toBeCloseTo(0.75, 2);
    expect(h(0, -0.5, 1.5)).toBeCloseTo(0.57, 2);
    expect(h(3, 0, 1.5)).toBeNull();
  });
});
