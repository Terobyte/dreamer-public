import { Quaternion, Vector3, type Object3D, type SkinnedMesh } from "three";

// Н9 (раунд 6 прогона worlds-a, перенесено 11-02): сидя бедро вперёд 85°, колено 85°, голень висит вниз.

const D = Math.PI / 180;
export const SIT_HIP = 85;
export const SIT_KNEE = 85;

// bone name patterns on a letters-only lower-case name; one bone per side wins by the priority order
const THIGH = /(upleg|upperleg|thigh)/;
const KNEE = /(knee|calf|shin|lowerleg|(left|right|^l|^r)leg$|^leg(l|r|left|right)$)/;
const THIGH_PRI = ["thigh", "upperleg", "upleg"];
const KNEE_PRI = ["knee", "shin", "calf", "lowerleg", "leg"];
const key = (n: string): string => n.toLowerCase().replace(/[^a-z]/g, "");

const sideOf = (n: string): string => {
  if (n.includes("left")) return "L";
  if (n.includes("right")) return "R";
  // a trailing side marker (`lowerleg_r` -> `lowerlegr`) wins; a leading l/r counts only before a limb word
  // (`lknee`), never as the first letter of `lowerleg` / `leg`
  const LIMB = "(?:leg|knee|thigh|calf|shin|upleg|upperleg|lowerleg)";
  if (new RegExp(`${LIMB}l$`).test(n) || new RegExp(`^l${LIMB}`).test(n)) return "L";
  if (new RegExp(`${LIMB}r$`).test(n) || new RegExp(`^r${LIMB}`).test(n)) return "R";
  return "mid";
};
const priOf = (n: string, pri: string[]): number => {
  const i = pri.findIndex((p) => n.includes(p));
  return i < 0 ? 999 : i;
};

/** one thigh and one knee per side (a rig with both `leftupleg` and `leftthigh` bends a single bone, or the chain folds twice) */
export function findLegs(root: Object3D): { thighs: Object3D[]; knees: Object3D[] } {
  const thighC: Array<{ o: Object3D; side: string; pri: number }> = [];
  const kneeC: Array<{ o: Object3D; side: string; pri: number }> = [];
  root.traverse((o) => {
    const n = key(o.name);
    if (!n || /twist|foot|toe/.test(n)) return;
    if (THIGH.test(n)) thighC.push({ o, side: sideOf(n), pri: priOf(n, THIGH_PRI) });
    else if (KNEE.test(n)) kneeC.push({ o, side: sideOf(n), pri: priOf(n, KNEE_PRI) });
  });
  const best = (cs: typeof thighC): Object3D[] => {
    const m = new Map<string, { o: Object3D; pri: number }>();
    for (const c of cs) {
      const b = m.get(c.side);
      if (!b || c.pri < b.pri) m.set(c.side, { o: c.o, pri: c.pri });
    }
    return [...m.values()].map((c) => c.o);
  };
  return { thighs: best(thighC), knees: best(kneeC) };
}

/** turn `bone` by `deg` about a world axis */
function bend(bone: Object3D, axis: Vector3, deg: number): void {
  const inv = bone.getWorldQuaternion(new Quaternion()).invert();
  bone.quaternion.multiply(new Quaternion().setFromAxisAngle(axis.clone().applyQuaternion(inv).normalize(), deg * D));
}

/**
 * Sitting legs on top of whatever the bones hold now (rest or the mixer's frame): each thigh forward by SIT_HIP
 * about the root's right axis, then each knee by SIT_KNEE, so the shin hangs down. The pelvis does not move:
 * the seat height stays the caller's (`sitDrop`). Returns the undo (call it before the next mixer update, like
 * `applyNod`); null when the rig has no thigh or no knee bone (a box, a rigid mesh): nothing is bent.
 */
export function sitLegs(root: Object3D): (() => void) | null {
  const { thighs, knees } = findLegs(root);
  if (!thighs.length || !knees.length) return null;
  const bones = [...thighs, ...knees];
  const saved = bones.map((b) => b.quaternion.clone());
  root.updateMatrixWorld(true);
  const right = new Vector3(1, 0, 0).applyQuaternion(root.getWorldQuaternion(new Quaternion())).normalize();
  for (const t of thighs) bend(t, right, -SIT_HIP);
  root.updateMatrixWorld(true);
  for (const k of knees) bend(k, right, SIT_KNEE);
  root.updateMatrixWorld(true);
  return () => bones.forEach((b, k) => b.quaternion.copy(saved[k]!));
}

