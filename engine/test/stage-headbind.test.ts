/**
 * A generated rig can bind part of the face to the neck: Koshakan Mama's mouth cavity (78 vertices, 100 % neck)
 * stayed put when the head turned and showed as a red strip on her cheek (Nov 2, "артефакты ртом").
 * bindHeadToHead moves such vertices — above the head joint, mostly on the neck — onto the head.
 */
import { describe, it, expect } from "vitest";
import { Bone, BufferGeometry, Float32BufferAttribute, MeshBasicMaterial, Skeleton, SkinnedMesh, Uint16BufferAttribute, Vector3 } from "three";
import { bindHeadToHead } from "../src/runtime/stage/headbind.js";

/** neck joint at y 1.5, head joint at y 1.6; vertices: [y, bone index (0 neck, 1 head)] */
function rig(verts: Array<[number, number]>) {
  const neck = new Bone();
  neck.name = "neck";
  neck.position.set(0, 1.5, 0);
  const head = new Bone();
  head.name = "Head";
  head.position.set(0, 0.1, 0);
  neck.add(head);
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(verts.flatMap(([y]) => [0, y, 0.1]), 3));
  g.setAttribute("skinIndex", new Uint16BufferAttribute(verts.flatMap(([, b]) => [b, 0, 0, 0]), 4));
  g.setAttribute("skinWeight", new Float32BufferAttribute(verts.flatMap(() => [1, 0, 0, 0]), 4));
  const mesh = new SkinnedMesh(g, new MeshBasicMaterial());
  mesh.add(neck);
  mesh.updateMatrixWorld(true);
  mesh.bind(new Skeleton([neck, head]));
  return { mesh, neck, head };
}
const boneOf = (m: SkinnedMesh, i: number): number => m.geometry.attributes.skinIndex!.getX(i);

describe("bindHeadToHead: the face follows the head", () => {
  it("a vertex above the head joint bound to the neck is rebound to the head; neck skin below stays", () => {
    const { mesh } = rig([[1.66, 0], [1.55, 0], [1.7, 1]]);
    expect(bindHeadToHead(mesh)).toBe(1);
    expect(boneOf(mesh, 0)).toBe(1);
    expect(mesh.geometry.attributes.skinWeight!.getX(0)).toBe(1);
    expect(boneOf(mesh, 1)).toBe(0);
    expect(boneOf(mesh, 2)).toBe(1);
  });

  it("after the fix the mouth turns with the head", () => {
    const { mesh, head } = rig([[1.66, 0]]);
    bindHeadToHead(mesh);
    head.rotation.z = Math.PI / 2;
    mesh.updateMatrixWorld(true);
    const v = new Vector3(0, 1.66, 0.1);
    mesh.applyBoneTransform(0, v);
    expect(v.y).toBeLessThan(1.62); // swung down with the head, not left at 1.66
  });

  it("a rig with no neck or no head is left alone", () => {
    const { mesh, neck } = rig([[1.66, 0]]);
    neck.name = "spine";
    expect(bindHeadToHead(mesh)).toBe(0);
    expect(boneOf(mesh, 0)).toBe(0);
  });
});
