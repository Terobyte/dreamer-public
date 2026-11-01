import { describe, expect, it } from "vitest";
import { budgetIssues } from "../src/budget.js";
import { writeGlb } from "../src/assets/glb.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Same GLB shape budget.test.ts uses: one primitive, `count` POSITION vertices, mode 4 (triangles). */
const trisGlb = (count: number): Buffer =>
  writeGlb(
    {
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } } as never] }],
      accessors: [{ bufferView: 0, componentType: 5126, count, type: "VEC3" }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 0 }],
      buffers: [{ byteLength: 0 }],
    },
    null,
  );

const dirWith = (files: Record<string, Buffer | string>): string => {
  const d = mkdtempSync(join(tmpdir(), "bugs-budget-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(d, name), body);
  return d;
};

const square = (x0: number): [number, number][] => [
  [x0, 0],
  [x0 + 2, 0],
  [x0 + 2, 2],
  [x0, 2],
];

/** `rooms` rooms side by side on level L0, each 2x2 m, 3 m high. */
const roomsCtx = (rooms: number, lightsByRoom: number[]) => {
  const ctxRooms = Array.from({ length: rooms }, (_, r) => ({
    id: `r${r}`,
    level: "L0",
    height: 3,
    outline: square(r * 3),
  }));
  const lights: unknown[] = [];
  lightsByRoom.forEach((n, r) => {
    for (let k = 0; k < n; k++) lights.push({ kind: "point", pos: [r * 3 + 0.5 + k * 0.2, 1.5, 1] });
  });
  return {
    scene: { props: [], levels: [{ id: "L0", y: 0 }], lights, rooms: ctxRooms },
    rooms: ctxRooms,
    passport: {},
  } as any;
};

describe("B20 unreadable glb must not count as 0 triangles", () => {
  it("B20 missing glb file is not a silent 0 in by_prop", async () => {
    // expected: the prop is unknown (absent) or flagged, never a silent 0 that passes TRI budgets
    const { countTris } = (await import("../src/build/write.js")) as any;
    const d = dirWith({});
    const geo = { meshes: [{ kind: "prop", id: "chair", glb: "missing.glb", indices: [] }] } as any;
    const tris = countTris(geo, d, ["chair"]);
    expect(tris.by_prop["chair"]).not.toBe(0);
  });

  it("B20 corrupt glb bytes are not a silent 0 in by_prop", async () => {
    const { countTris } = (await import("../src/build/write.js")) as any;
    const d = dirWith({ "bad.glb": "this is not a glb" });
    const geo = { meshes: [{ kind: "prop", id: "chair", glb: "bad.glb", indices: [] }] } as any;
    const tris = countTris(geo, d, ["chair"]);
    expect(tris.by_prop["chair"]).not.toBe(0);
  });

  it("B20 sanity: a readable glb still counts its triangles", async () => {
    const { countTris } = (await import("../src/build/write.js")) as any;
    const d = dirWith({ "ok.glb": trisGlb(6000) });
    const geo = { meshes: [{ kind: "prop", id: "chair", glb: "ok.glb", indices: [] }] } as any;
    expect(countTris(geo, d, ["chair"]).by_prop["chair"]).toBe(2000);
  });

  it("B20 F1: unreadable glb blocks check with an error, not a warn", async () => {
    const { runCheck } = (await import("../src/check.js")) as any;
    const { demoFlat } = (await import("./helpers/scene.js")) as any;
    const { report } = runCheck(demoFlat(), { tris: { total: 0, by_prop: {}, unreadable: ["chairs"] } });
    expect(report.errors.map((i: any) => i.code)).toContain("TRI_PROP_BUDGET");
    expect(report.ok).toBe(false);
  });
});

describe("B21 point-light budget applies scene-wide and per room with error level", () => {
  const lightIssues = (issues: any[]) => issues.filter((i) => i.code === "POINT_LIGHT_BUDGET");

  it("B21 3 lights split across 2 rooms (2+1) is an error-level finding", () => {
    const issues = lightIssues(budgetIssues(roomsCtx(2, [2, 1]), { total: 3, by_prop: {} }));
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((i) => i.data?.level === "error")).toBe(true);
  });

  it("B21 8 lights, 2 per room over 4 rooms, is an error-level finding", () => {
    const issues = lightIssues(budgetIssues(roomsCtx(4, [2, 2, 2, 2]), { total: 8, by_prop: {} }));
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((i) => i.data?.level === "error")).toBe(true);
  });

  it("B21 7 lights in one room is an error, not a warn", () => {
    const issues = lightIssues(budgetIssues(roomsCtx(1, [7]), { total: 7, by_prop: {} }));
    const roomIssue = issues.find((i) => i.data?.room === "r0" || i.data?.n === 7);
    expect(roomIssue).toBeDefined();
    expect(roomIssue!.data?.level).toBe("error");
  });
});
