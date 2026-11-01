import { describe, it, expect, vi, afterEach } from "vitest";
import { AnimationClip, Bone, Group, Quaternion, QuaternionKeyframeTrack, Vector3 } from "three";
import { createAnimator } from "../src/runtime/stage/anim.js";

// Koshakan, Nov 1: with no idle clip the cast stood as a still frame between verbs ("просто они стояли").
// The animator lays a procedural life layer (breath, weight shift, head looking around, nods while talking)
// over whatever the mixer wrote, on the spine/neck/head only, never accumulating.

const deg = (q: Quaternion, r: Quaternion): number => (q.angleTo(r) * 180) / Math.PI;
const spyWarn = () => vi.spyOn(console, "warn").mockImplementation(() => {});
afterEach(() => vi.restoreAllMocks());

function rig(): { root: Group; bone: (n: string) => Bone } {
  const root = new Group();
  const chain = ["pelvis", "spine1", "spine2", "chest", "neck", "head"];
  let parent: Group | Bone = root;
  for (const n of chain) {
    const b = new Bone();
    b.name = n;
    b.position.y = n === "pelvis" ? 1 : 0.15;
    parent.add(b);
    parent = b;
  }
  for (const s of ["L", "R"]) {
    const ua = new Bone();
    ua.name = `upperarm_${s}`;
    root.getObjectByName("chest")!.add(ua);
  }
  return { root, bone: (n) => root.getObjectByName(n) as Bone };
}
const still = () => new AnimationClip("stand", 1, [new QuaternionKeyframeTrack("upperarm_L.quaternion", [0, 1], [0, 0, 0, 1, 0, 0, 0, 1])]);

const run = (a: ReturnType<typeof createAnimator>, seconds: number, talking = false) => {
  for (let t = 0; t < seconds; t += 1 / 30) a.update(1 / 30, { talking });
};

describe("animator: life layer (no idle clip)", () => {
  it("the head and chest move over time instead of a still frame", () => {
    spyWarn();
    const { root, bone } = rig();
    const a = createAnimator(root, { stand: still() }, { seed: "Mirai" });
    run(a, 1);
    const h1 = bone("head").quaternion.clone(), c1 = bone("chest").quaternion.clone();
    run(a, 2.3);
    expect(deg(h1, bone("head").quaternion)).toBeGreaterThan(1);
    expect(deg(c1, bone("chest").quaternion)).toBeGreaterThan(0.3);
  });

  it("stays small and never accumulates (bone without a track, 5 minutes)", () => {
    spyWarn();
    const { root, bone } = rig();
    const rest = bone("head").quaternion.clone();
    const a = createAnimator(root, { stand: still() }, { seed: "Mama" });
    let worst = 0;
    for (let i = 0; i < 300 * 30; i++) {
      a.update(1 / 30);
      if (i % 30 === 0) worst = Math.max(worst, deg(rest, bone("head").quaternion));
    }
    expect(worst).toBeGreaterThan(1);
    expect(worst).toBeLessThan(15);
  });

  it("two actors do not breathe in lockstep", () => {
    spyWarn();
    const A = rig(), B = rig();
    const a = createAnimator(A.root, { stand: still() }, { seed: "Mirai" });
    const b = createAnimator(B.root, { stand: still() }, { seed: "Mama" });
    run(a, 3);
    run(b, 3);
    expect(deg(A.bone("head").quaternion, B.bone("head").quaternion)).toBeGreaterThan(0.5);
  });

  it("talking nods the head more than listening", () => {
    spyWarn();
    const spread = (talking: boolean): number => {
      const { root, bone } = rig();
      const a = createAnimator(root, { stand: still() }, { seed: "Mirai" });
      run(a, 1, talking);
      const qs: Quaternion[] = [];
      for (let i = 0; i < 60; i++) {
        a.update(1 / 30, { talking });
        qs.push(bone("head").quaternion.clone());
      }
      let m = 0;
      for (let i = 1; i < qs.length; i++) m += deg(qs[i - 1], qs[i]);
      return m;
    };
    expect(spread(true)).toBeGreaterThan(spread(false) * 1.8);
  });

  it("does not touch the arms or the pelvis (feet stay planted, held poses stay held)", () => {
    spyWarn();
    const { root, bone } = rig();
    const a = createAnimator(root, { stand: still() }, { seed: "Mirai" });
    const arm = bone("upperarm_L").quaternion.clone(), pelvis = bone("pelvis").quaternion.clone();
    run(a, 4, true);
    expect(deg(arm, bone("upperarm_L").quaternion)).toBeLessThan(1e-3);
    expect(deg(pelvis, bone("pelvis").quaternion)).toBeLessThan(1e-3);
  });

  it("works with no clips at all (a rigged body that only stands)", () => {
    spyWarn();
    const { root, bone } = rig();
    const a = createAnimator(root, {}, { seed: "x" });
    const h0 = bone("head").quaternion.clone();
    run(a, 2);
    expect(deg(h0, bone("head").quaternion)).toBeGreaterThan(0.5);
  });

  it("life: false keeps the mixer's pose exact", () => {
    spyWarn();
    const { root, bone } = rig();
    const a = createAnimator(root, { stand: still() }, { life: false });
    const h0 = bone("head").quaternion.clone();
    run(a, 2, true);
    expect(deg(h0, bone("head").quaternion)).toBeLessThan(1e-6);
  });
});

void Vector3;
