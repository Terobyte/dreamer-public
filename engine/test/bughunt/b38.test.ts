import { describe, it, expect } from "vitest";
import { fixtureMeshes } from "../../src/build/fixtures.js";

const outline = [[0, -0.01], [4, -0.01], [4, 3], [0, 3]];

function backNormals(from: number[], to: number[]): number[][] {
  const room = { id: "r", level: "L0", outline };
  const ctx: any = {
    scene: { levels: [{ id: "L0", y: 0 }], fixtures: [{ room: "r", kind: "counter", material: "m", from, to }] },
    rooms: [room],
    passport: {},
  };
  const body = fixtureMeshes(ctx)[0];
  const out: number[][] = [];
  for (let i = 0; i < body.positions.length / 3; i++) {
    const z = body.positions[i * 3 + 2];
    const n = [body.normals[i * 3], body.normals[i * 3 + 1], body.normals[i * 3 + 2]];
    if (Math.abs(z) < 1e-9 && Math.abs(n[1]) < 0.5 && Math.abs(n[2]) > 0.5) out.push(n.map((v) => Math.round(v * 1e6) / 1e6 + 0));
  }
  return out;
}

describe("B38: fixture side normals depend on from/to order", () => {
  it("back face (z=0) points to -Z for both from/to orders", () => {
    const a = backNormals([0, 0], [4, 0]);
    const b = backNormals([4, 0], [0, 0]);
    expect(a.length).toBeGreaterThan(0);
    expect(a.every((n) => n[2] === -1)).toBe(true);
    expect(b.length).toBeGreaterThan(0);
    expect(b[0]).toEqual([0, 0, -1]);
    expect(b.every((n) => n[2] === -1)).toBe(true);
  });
});
