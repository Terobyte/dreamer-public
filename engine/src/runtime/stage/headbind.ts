/**
 * Generated rigs (Tripo + auto-rig) sometimes bind part of the face to the neck: Koshakan Mama's mouth cavity
 * was 100 % neck, so it stayed behind when the head turned and showed on her cheek as a red strip (Nov 2).
 * Rule: a vertex lying above the head joint (along neck -> head) that is mostly on the neck belongs to the head.
 */
import { Matrix4, SkinnedMesh, Vector3, type Object3D } from "three";

const NECK = ["neck", "neck1", "neck_01"];
const HEAD = ["head"];
/** "above the head joint" = past it by this share of the neck -> head length (the jaw line itself blends) */
const ABOVE_SHARE = 0.2;

/** -> how many vertices moved to the head, over every skinned mesh under `root` */
export function bindHeadToHead(root: Object3D): number {
  let moved = 0;
  root.traverse((o) => {
    if (!(o instanceof SkinnedMesh) || !o.skeleton) return;
    const names = o.skeleton.bones.map((b) => b.name.toLowerCase());
    const pick = (cands: string[]): number => cands.map((c) => names.indexOf(c)).find((i) => i >= 0) ?? -1;
    const ni = pick(NECK);
    const hi = pick(HEAD);
    if (ni < 0 || hi < 0) return;
    const at = (k: number): Vector3 => new Vector3().setFromMatrixPosition(new Matrix4().copy(o.skeleton.boneInverses[k]!).invert());
    const neck = at(ni);
    const head = at(hi);
    const up = head.clone().sub(neck);
    const len = up.length();
    if (!(len > 1e-6)) return;
    up.divideScalar(len);
    const g = o.geometry;
    const P = g.attributes.position;
    const J = g.attributes.skinIndex;
    const W = g.attributes.skinWeight;
    if (!P || !J || !W) return;
    const v = new Vector3();
    let here = 0;
    for (let i = 0; i < P.count; i++) {
      let wn = 0;
      for (let k = 0; k < 4; k++) if (J.getComponent(i, k) === ni) wn += W.getComponent(i, k);
      if (wn < 0.5) continue;
      v.fromBufferAttribute(P, i).applyMatrix4(o.bindMatrix);
      if (v.sub(head).dot(up) < ABOVE_SHARE * len) continue;
      J.setXYZW(i, hi, 0, 0, 0);
      W.setXYZW(i, 1, 0, 0, 0);
      here++;
    }
    if (here) {
      J.needsUpdate = true;
      W.needsUpdate = true;
      moved += here;
    }
  });
  return moved;
}
