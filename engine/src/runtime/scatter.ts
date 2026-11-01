/**
 * `scatter` on the page: one InstancedMesh per asset, never one mesh per copy
 * (170 copies × 20 000 triangles would be 3.4 M). The node tests call this
 * without WebGL; a loaded GLB's meshes come in through `sources`.
 */
import { BoxGeometry, BufferGeometry, Group, InstancedMesh, Material, Matrix4, MeshStandardMaterial, Object3D } from "three";

export interface ScatterEntryJson {
  i: number;
  asset: string;
  glb: string | null;
  count: number;
  transforms: number[][];
}

export interface ScatterSource {
  geometry: BufferGeometry;
  material: Material | Material[];
}

/**
 * GLB meshes carry the normalizer's centring/bottom matrix on their parents
 * (F10): bake each mesh's world matrix into a geometry clone, so instances
 * keep the centred, bottom-at-y=0 shape. The source geometry is untouched.
 */
export function toSources(
  parts: { geometry: BufferGeometry; material: Material | Material[]; matrixWorld: Matrix4 }[],
): ScatterSource[] {
  return parts.map((p) => ({ geometry: p.geometry.clone().applyMatrix4(p.matrixWorld), material: p.material }));
}

export function scatterObjects(entries: ScatterEntryJson[], sources: Map<string, ScatterSource[]> = new Map()): Group {
  const group = new Group();
  group.name = "scatter";
  const dummy = new Object3D();
  for (const e of entries) {
    // no model yet: a unit box standing on y = 0, scaled by the copy's height
    const parts = sources.get(e.asset) ?? [{ geometry: new BoxGeometry(1, 1, 1).translate(0, 0.5, 0), material: new MeshStandardMaterial({ color: "#6b7f4a" }) }];
    for (const part of parts) {
      const mesh = new InstancedMesh(part.geometry, part.material, e.count);
      mesh.name = `scatter:${e.i}:${e.asset}`;
      e.transforms.slice(0, e.count).forEach((t, k) => {
        dummy.position.set(t[0], t[1], t[2]);
        dummy.rotation.set(0, t[3], 0);
        dummy.scale.setScalar(t[4]);
        dummy.updateMatrix();
        mesh.setMatrixAt(k, dummy.matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
      group.add(mesh);
    }
  }
  return group;
}
