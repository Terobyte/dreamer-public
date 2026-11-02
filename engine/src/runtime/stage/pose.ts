import { Quaternion, Vector3, type Object3D } from "three";

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
  if (/^l/.test(n) || /l$/.test(n)) return "L";
  if (/^r/.test(n) || /r$/.test(n)) return "R";
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
 * the seat height stays the caller's (`SIT_DROP`). Returns the undo (call it before the next mixer update, like
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
