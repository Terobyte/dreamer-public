import { Quaternion, Vector3, type Object3D } from "three";

/** Procedural idle for any humanoid rig: breath in the chest, weight shift in the spine, the head looking
 *  around, nods while talking. Koshakan (Nov 1): anymove gives verbs, never an idle, so between verbs the
 *  cast stood as a still frame. The layer rides on top of whatever the mixer wrote and is undone before the
 *  next mixer update, so it never accumulates, also on bones no clip animates. Arms and pelvis are left
 *  alone: feet stay planted and a held pose stays held. */
export interface Life {
  /** undo the last offsets (call before mixer.update) */
  before(): void;
  /** lay new offsets; weight 0..1 scales breath/look, talking adds nods. `look` = a world point (the target's
   *  head): head and neck turn to it (yaw <= 60, pitch <= 30 deg, tau 0.3 s, a new target no sooner than 1 s
   *  after the last), a small random glance stays on top. No `look` = the gaze eases back to the body's front. */
  after(dt: number, o: { weight: number; talking: boolean; look?: [number, number, number] }): void;
}

// per joint, candidate names in priority order (a rig with spine1/spine2/chest breathes in "chest", not spine2)
const PICK: Record<string, string[]> = {
  spine: ["spine1", "spine_01", "spine01", "spine"],
  chest: ["chest", "upperchest", "upper_chest", "spine2", "spine_02", "spine02"],
  neck: ["neck", "neck1", "neck_01"],
  head: ["head"],
};

const hash = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

export function createLife(root: Object3D, seed = ""): Life | null {
  const byName = new Map<string, Object3D>();
  root.traverse((o) => {
    const n = o.name.toLowerCase();
    if (n && !byName.has(n)) byName.set(n, o);
  });
  const bones: Record<string, Object3D | undefined> = {};
  for (const [k, names] of Object.entries(PICK)) bones[k] = names.map((n) => byName.get(n)).find(Boolean);
  if (!bones.head && !bones.chest) return null;
  // phases from the seed: two actors never breathe in lockstep
  let h = hash(seed || "actor");
  const ph = Array.from({ length: 8 }, () => ((h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0), (h / 4294967296) * Math.PI * 2));
  const rate = 0.85 + (hash(seed + "rate") % 1000) / 1000 * 0.3;  // 0.85..1.15 tempo

  const applied = new Map<Object3D, Quaternion>();
  const R = new Vector3(), U = new Vector3(), F = new Vector3();
  const rootQ = new Quaternion(), boneQ = new Quaternion(), d = new Quaternion(), step = new Quaternion(), ax = new Vector3();
  let t = 0, w = 0, tw = 0;
  // gaze: held target (world point), smoothed angles, gaze strength
  const GAZE_YAW = 60, GAZE_PITCH = 30, TAU = 0.3, HOLD = 1, SAME = 0.25;
  const tgt = new Vector3(), want = new Vector3(), dir = new Vector3(), hp = new Vector3();
  let hasTgt = false, tgtAt = -Infinity, gy = 0, gp = 0, gz = 0;
  const D = Math.PI / 180;
  const S = (period: number, p: number): number => Math.sin((2 * Math.PI * t * rate) / period + p);

  const lay = (b: Object3D | undefined, pitch: number, yaw: number, roll: number): void => {
    if (!b || (!pitch && !yaw && !roll)) return;
    b.getWorldQuaternion(boneQ).invert();
    d.identity();
    for (const [axis, a] of [[R, pitch], [U, yaw], [F, roll]] as Array<[Vector3, number]>) {
      if (!a) continue;
      ax.copy(axis).applyQuaternion(boneQ).normalize();  // world axis -> bone local: the same turn on any rig
      d.multiply(step.setFromAxisAngle(ax, a * D));
    }
    b.quaternion.multiply(d);
    applied.set(b, d.clone());
  };

  return {
    before() {
      for (const [b, q] of applied) b.quaternion.multiply(q.invert());
      applied.clear();
    },
    after(dt, o) {
      // safety: undo offsets a previous after() left behind. The animator always calls
      // before() first, so this is a no-op there; direct users that skip before() would
      // pile the gaze up frame over frame — with this they see no pile-up either.
      for (const [b, q] of applied) b.quaternion.multiply(q.invert());
      applied.clear();
      t += dt;
      const k = Math.min(1, dt * 3);
      w += (o.weight - w) * k;
      tw += ((o.talking ? 1 : 0) - tw) * Math.min(1, dt * 6);
      root.getWorldQuaternion(rootQ);
      R.set(1, 0, 0).applyQuaternion(rootQ);
      U.set(0, 1, 0).applyQuaternion(rootQ);
      F.set(0, 0, 1).applyQuaternion(rootQ);
      // gaze target: a point far from the held one is a new target and waits out the 1 s hold; a near one is the same head moving
      if (o.look) {
        want.set(o.look[0], o.look[1], o.look[2]);
        if (!hasTgt) { tgt.copy(want); hasTgt = true; tgtAt = t; }
        else if (want.distanceTo(tgt) < SAME) tgt.copy(want);
        else if (t - tgtAt >= HOLD) { tgt.copy(want); tgtAt = t; }
      } else hasTgt = false;
      let wy = 0, wp = 0, wz = 0;
      const eye = bones.head ?? bones.neck ?? bones.chest;
      if (hasTgt && eye) {
        eye.getWorldPosition(hp);
        dir.copy(tgt).sub(hp);
        if (dir.length() > 1e-3) {
          dir.normalize();
          wy = Math.max(-GAZE_YAW, Math.min(GAZE_YAW, Math.atan2(dir.dot(R), dir.dot(F)) / D));
          wp = -Math.max(-GAZE_PITCH, Math.min(GAZE_PITCH, Math.asin(Math.max(-1, Math.min(1, dir.dot(U)))) / D));
          wz = 1;
        }
      }
      const kg = 1 - Math.exp(-dt / TAU);
      gy += (wy - gy) * kg;
      gp += (wp - gp) * kg;
      gz = wz;  // the glance drops the very first frame a target locks — no ramp, never above 2 deg
      const glance = 1 - 0.95 * gz;  // held gaze: residual random glance at most ~0.4 deg
      const breath = S(4.2, ph[0]);
      const look = 0.6 * S(9.1, ph[1]) + 0.4 * S(5.3, ph[2]);
      const nod = Math.sin(2 * Math.PI * t * 2.1 + ph[6]) * (0.6 + 0.4 * Math.sin(2 * Math.PI * t * 0.37 + ph[7]));
      // parent first: each child reads the world turn its parent was just given.
      // a held gaze damps the torso sway that would move the head, not just the neck/head glance:
      // the head's world aim must stay within 2 deg of the target, not only its local joints
      lay(bones.spine, 0, glance * w * 1.6 * S(11, ph[3]), glance * w * 1.3 * S(7.3, ph[4]));
      lay(bones.chest, glance * w * 1.5 * breath + tw * 0.8 * nod, 0, 0);
      lay(bones.neck, glance * w * -0.6 * breath + gp * 0.4, glance * w * 2 * look + gy * 0.4, 0);
      lay(bones.head, glance * w * 2.2 * S(6.7, ph[5]) + tw * 4.5 * nod + gp * 0.6, glance * (w * 6 * look + tw * 2.5 * Math.sin(2 * Math.PI * t * 1.3 + ph[2])) + gy * 0.6, glance * w * 1.2 * S(8.3, ph[0]));
    },
  };
}