/** standing leg measures of a rig (L154), taken once at load */
export interface LegHeights {
  /** hip joints (mean world y of the thigh bones) above the feet */
  pelvis: number;
  /** knee -> ankle (the knee bone to its foot/first child bone), mean of the sides */
  shin: number;
  /** the bottom of the body between the legs above the knees (the crotch: what lands on a seat), from the skin;
   *  absent without a skinned mesh there (the hip joints sit then) */
  seat?: number;
}

/** lowest skin point above `aboveY` in the strip between the thighs (within 30% of half their spacing of the middle) */
function crotchY(root: Object3D, thighs: Object3D[], aboveY: number): number | undefined {
  if (thighs.length < 2) return undefined;
  const tp = thighs.slice(0, 2).map((t) => t.getWorldPosition(new Vector3()));
  const mid = tp[0]!.clone().add(tp[1]!).multiplyScalar(0.5);
  const ax = tp[1]!.clone().sub(tp[0]!).setY(0);
  const half = ax.length() / 2;
  if (half < 1e-4) return undefined;
  ax.normalize();
  let low = Infinity;
  const v = new Vector3();
  root.traverse((o) => {
    if (!(o as { isSkinnedMesh?: boolean }).isSkinnedMesh) return;
    const m = o as SkinnedMesh;
    const pos = m.geometry.attributes.position;
    if (!pos) return;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      m.applyBoneTransform(i, v);
      v.applyMatrix4(m.matrixWorld);
      if (v.y <= aboveY || v.y >= low) continue;
      if (Math.abs((v.x - mid.x) * ax.x + (v.z - mid.z) * ax.z) < half * 0.3) low = v.y;
    }
  });
  return Number.isFinite(low) ? low : undefined;
}

/**
 * Hip-joint height above `feetY` and shin length of `root` as it stands now (world metres, so call it on the
 * scaled body in its standing pose). null when the rig has no thigh or no knee bone (a box): `sitDrop` then
 * falls back to the height.
 */
export function legHeights(root: Object3D, feetY = 0): LegHeights | null {
  const { thighs, knees } = findLegs(root);
  if (!thighs.length || !knees.length) return null;
  root.updateMatrixWorld(true);
  const wp = (o: Object3D): Vector3 => o.getWorldPosition(new Vector3());
  const pelvis = thighs.reduce((s, t) => s + wp(t).y, 0) / thighs.length - feetY;
  const shinOf = (k: Object3D): number => {
    const kids = k.children.filter((c) => (c as { isBone?: boolean }).isBone || c.name);
    const ankle = kids.find((c) => /foot|ankle/.test(key(c.name))) ?? kids[0];
    return ankle ? wp(k).distanceTo(wp(ankle)) : wp(k).y - feetY;
  };
  const shin = knees.reduce((s, k) => s + shinOf(k), 0) / knees.length;
  if (!(pelvis > 0 && shin > 0)) return null;
  const kneeY = knees.reduce((s, k) => s + wp(k).y, 0) / knees.length;
  const c = crotchY(root, thighs, kneeY);
  // a skin point under the hips by more than a hand is not the seat (a skirt, a tail): the hip joints sit then
  const seat = c !== undefined && c - feetY < pelvis && pelvis - (c - feetY) < 0.15 * (pelvis + shin) ? c - feetY : undefined;
  return seat !== undefined ? { pelvis, shin, seat } : { pelvis, shin };
}

/**
 * How far a seated actor's feet go down (L154): standing height of the body's bottom between the legs (`seat`,
 * else the hip joints) − seat height, so the body lands on the seat (Squidward v8: SpongeBob's pants sank 7 cm). Seat = the place's `top` (metres above the actor's level) if set, else the shin (thigh level, shin
 * hanging down). A rig without legs (a box stand-in) keeps the old 0.45 m scaled by height (0.45 at 1.7 m).
 * Negative = a seat above the hips (a child on a high bed): the actor is lifted onto it.
 */
export function sitDrop(legs: LegHeights | null, heightM: number, top?: number): number {
  if (!legs) return (0.45 * heightM) / 1.7;
  const seat = typeof top === "number" && Number.isFinite(top) ? top : legs.shin;
  return (legs.seat ?? legs.pelvis) - seat;
}
