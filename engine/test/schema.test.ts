import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { demoFlat, patched } from "./helpers/scene.js";
import { parseScene } from "../src/schema/parse.js";
import { validate } from "../src/schema/validate.js";
import { runCheck } from "../src/check.js";

const examplesDir = new URL("../../specs/examples/", import.meta.url);
function readExample(name: string): string {
  return readFileSync(new URL(name, examplesDir), "utf-8");
}

describe("schema phase contract", () => {
  let flatRaw: unknown;
  beforeAll(() => {
    const { raw } = parseScene(readExample("demo-flat.scene.json"));
    flatRaw = raw;
  });

  it("test_demo_flat_schema_pass", () => {
    const { report } = runCheck(flatRaw);
    expect(report.stages[0]).toEqual({ stage: "schema", status: "pass" });
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
  });

  it("test_demo_full_future", () => {
    const { raw } = parseScene(readExample("demo.scene.json"));
    const { report } = runCheck(raw);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0].code).toBe("SCHEMA_FUTURE_FIELD");
    expect(report.errors[0].path).toBe("/stairs");
  });

  it("test_broken_schema_codes", () => {
    const cases: Array<{ file: string; code: string; path?: string }> = [
      { file: "SCHEMA_UNKNOWN_FIELD", code: "SCHEMA_UNKNOWN_FIELD", path: "/rooms/0/colour" },
      { file: "SCHEMA_FUTURE_FIELD", code: "SCHEMA_FUTURE_FIELD", path: "/props/0/collider" },
      { file: "SCHEMA_TYPE", code: "SCHEMA_TYPE", path: "/rooms/0/shape/1/2/bulge" },
      { file: "SCHEMA_REQUIRED", code: "SCHEMA_REQUIRED", path: "/rooms/1/height" },
      { file: "SCHEMA_EXCLUSIVE", code: "SCHEMA_EXCLUSIVE", path: "/rooms/0" },
      { file: "ID_DUPLICATE", code: "ID_DUPLICATE", path: "/openings/0/id" },
      { file: "REF_UNKNOWN", code: "REF_UNKNOWN", path: "/rooms/0/floor" },
      { file: "REF_KIND", code: "REF_KIND", path: "/decals/0/asset" },
      { file: "ROOM_REF_MISMATCH", code: "ROOM_REF_MISMATCH", path: "/decals/0" },
      { file: "POS_INVALID", code: "POS_INVALID", path: "/decals/0/on" },
    ];
    for (const c of cases) {
      const patchPath = new URL(`./scenes/broken/${c.file}.patch.json`, import.meta.url);
      const ops = JSON.parse(readFileSync(patchPath, "utf-8"));
      const raw = patched(ops);
      const { report } = runCheck(raw);
      expect(report.errors.map((e) => e.code)).toEqual([c.code]);
      if (c.path) expect(report.errors[0].path).toBe(c.path);
      expect(report.warnings).toEqual([]);
    }
  });

  it("test_schema_parse", () => {
    const text = readFileSync(new URL("./scenes/broken/SCHEMA_PARSE.scene.json", import.meta.url), "utf-8");
    const { raw, issues } = parseScene(text);
    expect(raw).toBeNull();
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("SCHEMA_PARSE");
    expect(issues[0].path).toBe("");
    expect(issues[0].msg).toContain("строка 2");
  });

  it("test_exclusive_pairs", () => {
    const base = demoFlat() as any;
    // opening with at and on
    base.openings[0] = { ...base.openings[0], on: { room: "living", edge: 0, t: 0.5 } };
    let r = runCheck(base).report;
    expect(r.errors.filter((e) => e.code === "SCHEMA_EXCLUSIVE")).toHaveLength(1);
    // prop face + yaw
    const b2 = demoFlat() as any;
    b2.props[0] = { ...b2.props[0], face: "room" };
    r = runCheck(b2).report;
    expect(r.errors.filter((e) => e.code === "SCHEMA_EXCLUSIVE")).toHaveLength(1);
    // material tile + color
    const b3 = demoFlat() as any;
    b3.materials["olive"] = { tile: "t_wall", color: "#ffffff" };
    r = runCheck(b3).report;
    expect(r.errors.filter((e) => e.code === "SCHEMA_EXCLUSIVE")).toHaveLength(1);
    // on with t and m
    const b4 = demoFlat() as any;
    b4.openings[1] = { ...b4.openings[1], on: { room: "living", edge: 1, t: 0.5, m: 1.0 } };
    r = runCheck(b4).report;
    expect(r.errors.filter((e) => e.code === "SCHEMA_EXCLUSIVE")).toHaveLength(1);
    // around with at
    const b5 = demoFlat() as any;
    b5.props[1] = { ...b5.props[1], at: [0, 0] };
    r = runCheck(b5).report;
    expect(r.errors.filter((e) => e.code === "SCHEMA_EXCLUSIVE")).toHaveLength(1);
    // material without tile and color
    const b6 = demoFlat() as any;
    b6.materials["olive"] = {};
    r = runCheck(b6).report;
    const req = r.errors.filter((e) => e.code === "SCHEMA_REQUIRED");
    expect(req).toHaveLength(1);
    expect(req[0].path).toBe("/materials/olive/tile");
    // bulge 1.5 exactly one issue
    const b7 = patched([{ op: "replace", path: "/rooms/0/shape/1/2/bulge", value: 1.5 }]);
    r = runCheck(b7).report;
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].code).toBe("SCHEMA_TYPE");
  });

  it("test_schema_code_checks", () => {
    let raw = patched([{ op: "replace", path: "/rooms/0/shape/1/2/bulge", value: 0 }]);
    expect(runCheck(raw).report.errors.map((e) => e.code)).toEqual(["SCHEMA_TYPE"]);
    const b = demoFlat() as any;
    b.rooms[0].walls.bands = [{ to: 1.0, material: "wood" }, { to: 0.5, material: "wood" }];
    expect(runCheck(b).report.errors.map((e) => e.code)).toEqual(["SCHEMA_TYPE"]);
    const c = demoFlat() as any;
    c.rooms[0].edges = { "9": { material: "olive" } };
    const rc = runCheck(c).report;
    expect(rc.errors.map((e) => e.code)).toEqual(["REF_UNKNOWN"]);
    const d = demoFlat() as any;
    d.props[0].face = [0, 0];
    delete (d.props[0] as any).yaw;
    d.props[0].at = [0, 0];
    expect(runCheck(d).report.errors.map((e) => e.code)).toEqual(["POS_INVALID"]);
  });

  it("test_defaults_applied", () => {
    const scene: any = {
      version: 0,
      name: "mini",
      spawn: { room: "r", at: [0, 0] },
      materials: { m1: { color: "#ffffff" }, m2: { color: "#000000" } },
      levels: [{ id: "L0", y: 0 }],
      rooms: [{ id: "r", level: "L0", height: 3, shape: [[-2, -2], [2, -2], [2, 2], [-2, 2]], floor: "m1", ceiling: "m2", walls: { material: "m1" } }],
      assets: { a1: { kind: "decal", prompt: "x" }, p1: { kind: "object", prompt: "y" } },
      openings: [{ id: "w", kind: "window", on: { room: "r", edge: 0, t: 0.5 }, width: 1, outside: { backdrop: "a1" } }],
      decals: [{ asset: "a1", room: "r", on: { room: "r", edge: 0, t: 0.5 }, size: { w: 0.5, h: 0.5 } }],
      lights: [{ kind: "point", pos: [0, 2, 0] }],
      cameras: [{ id: "c", pos: [0, 1.5, 0], look: [0, 1, 1] }],
    };
    const { scene: s } = validate(scene);
    expect((s as any).spawn.yaw).toBe(0);
    expect((s as any).props).toEqual([]);
    expect((s as any).rooms[0].walls.thickness).toBe(0.12);
    expect((s as any).openings[0].height).toBe(1.2);
    expect((s as any).openings[0].sill).toBe(0.9);
    expect((s as any).decals[0].y).toBe(1.6);
    expect((s as any).lights[0].power).toBe(1.0);
    expect((s as any).cameras[0].fov).toBe(60);
  });

  it("test_stop_after_failed_stage", () => {
    const raw = patched([{ op: "replace", path: "/rooms/0/shape/1/2/bulge", value: 1.5 }]);
    const { report } = runCheck(raw);
    expect(report.stages.map((s) => s.status)).toEqual(["fail", "skipped", "skipped", "skipped", "skipped", "skipped", "skipped", "skipped"]);
  });

  it("test_findings_f19_f26", () => {
    // F19: leaf.swing referencing an unknown room must raise REF_UNKNOWN
    const a = demoFlat() as any;
    a.openings[0].leaf = { ...(a.openings[0].leaf ?? { decal: "d_door" }), swing: "missing-room" };
    let r = runCheck(a).report;
    expect(r.errors.map((e) => e.code)).toContain("REF_UNKNOWN");
    expect(r.errors.find((e) => e.code === "REF_UNKNOWN")?.path).toBe("/openings/0/leaf/swing");

    // F20: gap height on a circle room must use the circle room's own ceiling, not fall back to default
    const circleScene: any = {
      version: 0,
      name: "circle",
      spawn: { room: "r", at: [0, 0] },
      materials: { m1: { color: "#ffffff" } },
      levels: [{ id: "L0", y: 0 }],
      rooms: [{ id: "r", level: "L0", height: 3.4, circle: { c: [0, 0], r: 5 }, floor: "m1", ceiling: "m1", walls: { material: "m1" } }],
      assets: {},
      openings: [{ id: "g", kind: "gap", at: [0, 5], width: 1 }],
    };
    const { scene: cs } = validate(circleScene);
    expect((cs as any).openings[0].height).toBe(3.4);
    expect((cs as any).openings[0].sill).toBe(0);

    // F21: props[].y is only legal with mount: wall
    const b = demoFlat() as any;
    b.props[0] = { ...b.props[0], y: 0.5 };
    expect(runCheck(b).report.errors.map((e) => e.code)).toContain("SCHEMA_TYPE");

    // F22: non-canonical edge keys like "1.0" must not be accepted as index 1
    const c = demoFlat() as any;
    c.rooms[0].edges = { "1.0": { material: "olive" } };
    const rc = runCheck(c).report;
    expect(rc.errors.map((e) => e.code)).toEqual(["REF_UNKNOWN"]);

    // F23: an unknown field in one band must not suppress the independent bands-order error
    const d = demoFlat() as any;
    d.rooms[0].walls.bands = [
      { to: 1.0, material: "wood" },
      { to: 0.5, material: "wood", bogus: 1 },
    ];
    const rd = runCheck(d).report;
    expect(rd.errors.map((e) => e.code).sort()).toEqual(["SCHEMA_TYPE", "SCHEMA_UNKNOWN_FIELD"]);

    // F24: an empty light object must report missing kind, not a spurious pos requirement
    const e = demoFlat() as any;
    e.lights = [{}];
    const re = runCheck(e).report;
    expect(re.errors.map((x) => x.code)).toEqual(["SCHEMA_REQUIRED"]);
    expect(re.errors[0].path).toBe("/lights/0/kind");

    // F25: an explicitly unknown decals[].room must raise REF_UNKNOWN even when `on` is also set
    const f = demoFlat() as any;
    f.decals[0] = { ...f.decals[0], room: "missing-room" };
    const rf = runCheck(f).report;
    expect(rf.errors.map((x) => x.code).sort()).toEqual(["REF_UNKNOWN", "ROOM_REF_MISMATCH"]);

    // F26: the message text must use the same escaped JSON Pointer as issue.path
    const g = demoFlat() as any;
    g.rooms[0].edges = { "bad/key": { material: "olive" } };
    const rg = runCheck(g).report;
    const issue = rg.errors.find((x) => x.code === "REF_UNKNOWN")!;
    expect(issue.path).toBe("/rooms/0/edges/bad~1key");
    expect(issue.msg).toContain("/rooms/0/edges/bad~1key");
  });

  it("test_findings_f29_f30_f31", () => {
    // F29: a non-numeric bands[].to must report only the schema-level error, not a duplicate ordering error
    const a = demoFlat() as any;
    a.rooms[0].walls.bands = [{ to: "bad", material: "wood" }];
    const ra = runCheck(a).report;
    expect(ra.errors.map((e) => e.code)).toEqual(["SCHEMA_TYPE"]);
    expect(ra.errors[0].path).toBe("/rooms/0/walls/bands/0/to");
    // ordering errors among the remaining numeric bands must still be reported
    const a2 = demoFlat() as any;
    a2.rooms[0].walls.bands = [{ to: "bad", material: "wood" }, { to: 1.0, material: "wood" }, { to: 0.5, material: "wood" }];
    const ra2 = runCheck(a2).report;
    expect(ra2.errors.map((e) => e.code).sort()).toEqual(["SCHEMA_TYPE", "SCHEMA_TYPE"]);
    expect(ra2.errors.map((e) => e.path).sort()).toEqual(["/rooms/0/walls/bands", "/rooms/0/walls/bands/0/to"]);

    // F30: routes[].path[] item branch errors must collapse like mount/face, one SCHEMA_TYPE per item
    const b = demoFlat() as any;
    b.routes = [{ id: "rt", path: ["living", { room: "living", at: [0, 0], extra: 1 }] }];
    const rb = runCheck(b).report;
    expect(rb.errors.map((e) => e.code)).toEqual(["SCHEMA_TYPE"]);
    expect(rb.errors[0].path).toBe("/routes/0/path/1");
  });

  it("test_report_path_uses_scene_name", () => {
    const dir = mkdtempSync(join(tmpdir(), "dreamer-"));
    const flatRawText = readFileSync(fileURLToPath(new URL("../../specs/examples/demo-flat.scene.json", import.meta.url)), "utf-8");
    const sceneName = JSON.parse(flatRawText).name;
    const inputPath = join(dir, "input.scene.json");
    writeFileSync(inputPath, flatRawText);
    const engineDir = fileURLToPath(new URL("../", import.meta.url));
    let code = 0;
    try {
      execFileSync("node", ["--import", "tsx", "bin/dreamer.ts", "check", inputPath], { cwd: engineDir, stdio: "pipe" });
    } catch (e: any) {
      code = e.status;
    }
    expect(code).toBe(0);
    const expectedPath = join(dir, `${sceneName}.check.json`);
    const report = JSON.parse(readFileSync(expectedPath, "utf-8"));
    expect(report.ok).toBe(true);
  });

  it("test_cli_exit_codes", () => {
    const dir = mkdtempSync(join(tmpdir(), "dreamer-"));
    const flatPath = new URL("../../specs/examples/demo-flat.scene.json", import.meta.url);
    const flatFile = fileURLToPath(flatPath);
    const engineDir = fileURLToPath(new URL("../", import.meta.url));
    const out1 = join(dir, "r1.json");
    let code = 0;
    try {
      execFileSync("node", ["--import", "tsx", "bin/dreamer.ts", "check", flatFile, "--report", out1], { cwd: engineDir, stdio: "pipe" });
    } catch (e: any) {
      code = e.status;
    }
    expect(code).toBe(0);
    const report1 = JSON.parse(readFileSync(out1, "utf-8"));
    expect(report1.ok).toBe(true);
    expect(report1.errors).toEqual([]);
    const patch = JSON.parse(readFileSync(new URL("./scenes/broken/SCHEMA_TYPE.patch.json", import.meta.url), "utf-8"));
    const broken = patched(patch);
    const brokenPath = join(dir, "broken.scene.json");
    writeFileSync(brokenPath, JSON.stringify(broken));
    let code2 = 0;
    try {
      execFileSync("node", ["--import", "tsx", "bin/dreamer.ts", "check", brokenPath, "--report", join(dir, "r2.json")], { cwd: engineDir, stdio: "pipe" });
    } catch (e: any) {
      code2 = e.status;
    }
    expect(code2).toBe(1);
    const parsePath = fileURLToPath(new URL("./scenes/broken/SCHEMA_PARSE.scene.json", import.meta.url));
    let code3 = 0;
    try {
      execFileSync("node", ["--import", "tsx", "bin/dreamer.ts", "check", parsePath, "--report", join(dir, "r3.json")], { cwd: engineDir, stdio: "pipe" });
    } catch (e: any) {
      code3 = e.status;
    }
    expect(code3).toBe(1);
    const report3 = JSON.parse(readFileSync(join(dir, "r3.json"), "utf-8"));
    expect(report3.errors.map((e: any) => e.code)).toEqual(["SCHEMA_PARSE"]);
    let code4 = 0;
    try {
      execFileSync("node", ["--import", "tsx", "bin/dreamer.ts", "check", join(dir, "nope.scene.json")], { cwd: engineDir, stdio: "pipe" });
    } catch (e: any) {
      code4 = e.status;
    }
    expect(code4).toBe(2);
  });
  it("test_findings_f32_f33", () => {
    // F32: a gap sitting on a bulged edge must find the room through the arc,
    // not through the straight chord, and default to that room's ceiling.
    const a = demoFlat() as any;
    a.openings.push({ id: "arc_gap", kind: "gap", at: [0, -5.6], width: 1 });
    const { scene } = validate(a);
    expect((scene as any).openings[2].height).toBe(3.4);

    // F33: when V8 omits `position N`, the reported place must still be the real one.
    const { raw, issues } = parseScene('{\n  "a":\n}');
    expect(raw).toBe(null);
    expect(issues[0].code).toBe("SCHEMA_PARSE");
    expect(issues[0].msg).toContain("строка 3");
    expect(issues[0].msg).toContain("столбец 1");
  });
  it("test_findings_f34_f38", () => {
    // F34: an incomplete literal breaks at the end of input, not at its first character.
    const p1 = parseScene("tru");
    expect(p1.raw).toBe(null);
    expect(p1.issues[0].msg).toContain("строка 1");
    expect(p1.issues[0].msg).toContain("столбец 4");

    // F35: a bare CR is JSON whitespace and also a line break.
    const p2 = parseScene('{\r  "a":\r}');
    expect(p2.issues[0].msg).toContain("строка 3");
    expect(p2.issues[0].msg).toContain("столбец 1");

    // F36: a rejected anyOf branch collapses to one SCHEMA_TYPE on the anyOf node,
    // children of that node included.
    const f36 = patched([
      { op: "remove", path: "/props/0/yaw" },
      { op: "add", path: "/props/0/face", value: [0, "x"] },
    ]);
    expect(validate(f36).issues.map((i) => [i.code, i.path])).toEqual([["SCHEMA_TYPE", "/props/0/face"]]);

    // F37: tile/color exclusion lives in the schema, so reference checks stay off
    // and a broken material reports only SCHEMA_EXCLUSIVE.
    const f37 = patched([{ op: "add", path: "/materials/plaster/tile", value: "missing-tile" }]);
    expect(validate(f37).issues.map((i) => [i.code, i.path])).toEqual([["SCHEMA_EXCLUSIVE", "/materials/plaster"]]);

    // F38: a gap on a partially shared arc finds its neighbour along the arc,
    // not along the chord, and defaults to the lower ceiling.
    const f38 = demoFlat() as any;
    f38.rooms.push({
      id: "porch",
      level: "L0",
      height: 2.5,
      shape: [[-4, -4, { bulge: -0.1926 }], [0, -5.6], [0, -12], [-4, -12]],
      floor: "parquet",
      ceiling: "plaster",
      walls: { material: "olive" },
    });
    f38.openings.push({ id: "arc_on_gap", kind: "gap", on: { room: "living", edge: 1, t: 0.3 }, width: 1 });
    const { scene: s38 } = validate(f38);
    expect((s38 as any).openings[2].height).toBe(2.5);
  });

  it("test_findings_f39_f42", () => {
    // F39: the quoted input excerpt in V8's message may itself say "position N".
    const p = parseScene('["position 2",]');
    expect(p.issues[0].msg).toContain("строка 1");
    expect(p.issues[0].msg).toContain("столбец 15");

    // F40: a band below the floor is out of range.
    const f40 = demoFlat() as any;
    f40.rooms[0].walls.bands = [{ to: -0.1, material: "wood" }];
    expect(validate(f40).issues.map((i) => [i.code, i.path])).toEqual([["SCHEMA_TYPE", "/rooms/0/walls/bands/0/to"]]);

    // F41: a circle room's arc edge counts when looking for the room across a gap.
    const circ = (open: any): any => ({
      version: 0,
      name: "circ",
      spawn: { room: "circle", at: [0, 0] },
      materials: { m1: { color: "#ffffff" } },
      levels: [{ id: "L0", y: 0 }],
      rooms: [
        { id: "circle", level: "L0", height: 3.4, circle: { c: [0, 0], r: 5 }, floor: "m1", ceiling: "m1", walls: { material: "m1" } },
        { id: "nook", level: "L0", height: 2.5, shape: [[5, 0, { bulge: -(1 - Math.SQRT1_2) / Math.SQRT1_2 }], [0, 5], [6, 6]], floor: "m1", ceiling: "m1", walls: { material: "m1" } },
      ],
      assets: {},
      openings: [open],
    });
    // the quarter arc az 0…90 is t 0…0.25 on the circle edge
    for (const on of [{ room: "circle", edge: 0, t: 0.125 }, { room: "circle", edge: 0, az: 45 }, { room: "circle", edge: 0, m: 2 * Math.PI * 5 * 1.125 }]) {
      const { scene } = validate(circ({ id: "g", kind: "gap", on, width: 1 }));
      expect((scene as any).openings[0].height).toBe(2.5);
    }
    // the far side of the circle has no neighbour
    const { scene: far } = validate(circ({ id: "g", kind: "gap", on: { room: "circle", edge: 0, az: 225 }, width: 1 }));
    expect((far as any).openings[0].height).toBe(3.4);

    // F42: `az` resolves to its own spot on a bulged edge, not the midpoint.
    const f42 = demoFlat() as any;
    f42.rooms.push({
      id: "porch",
      level: "L0",
      height: 2.5,
      shape: [[-4, -4, { bulge: -0.1926 }], [0, -5.6], [0, -12], [-4, -12]],
      floor: "parquet",
      ceiling: "plaster",
      walls: { material: "olive" },
    });
    f42.openings.push({ id: "arc_az_gap", kind: "gap", on: { room: "living", edge: 1, az: 206.161691 }, width: 1 });
    const { scene: s42 } = validate(f42);
    expect((s42 as any).openings[2].height).toBe(2.5);
  });
});
