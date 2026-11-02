import { describe, it, expect, vi, afterEach } from "vitest";
import { AnimationClip, Bone, Group, Quaternion, QuaternionKeyframeTrack, Vector3 } from "three";
import { createAnimator } from "../src/runtime/stage/anim.js";
import { createLife } from "../src/runtime/stage/life.js";
import { resolveGaze, placeGazePoint, type GazeActor } from "../src/runtime/stage/index.js";
import type { Place } from "../src/runtime/stage/places.js";

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

// gaze: the head follows a world point (the speaker's head) instead of wandering on its own sines
describe("animator: life layer gaze (look)", () => {
  const D = Math.PI / 180;
  const fwd = (b: Bone): Vector3 => new Vector3(0, 0, 1).applyQuaternion(b.getWorldQuaternion(new Quaternion()));
  const yawPitch = (root: Group, b: Bone): { yaw: number; pitch: number } => {
    const f = fwd(b).applyQuaternion(root.getWorldQuaternion(new Quaternion()).invert());
    return { yaw: Math.atan2(f.x, f.z) / D, pitch: Math.asin(Math.max(-1, Math.min(1, f.y))) / D };
  };
  const toward = (root: Group, b: Bone, p: [number, number, number]): number => {
    const h = b.getWorldPosition(new Vector3());
    return (fwd(b).angleTo(new Vector3(p[0], p[1], p[2]).sub(h)) * 180) / Math.PI;
  };
  const feed = (a: ReturnType<typeof createAnimator>, sec: number, look?: [number, number, number]) => {
    for (let t = 0; t < sec - 1e-9; t += 1 / 30) a.update(1 / 30, { talking: false, look });
  };

  it("B turned 45 deg from A looks at A's head within 8 deg after 1 s", () => {
    spyWarn();
    const { root, bone } = rig();
    root.rotation.y = 45 * D;
    root.updateMatrixWorld(true);
    const a = createAnimator(root, { stand: still() }, { seed: "B" });
    const target: [number, number, number] = [0, 1.75, 3];
    feed(a, 1, target);
    expect(toward(root, bone("head"), target)).toBeLessThan(8);
  });

  it("the neck turns with the head (about a 0.4 share of the yaw)", () => {
    spyWarn();
    const { root, bone } = rig();
    const a = createAnimator(root, { stand: still() }, { seed: "B" });
    feed(a, 3, [3, 1.75, 3]);   // +45 deg, settled
    const { yaw } = yawPitch(root, bone("neck"));
    expect(yaw).toBeGreaterThan(10);
    expect(yaw).toBeLessThan(26);
  });

  it("a target behind (150 deg) stops at the 60 deg yaw limit", () => {
    spyWarn();
    const { root, bone } = rig();
    const a = createAnimator(root, { stand: still() }, { seed: "B" });
    const back: [number, number, number] = [Math.sin(150 * D) * 3, 1.75, Math.cos(150 * D) * 3];
    feed(a, 3, back);
    const { yaw } = yawPitch(root, bone("head"));
    expect(Math.abs(yaw)).toBeGreaterThan(58);
    expect(Math.abs(yaw)).toBeLessThan(62);
  });

  it("pitch stops at 30 deg", () => {
    spyWarn();
    const { root, bone } = rig();
    const a = createAnimator(root, { stand: still() }, { seed: "B" });
    feed(a, 3, [0, 1.75 + 5, 0.5]);
    const { pitch } = yawPitch(root, bone("head"));
    expect(Math.abs(pitch)).toBeGreaterThan(28);
    expect(Math.abs(pitch)).toBeLessThan(32);
  });

  it("a new target 0.5 s after the last one is ignored", () => {
    spyWarn();
    const { root, bone } = rig();
    const a = createAnimator(root, { stand: still() }, { seed: "B" });
    feed(a, 0.5, [3, 1.75, 3]);    // +45 deg
    feed(a, 0.4, [-3, 1.75, 3]);   // -45 deg, 0.9 s after the first: too soon
    const { yaw } = yawPitch(root, bone("head"));
    expect(yaw).toBeGreaterThan(10);
    // after a full second it is accepted
    feed(a, 2, [-3, 1.75, 3]);
    expect(yawPitch(root, bone("head")).yaw).toBeLessThan(-35);
  });

  it("held gaze keeps the random glance within 2 deg", () => {
    spyWarn();
    const { root, bone } = rig();
    const a = createAnimator(root, { stand: still() }, { seed: "B" });
    const target: [number, number, number] = [0, 1.75, 3];
    feed(a, 3, target);
    const localYaw = (b: Bone): number => {
      const f = new Vector3(0, 0, 1).applyQuaternion(b.quaternion);
      return Math.atan2(f.x, f.z) / D;
    };
    const h = bone("head");
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < 5 * 30; i++) {
      a.update(1 / 30, { talking: false, look: target });
      const y = localYaw(h);
      mn = Math.min(mn, y);
      mx = Math.max(mx, y);
    }
    expect(mx - mn).toBeLessThan(4);
  });

  it("the random glance stays within 2 deg while the gaze is still settling", () => {
    spyWarn();
    const { root, bone } = rig();
    const a = createAnimator(root, { stand: still() }, { seed: "596" });
    const target: [number, number, number] = [0, 1.75, 3];  // straight ahead: any yaw is the random glance
    const localYaw = (b: Bone): number => {
      const f = new Vector3(0, 0, 1).applyQuaternion(b.quaternion);
      return Math.atan2(f.x, f.z) / D;
    };
    let worst = 0;
    for (let i = 0; i < 30; i++) {
      a.update(1 / 30, { talking: false, look: target });
      worst = Math.max(worst, Math.abs(localYaw(bone("neck")) + localYaw(bone("head"))));
    }
    expect(worst).toBeLessThan(2);
  });

  it("a held gaze keeps the head's world aim within 2 deg of the target (seed 596)", () => {
    const { root, bone } = rig();
    const life = createLife(root, "596")!;
    const target: [number, number, number] = [0, 1.75, 3];
    let worst = 0;
    for (let i = 0; i < 90; i++) {
      life.before();
      life.after(1 / 30, { weight: 1, talking: false, look: target });
      root.updateMatrixWorld(true);
      const h = bone("head");
      const f = new Vector3(0, 0, 1).applyQuaternion(h.getWorldQuaternion(new Quaternion()));
      const hp = h.getWorldPosition(new Vector3());
      const to = new Vector3(target[0] - hp.x, target[1] - hp.y, target[2] - hp.z).normalize();
      worst = Math.max(worst, (f.angleTo(to) * 180) / Math.PI);
    }
    expect(worst).toBeLessThan(2);
  });

  it("direct Life use without before() does not pile gaze offsets up", () => {
    // the animator always calls before() first; a direct user that forgets it
    // must still see no accumulation (contract: no pile-up)
    const { root, bone } = rig();
    const life = createLife(root, "596")!;
    const target: [number, number, number] = [0, 1.75, 3];
    for (let i = 0; i < 90; i++) {
      life.after(1 / 30, { weight: 1, talking: false, look: target });
      root.updateMatrixWorld(true);
    }
    const h = bone("head");
    const f = new Vector3(0, 0, 1).applyQuaternion(h.getWorldQuaternion(new Quaternion()));
    const hp = h.getWorldPosition(new Vector3());
    const to = new Vector3(target[0] - hp.x, target[1] - hp.y, target[2] - hp.z).normalize();
    expect((f.angleTo(to) * 180) / Math.PI).toBeLessThan(5);
  });

  it("a held gaze keeps the head's world aim within 1.2 deg of the target (seeds B, 596)", () => {
    // margin under the contract's 2 deg: the random glance stays small on every seed
    for (const seed of ["B", "596"]) {
      const { root, bone } = rig();
      const life = createLife(root, seed)!;
      const target: [number, number, number] = [0, 1.75, 3];
      let worst = 0;
      for (let i = 0; i < 90; i++) {
        life.before();
        life.after(1 / 30, { weight: 1, talking: false, look: target });
        root.updateMatrixWorld(true);
        const h = bone("head");
        const f = new Vector3(0, 0, 1).applyQuaternion(h.getWorldQuaternion(new Quaternion()));
        const hp = h.getWorldPosition(new Vector3());
        const to = new Vector3(target[0] - hp.x, target[1] - hp.y, target[2] - hp.z).normalize();
        worst = Math.max(worst, (f.angleTo(to) * 180) / Math.PI);
      }
      expect(worst).toBeLessThan(1.2);
    }
  });

  it("5 minutes of changing targets: no accumulation", () => {
    spyWarn();
    const { root, bone } = rig();
    const rest = bone("head").quaternion.clone();
    const a = createAnimator(root, { stand: still() }, { seed: "B" });
    let worst = 0;
    for (let i = 0; i < 300 * 30; i++) {
      const k = Math.floor(i / 45) % 4;
      const tg: [number, number, number][] = [[3, 1.75, 3], [-3, 1.75, 1], [0, 1.75, -3], [0, 4, 1]];
      a.update(1 / 30, { talking: i % 90 < 30, look: tg[k] });
      if (i % 15 === 0) worst = Math.max(worst, deg(rest, bone("head").quaternion));
    }
    expect(worst).toBeLessThan(75);
  });

  it("no look eases the gaze back to the body's front", () => {
    spyWarn();
    const { root, bone } = rig();
    const a = createAnimator(root, { stand: still() }, { seed: "B" });
    const side: [number, number, number] = [3, 1.75, 3];
    feed(a, 2, side);
    expect(toward(root, bone("head"), side)).toBeLessThan(8);
    feed(a, 2);   // silence: no look -> the head lets go of the target
    expect(toward(root, bone("head"), side)).toBeGreaterThan(25);
    expect(Math.abs(yawPitch(root, bone("head")).yaw)).toBeLessThan(12);
  });

  it("life: false ignores look", () => {
    spyWarn();
    const { root, bone } = rig();
    const a = createAnimator(root, { stand: still() }, { life: false });
    const h0 = bone("head").quaternion.clone();
    feed(a, 2, [3, 1.75, 3]);
    expect(deg(h0, bone("head").quaternion)).toBeLessThan(1e-6);
  });
});

