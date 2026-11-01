import { describe, it, expect } from "vitest";
import { BoxGeometry, InstancedMesh, Matrix4, MeshStandardMaterial } from "three";
import { scatterObjects, toSources } from "../src/runtime/scatter.js";

describe("scatter runtime", () => {
  it("test_scatter_instanced_mesh", () => {
    const transforms = Array.from({ length: 200 }, (_, i) => [i * 0.9, 0, 0, 0.1 * i, 0.4]);
    const group = scatterObjects([{ i: 0, asset: "tuft", glb: null, count: 200, transforms }]);
    const meshes: any[] = [];
    group.traverse((o: any) => o.isMesh && meshes.push(o));
    expect(meshes.length).toBe(1);
    expect(meshes[0]).toBeInstanceOf(InstancedMesh);
    expect(meshes[0].count).toBe(200);
  });

  it("test_scatter_sources_bake_node_matrices", () => {
    const geo = new BoxGeometry(2, 2, 2);
    const mat = new MeshStandardMaterial({ color: "#fff" });
    const [src] = toSources([{ geometry: geo, material: mat, matrixWorld: new Matrix4().makeTranslation(0, 5, 0) }]);
    src.geometry.computeBoundingBox();
    expect(src.geometry.boundingBox!.min.y).toBeCloseTo(4, 6);
    expect(src.geometry.boundingBox!.max.y).toBeCloseTo(6, 6);
    geo.computeBoundingBox();
    expect(geo.boundingBox!.min.y).toBe(-1);
  });
});
