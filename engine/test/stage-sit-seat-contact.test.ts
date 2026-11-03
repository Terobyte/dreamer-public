/** Squidward, Nov 3 (v8 85–125 s, "спанчбоб сидит слишком низко, он заходит в кресло"): SpongeBob's square pants
 *  hang 7 cm under his hip joints; the seat took the hip joints, so the pants sank into the chair. What lands on the
 *  seat is the bottom of the body between the legs (the crotch), a rig without a skin keeps the hip joints. */
import { describe, it, expect } from "vitest";
import { Bone, BoxGeometry, Float32BufferAttribute, Group, MeshBasicMaterial, Skeleton, SkinnedMesh, Uint16BufferAttribute } from "three";
import { legHeights, sitDrop } from "../src/runtime/stage/pose.js";

/** a 1 m box figure: pants from y 0.33 to 1.0 skinned to the hips, thigh joints at 0.40 (x ±0.045), knees at 0.26 */
function sponge(): Group {
  const root = new Group();
  const hips = new Bone();
  hips.name = "hips";
  hips.position.set(0, 0.6, 0);
  root.add(hips);
  const bones = [hips];
  for (const [s, x] of [["L", 0.045], ["R", -0.045]] as const) {
    const th = new Bone();
    th.name = `thigh_${s}`;
    th.position.set(x, -0.2, 0);
    hips.add(th);
    const sh = new Bone();
    sh.name = `shin_${s}`;
    sh.position.set(0, -0.14, 0);
    th.add(sh);
    const ft = new Bone();
    ft.name = `foot_${s}`;
    ft.position.set(0, -0.2, 0);
    sh.add(ft);
    bones.push(th, sh, ft);
  }
  const g = new BoxGeometry(0.5, 0.67, 0.3, 20, 4, 4);  // a mesh as dense as a real body: points between the legs
  g.translate(0, 0.665, 0);
  const n = g.attributes.position.count;
  g.setAttribute("skinIndex", new Uint16BufferAttribute(new Array(n * 4).fill(0), 4));
  g.setAttribute("skinWeight", new Float32BufferAttribute(Array.from({ length: n * 4 }, (_, i) => (i % 4 ? 0 : 1)), 4));
  const m = new SkinnedMesh(g, new MeshBasicMaterial());
  root.add(m);
  root.updateMatrixWorld(true);
  m.bind(new Skeleton(bones));
  root.updateMatrixWorld(true);
  return root;
}

describe("a seat takes the bottom of the body, not the hip joints", () => {
  it("the box figure's pants bottom (0.33) lands on a 0.4955 m seat", () => {
    const legs = legHeights(sponge(), 0)!;
    expect(legs.pelvis).toBeCloseTo(0.4, 2);
    const drop = sitDrop(legs, 1.0, 0.4955);
    // seated, the pants bottom stands on the seat: 0.33 - drop = 0.4955 (±1 cm)
    expect(0.33 - drop).toBeGreaterThan(0.4855);
    expect(0.33 - drop).toBeLessThan(0.5055);
  });
});