// stage gaze routing: who looks at whom (the decision behind the per-frame gaze; life.ts only turns the head)
describe("stage gaze routing (who looks at whom)", () => {
  const pp = (p: Place): [number, number, number] => [p.at[0], 1.4, p.at[1]];
  const actor = (who: string, x: number, room: string | null = "living"): GazeActor => ({ who, room, pos: [x, 0], eye: [x, 1.6, 0] });
  const bed: Place = { name: "bed", id: "b", kind: "sit", room: "living", level: "L0", at: [2, 3], yaw: 0, look: null, obstacle: null };

  it("the speaker looks at the actor named by the look bit", () => {
    const A = actor("A", 0), B = actor("B", 3);
    expect(resolveGaze({ speaker: "A", at: "B", place: null, until: 10 }, 0, A, [A, B], pp)).toEqual(B.eye);
  });

  it("the speaker without a look bit looks at the nearest other actor", () => {
    const A = actor("A", 0), B = actor("B", 5), C = actor("C", 1);
    expect(resolveGaze({ speaker: "A", at: null, place: null, until: 10 }, 0, A, [A, B, C], pp)).toEqual(C.eye);
  });

  it("the speaker's look bit naming a place looks at the place", () => {
    const A = actor("A", 0);
    expect(resolveGaze({ speaker: "A", at: "bed", place: bed, until: 10 }, 0, A, [A], pp)).toEqual([2, 1.4, 3]);
  });

  it("listeners look at the speaker", () => {
    const A = actor("A", 0), B = actor("B", 3);
    expect(resolveGaze({ speaker: "A", at: null, place: null, until: 10 }, 0, B, [A, B], pp)).toEqual(A.eye);
  });

  it("a listener in another room looks at nothing", () => {
    const A = actor("A", 0, "living"), B = actor("B", 3, "kitchen");
    expect(resolveGaze({ speaker: "A", at: null, place: null, until: 10 }, 0, B, [A, B], pp)).toBeNull();
  });

  it("a narration turns the cast to each other", () => {
    const A = actor("A", 0), B = actor("B", 3);
    expect(resolveGaze({ speaker: null, at: null, place: null, until: 10 }, 0, B, [A, B], pp)).toEqual(A.eye);
  });

  it("a narration about a place turns the cast to it", () => {
    const A = actor("A", 0), B = actor("B", 3);
    expect(resolveGaze({ speaker: null, at: null, place: bed, until: 10 }, 0, B, [A, B], pp)).toEqual([2, 1.4, 3]);
  });

  it("4 s of silence after the beat looks at nothing", () => {
    const A = actor("A", 0), B = actor("B", 3);
    expect(resolveGaze({ speaker: "A", at: null, place: null, until: 10 }, 11, B, [A, B], pp)).toBeNull();
  });

  it("a place on an upper level aims at eye height above that floor", () => {
    const loft: Place = { ...bed, level: "L1" };
    const g = placeGazePoint(loft, 3);
    expect(g[0]).toBe(2);
    expect(g[2]).toBe(3);
    expect(g[1]).toBeCloseTo(4.4, 10);
    const down = placeGazePoint(bed, 0);
    expect(down[1]).toBeCloseTo(1.4, 10);
  });

  it("a place with no floor given aims at eye height above the ground floor", () => {
    expect(placeGazePoint(bed)[1]).toBeCloseTo(1.4, 10);
  });
});
