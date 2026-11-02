import { describe, it, expect } from "vitest";
import { Bone, Group, Vector3 } from "three";
import { sitLegs } from "../src/runtime/stage/pose.js";

// Н9 (раунд 6 прогона worlds-a, не попал в ветку): сидя бедро вперёд, колено ~85°, голень висит вниз.

/** a standing humanoid: feet on y = 0, hips 0.95; legs straight down */
function rig(o: { knee?: boolean } = {}): { root: Group; b: Record<string, Bone> } {
  const root = new Group();
  const mk = (name: string, parent: Bone | Group, x: number, y: number): Bone => {
    const bone = new Bone();
    bone.name = name;
    bone.position.set(x, y, 0);
    parent.add(bone);
    return bone;
  };
  const hips = mk("Hips", root, 0, 0.95);
  const up = mk("LeftUpLeg", hips, 0.1, -0.05);
  const lo = o.knee === false ? up : mk("LeftLeg", up, 0, -0.45);
  const foot = mk("LeftFoot", lo, 0, -0.45);
  const upR = mk("RightUpLeg", hips, -0.1, -0.05);
  const loR = o.knee === false ? upR : mk("RightLeg", upR, 0, -0.45);
  const footR = mk("RightFoot", loR, 0, -0.45);
  root.updateMatrixWorld(true);
  return { root, b: { hips, up, lo, foot, upR, loR, footR } };
}
const wp = (o: Bone): Vector3 => o.getWorldPosition(new Vector3());
const kneeAngle = (up: Bone, lo: Bone, foot: Bone): number => {
  const t = wp(lo).sub(wp(up)).normalize();
  const s = wp(foot).sub(wp(lo)).normalize();
  return (Math.acos(Math.min(1, Math.max(-1, t.dot(s)))) * 180) / Math.PI;
};

describe("sitLegs", () => {
  it("thigh forward along the facing, knee ~85 deg, shin hangs down (both sides)", () => {
    const { root, b } = rig();
    root.rotation.y = Math.PI / 2; // faces +X
    root.updateMatrixWorld(true);
    const undo = sitLegs(root);
    expect(undo).not.toBeNull();
    root.updateMatrixWorld(true);
    for (const [up, lo, foot] of [[b.up, b.lo, b.foot], [b.upR, b.loR, b.footR]] as const) {
      expect(wp(lo).x - wp(up).x).toBeGreaterThan(0.3);
      expect(wp(lo).y - wp(foot).y).toBeGreaterThan(0.3);
      expect(Math.abs(wp(foot).x - wp(lo).x)).toBeLessThan(0.15);
      expect(Math.abs(kneeAngle(up, lo, foot) - 85)).toBeLessThan(10);
    }
    // the pelvis does not move: the seat height stays the caller's business
    expect(wp(b.hips).y).toBeCloseTo(0.95, 6);
  });
  it("undo puts every leg bone back exactly; apply-undo-apply gives the same body", () => {
    const { root, b } = rig();
    const q0 = [b.up, b.lo, b.upR, b.loR].map((x) => x.quaternion.clone());
    const undo = sitLegs(root)!;
    const q1 = [b.up, b.lo, b.upR, b.loR].map((x) => x.quaternion.clone());
    undo();
    [b.up, b.lo, b.upR, b.loR].forEach((x, k) => expect(x.quaternion.angleTo(q0[k]!)).toBeLessThan(1e-9));
    sitLegs(root);
    [b.up, b.lo, b.upR, b.loR].forEach((x, k) => expect(x.quaternion.angleTo(q1[k]!)).toBeLessThan(1e-6));
  });
  it("Mixamo names (mixamorig:LeftUpLeg / mixamorig:LeftLeg) bend too", () => {
    const { root, b } = rig();
    for (const [o, n] of [[b.up, "mixamorig:LeftUpLeg"], [b.lo, "mixamorig:LeftLeg"], [b.foot, "mixamorig:LeftFoot"],
      [b.upR, "mixamorig:RightUpLeg"], [b.loR, "mixamorig:RightLeg"], [b.footR, "mixamorig:RightFoot"]] as const) o.name = n;
    expect(sitLegs(root)).not.toBeNull();
    root.updateMatrixWorld(true);
    expect(Math.abs(kneeAngle(b.up, b.lo, b.foot) - 85)).toBeLessThan(10);
    expect(Math.abs(kneeAngle(b.upR, b.loR, b.footR) - 85)).toBeLessThan(10);
  });
  it("a rig without a knee bone (or a box) -> null, nothing bent", () => {
    const { root, b } = rig({ knee: false });
    const q = b.up.quaternion.clone();
    expect(sitLegs(root)).toBeNull();
    expect(b.up.quaternion.angleTo(q)).toBe(0);
    expect(sitLegs(new Group())).toBeNull();
  });
});
