import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { runCheck } from "../src/check.js";
import { glbTriangles } from "../src/assets/tris.js";
import { budgetIssues, propClass, TRI_LIMITS, SCENE_TRI_LIMIT } from "../src/budget.js";
import { writeGlb } from "../src/assets/glb.js";
import { sceneAssets, type AssetRef } from "../src/assets/run.js";
import { fakeGlb } from "../src/assets/providers/fake.js";
import { demoFlat, patched } from "./helpers/scene.js";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { fakeShots } from "./fake-shots.js";

const built = (tris: { total: number; by_prop: Record<string, number> }, raw: unknown = demoFlat()) => {
  const { report } = runCheck(raw, { tris });
  return report;
};
const codes = (r: { errors: { code: string }[]; warnings: { code: string }[] }) =>
  [...r.errors, ...r.warnings].map((i) => i.code);

/** F4: TriCount derived from real GLB bytes, the way `check --built` reads it from dist/. */
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

describe("budget classes", () => {
  it("picks the class by the largest bbox side", () => {
    expect(propClass({ w: 0.3, d: 0.2, h: 0.1 })).toBe("small");
    expect(propClass({ w: 0.5, d: 0.5, h: 0.5 })).toBe("small");
    expect(propClass({ w: 1, d: 2, h: 0.5 })).toBe("furniture");
    expect(propClass({ w: 2.1, d: 1, h: 1 })).toBe("large");
    expect(TRI_LIMITS).toEqual({ small: 1000, furniture: 5000, large: 8000 });
    expect(SCENE_TRI_LIMIT).toBe(300_000);
  });

  it("counts the triangles of a glb", () => {
    expect(glbTriangles(fakeGlb())).toBe(1);
  });
});

describe("check --built budgets", () => {
  it("TRI_PROP_BUDGET: 2000 tris on a 0.3 m prop, limit 1000", () => {
    const n = glbTriangles(trisGlb(6000));
    expect(n).toBe(2000);
    const raw = patched([{ op: "replace", path: "/props/3/size", value: { w: 0.3, d: 0.3, h: 0.3 } }]);
    const r = built({ total: n, by_prop: { vase: n } }, raw);
    const w = r.warnings.find((i) => i.code === "TRI_PROP_BUDGET")!;
    expect(w).toBeDefined();
    expect(w.data).toMatchObject({ id: "vase", tris: 2000, limit: 1000 });
    expect(r.ok).toBe(true);
  });

  it("TRI_SCENE_BUDGET: 40 copies of 10 000 tris is an error", () => {
    const perAsset = glbTriangles(trisGlb(30_000));
    expect(perAsset).toBe(10_000);
    // countTris adds the asset count once per copy, so 40 copies sum here
    const r = built({ total: 40 * perAsset, by_prop: {} });
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain("TRI_SCENE_BUDGET");
  });

  it("POINT_LIGHT_BUDGET: 3 in one room errors, 9 in the scene errors", () => {
    const lamp = { kind: "point", pos: [0.2, 2.6, -1.5], color: "#ffd8b0", power: 1 };
    const room = built(
      { total: 10, by_prop: {} },
      patched([{ op: "add", path: "/lights/-", value: lamp }, { op: "add", path: "/lights/-", value: lamp }]),
    );
    // B21: the room limit is an error now, not a warning
    expect(room.errors.map((i) => i.code)).toContain("POINT_LIGHT_BUDGET");
    // demo-flat already has 2 point lamps, so +7 is exactly 9 on the scene
    const raw9 = patched(
      Array.from({ length: 7 }, () => ({ op: "add" as const, path: "/lights/-", value: lamp })),
    ) as any;
    expect(raw9.lights.filter((l: any) => l?.kind === "point")).toHaveLength(9);
    const err = built({ total: 10, by_prop: {} }, raw9);
    expect(err.errors.map((i) => i.code)).toContain("POINT_LIGHT_BUDGET");
  });

  it("stays quiet without tris and on the examples", () => {
    expect(codes(runCheck(demoFlat()).report)).not.toContain("POINT_LIGHT_BUDGET");
    const dir = fileURLToPath(new URL("../../specs/examples/", import.meta.url));
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".scene.json"))) {
      const raw = JSON.parse(readFileSync(join(dir, f), "utf-8"));
      const base = runCheck(raw).report;
      const r = built({ total: 100, by_prop: {} }, raw);
      expect(codes(r).filter((c) => /BUDGET/.test(c)), f).toEqual([]);
      expect(r.errors.length, f).toBe(base.errors.length);
    }
  });
});

