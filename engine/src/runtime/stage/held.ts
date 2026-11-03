import { Box3, Euler, Quaternion, Vector3, type Object3D } from "three";

/** One held object of a cast member (cast.json `held.<clip>`): `glb` from the cast folder, on `bone`, its longest
 *  side `size_m` metres; `at` (m) and `rot` (deg, xyz) place the grip in the bone's frame. */
export interface HeldSpec {
  glb: string;
  bone: string;
  size_m: number;
  at?: [number, number, number];
  rot?: [number, number, number];
}

/** Hang each object on its bone (bone names match case-blind) and show only the one of the clip playing now.
 *  Call after the body is scaled to its height: the size is in world metres whatever the rig's scale. A bone the
 *  rig lacks is a warning and the object is left out (Squidward's brush, Nov 3). */
export function attachHeld(
  body: Object3D,
  items: Record<string, Omit<HeldSpec, "glb"> & { obj: Object3D }>,
): { show(clip: string): void; warnings: string[] } {
  const bones = new Map<string, Object3D>();
  body.traverse((o) => {
    const n = o.name.toLowerCase();
    if (n && !bones.has(n)) bones.set(n, o);
  });
  body.updateWorldMatrix(true, true);
  const warnings: string[] = [];
  const shown = new Map<string, Object3D>();
  for (const [clip, it] of Object.entries(items)) {
    const bone = bones.get(it.bone.toLowerCase());
    if (!bone) {
      warnings.push(`held "${clip}": no bone "${it.bone}" in the rig`);
      continue;
    }
    const size = new Box3().setFromObject(it.obj).getSize(new Vector3());
    const long = Math.max(size.x, size.y, size.z) || 1;
    const bs = bone.getWorldScale(new Vector3()).x || 1;
    it.obj.scale.setScalar(it.size_m / long / bs);
    if (it.at) it.obj.position.set(it.at[0] / bs, it.at[1] / bs, it.at[2] / bs);
    if (it.rot) it.obj.quaternion.copy(new Quaternion().setFromEuler(new Euler(...it.rot.map((d) => (d * Math.PI) / 180) as [number, number, number])));
    it.obj.visible = false;
    bone.add(it.obj);
    shown.set(clip, it.obj);
  }
  return {
    warnings,
    show(clip) {
      for (const [c, o] of shown) o.visible = c === clip;
    },
  };
}