describe("budget blocking findings", () => {
  const square: [number, number][] = [
    [0, 0],
    [2, 0],
    [2, 2],
    [0, 2],
  ];

  it("F1: lamps on different floors with the same outline do not share a room budget", () => {
    const ctx: any = {
      scene: {
        props: [],
        levels: [
          { id: "L0", y: 0 },
          { id: "L1", y: 3 },
        ],
        lights: [
          { kind: "point", pos: [0.5, 1, 0.5] },
          { kind: "point", pos: [0.5, 1.4, 0.5] },
          { kind: "point", pos: [0.5, 4, 0.5] },
        ],
      },
      rooms: [
        { id: "down", level: "L0", height: 3, outline: square },
        { id: "up", level: "L1", height: 3, outline: square },
      ],
      passport: {},
    };
    const issues = budgetIssues(ctx, { total: 3, by_prop: {} });
    // per-room attribution only: the scene-wide cap (B21) is checked elsewhere
    expect(issues.filter((i) => i.code === "POINT_LIGHT_BUDGET" && (i.data as any).room !== undefined)).toEqual([]);
  });

  const triGlb = (count: number, mode?: number): Buffer => {
    const prim: Record<string, unknown> = { attributes: { POSITION: 0 } };
    if (mode !== undefined) prim.mode = mode;
    return writeGlb(
      {
        asset: { version: "2.0" },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ mesh: 0 }],
        meshes: [{ primitives: [prim as never] }],
        accessors: [{ bufferView: 0, componentType: 5126, count, type: "VEC3" }],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 0 }],
        buffers: [{ byteLength: 0 }],
      },
      null,
    );
  };

  it("F2: only meshes reachable from the active scene count", () => {
    const buf = writeGlb(
      {
        asset: { version: "2.0" },
        scene: 0,
        scenes: [{ nodes: [0] }, { nodes: [1] }],
        nodes: [{ mesh: 0 }, { mesh: 1 }],
        meshes: [
          { primitives: [{ attributes: { POSITION: 0 } } as never] },
          { primitives: [{ attributes: { POSITION: 1 } } as never] },
        ],
        accessors: [
          { bufferView: 0, componentType: 5126, count: 3000, type: "VEC3" },
          { bufferView: 0, componentType: 5126, count: 3000, type: "VEC3" },
        ],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 0 }],
        buffers: [{ byteLength: 0 }],
      },
      null,
    );
    expect(glbTriangles(buf)).toBe(1000);
  });

  it("F3: triangle count follows primitive.mode", () => {
    expect(glbTriangles(triGlb(6))).toBe(2);
    expect(glbTriangles(triGlb(6, 4))).toBe(2);
    expect(glbTriangles(triGlb(6, 5))).toBe(4);
    expect(glbTriangles(triGlb(6, 6))).toBe(4);
    expect(glbTriangles(triGlb(6, 0))).toBe(0);
    expect(glbTriangles(triGlb(6, 1))).toBe(0);
  });
});

type TriJson = { total: number; by_prop: Record<string, number> };

describe("built dist end-to-end (F5–F7)", () => {
  const engineDir = fileURLToPath(new URL("../", import.meta.url));
  const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

  /** dist/ with a passing-check nav and build.json carrying really counted tris */
  const makeDist = (raw: unknown, tris: TriJson): string => {
    const dir = mkdtempSync(join(tmpdir(), "budget-dist-"));
    const { ctx } = runCheck(raw);
    writeFileSync(join(dir, "nav.json"), JSON.stringify((ctx as any).nav ?? {}));
    writeFileSync(join(dir, "build.json"), JSON.stringify({ tris, props: {} }));
    // check --built reads the cameras from geometry.json and wants a shot each
    writeFileSync(join(dir, "geometry.json"), JSON.stringify({ cameras: (raw as any).cameras ?? [] }));
    fakeShots(dir);
    return dir;
  };
  const sceneFile = (raw: unknown): string => {
    const dir = mkdtempSync(join(tmpdir(), "budget-scene-"));
    const f = join(dir, "s.scene.json");
    writeFileSync(f, JSON.stringify(raw));
    return f;
  };
  const checkBuilt = (scenePath: string, dist: string) =>
    spawnSync(
      "node",
      ["--import", "tsx", "bin/dreamer.ts", "check", scenePath, "--built", dist, "--report", join(dist, "r.check.json")],
      { cwd: engineDir, encoding: "utf-8" },
    );
  const glbDir = (buf: Buffer): string => {
    const d = mkdtempSync(join(tmpdir(), "budget-glb-"));
    writeFileSync(join(d, "m.glb"), buf);
    return d;
  };

  it("F5: 40 copies of one 10k-tri asset count with repeats → TRI_SCENE_BUDGET, exit ≠ 0", async () => {
    const { countTris } = (await import("../src/build/write.js")) as any;
    const d = glbDir(trisGlb(30_000));
    const geo = {
      meshes: Array.from({ length: 40 }, (_, i) => ({ kind: "prop", id: `chair.${i}`, glb: "m.glb", indices: [] })),
    } as any;
    const tris = countTris(geo, d, ["chair"]);
    expect(tris.total).toBe(400_000);
    expect(tris.by_prop["chair"]).toBe(10_000);
    const raw = demoFlat();
    const r = checkBuilt(sceneFile(raw), makeDist(raw, JSON.parse(JSON.stringify(tris))));
    expect(String(r.stdout)).toContain("TRI_SCENE_BUDGET");
    expect(r.status).not.toBe(0);
  });

  it("F6: around-copy mesh ids collapse to the raw id → TRI_PROP_BUDGET for chairs, limit 1000", async () => {
    const { countTris } = (await import("../src/build/write.js")) as any;
    // /props/1 is the chairs around-prop; author ids never contain dots (schema),
    // the dots live on the built copy ids (`chairs.0`) and must map back (F6)
    const raw = patched([{ op: "replace", path: "/props/1/size", value: { w: 0.3, d: 0.3, h: 0.3 } }]);
    const ids = (raw as any).props.map((p: any) => String(p?.id));
    const d = glbDir(trisGlb(6000));
    const geo = {
      meshes: ["chairs.0", "chairs.1", "chairs.2"].map((id) => ({ kind: "prop", id, glb: "m.glb", indices: [] })),
    } as any;
    const tris = countTris(geo, d, ids);
    expect(has(tris.by_prop, "chairs")).toBe(true);
    expect(tris.by_prop["chairs"]).toBe(2000);
    // a dotted id that is itself a known prop is never cut to its first segment
    const dotted = countTris(
      { meshes: [{ kind: "prop", id: "vase.small", glb: "m.glb", indices: [] }] } as any,
      d,
      [...ids, "vase.small"],
    );
    expect(has(dotted.by_prop, "vase.small")).toBe(true);
    expect(has(dotted.by_prop, "vase")).toBe(false);
    const r = checkBuilt(sceneFile(raw), makeDist(raw, JSON.parse(JSON.stringify(tris))));
    expect(String(r.stdout)).toContain("TRI_PROP_BUDGET");
    expect(String(r.stdout)).toContain("chairs");
    expect(r.status).toBe(0);
  });

  it("F7: __proto__ stays an own key from dist to finding → TRI_PROP_BUDGET, limit 1000", async () => {
    const { countTris } = (await import("../src/build/write.js")) as any;
    const d = glbDir(trisGlb(6000));
    const geo = { meshes: [{ kind: "prop", id: "__proto__", glb: "m.glb", indices: [] }] } as any;
    const tris = countTris(geo, d, ["__proto__"]);
    expect(has(tris.by_prop, "__proto__")).toBe(true);
    expect(tris.by_prop["__proto__"]).toBe(2000);
    // "__proto__" cannot go through the CLI: author ids must start with a letter
    // (schema), so the dist→finding leg is checked via budgetIssues on the same
    // JSON a build.json carries
    const raw = patched([{ op: "replace", path: "/props/3/size", value: { w: 0.3, d: 0.3, h: 0.3 } }]) as any;
    raw.props[3].id = "__proto__";
    const issues = budgetIssues({ scene: raw } as any, JSON.parse(JSON.stringify(tris)));
    const w = issues.find((i) => i.code === "TRI_PROP_BUDGET");
    expect(w?.data).toMatchObject({ id: "__proto__", tris: 2000, limit: 1000 });
  });
});
