import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheKey } from "../src/assets/cache.js";
import { runAssets } from "../src/assets/run.js";
import { FakeImageProvider, FakeObjectProvider, fakePng } from "../src/assets/providers/fake.js";
import type { ObjectProvider } from "../src/assets/providers/types.js";
import { runCheck } from "../src/check.js";
import { writeDist } from "../src/build/write.js";
import { demoFlat } from "./helpers/scene.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "dreamer-mask-"));
}

function sceneDir(): string {
  const dir = tmp();
  mkdirSync(join(dir, "refs"), { recursive: true });
  writeFileSync(join(dir, "refs", "room.png"), fakePng(2, 2, [10, 20, 30]));
  return dir;
}

/** Objects cut out of one frame of the room; `mode` lands on every ref when given. */
function scene(whats: string[], mode?: "mask" | "redraw"): any {
  const assets: Record<string, any> = {};
  const props: any[] = [];
  whats.forEach((what, i) => {
    const ref: any = { image: "refs/room.png", what };
    if (mode !== undefined) ref.mode = mode;
    assets[`o${i}`] = { kind: "object", prompt: `thing ${i}`, ref };
    props.push({ asset: `o${i}` });
  });
  return { assets, props };
}

const LIVE = { mode: "live" as const, maxDollars: 100 };

/** A provider with no `fromScene` at all: only the Н2 path is open. */
function meshOnly(fake = new FakeObjectProvider()): ObjectProvider {
  return { mesh: (png, name) => fake.mesh(png, name) };
}

describe("asset mask (Н2б)", () => {
  it("ref without mode + fromScene → no fromRef, no generate; fake gets frame bytes and what", async () => {
    const dir = sceneDir();
    const image = new FakeImageProvider();
    const object = new FakeObjectProvider();
    const report = await runAssets(scene(["кровать"]), { ...LIVE, cacheDir: tmp(), sceneDir: dir, image, object });
    expect(image.refCalls.length).toBe(0);
    expect(image.calls.length).toBe(0);
    expect(object.calls.length).toBe(0);
    expect(object.sceneCalls.length).toBe(1);
    expect(object.sceneCalls[0].what).toBe("кровать");
    expect(object.sceneCalls[0].bytes.equals(readFileSync(join(dir, "refs/room.png")))).toBe(true);
    expect(report.used).toEqual(["o0"]);
    expect(report.warnings ?? []).toEqual([]);
  });

  it("three objects, fromScene throws on two → one by mask, two by Н2 with MASK_FALLBACK error", async () => {
    const image = new FakeImageProvider();
    const object = new FakeObjectProvider({ fail: { b: "error", c: "error" } });
    const report = await runAssets(scene(["a", "b", "c"]), { ...LIVE, cacheDir: tmp(), sceneDir: sceneDir(), image, object });
    expect(report.used.sort()).toEqual(["o0", "o1", "o2"]);
    expect(object.sceneCalls.map((c) => c.what).sort()).toEqual(["a", "b", "c"]);
    expect(image.refCalls.map((c) => c.what).sort()).toEqual(["b", "c"]);
    expect(object.calls.map((c) => c.name).sort()).toEqual(["o1", "o2"]);
    const w = report.warnings ?? [];
    expect(w.filter((x) => x.code === "MASK_FALLBACK").map((x) => [x.id, x.reason]).sort()).toEqual([
      ["o1", "error"],
      ["o2", "error"],
    ]);
    expect(w.some((x) => x.code === "MASK_ALL_FALLBACK")).toBe(false);
  });

  it("none went through the mask → MASK_ALL_FALLBACK", async () => {
    const object = new FakeObjectProvider({ fail: { a: "error", b: "empty", c: "error" } });
    const report = await runAssets(scene(["a", "b", "c"]), {
      ...LIVE,
      cacheDir: tmp(),
      sceneDir: sceneDir(),
      image: new FakeImageProvider(),
      object,
    });
    expect(report.used.length).toBe(3);
    expect((report.warnings ?? []).some((x) => x.code === "MASK_ALL_FALLBACK")).toBe(true);
  });

  it("all MaskMesh failures → MASK_FALLBACK without reason, no MASK_ALL_FALLBACK", async () => {
    const object = new FakeObjectProvider({ fail: { a: "mesh", b: "mesh" } });
    const report = await runAssets(scene(["a", "b"]), {
      ...LIVE,
      cacheDir: tmp(),
      sceneDir: sceneDir(),
      image: new FakeImageProvider(),
      object,
    });
    expect(report.failed?.map((f: any) => f.id).sort()).toEqual(["o0", "o1"]);
    const w = report.warnings ?? [];
    expect(w.filter((x) => x.code === "MASK_FALLBACK" && (x as any).reason === undefined).length).toBe(2);
    expect(w.some((x) => x.code === "MASK_ALL_FALLBACK")).toBe(false);
  });

  it("provider without fromScene for every object → MASK_ALL_FALLBACK", async () => {
    const image = new FakeImageProvider();
    const report = await runAssets(scene(["a"]), { ...LIVE, cacheDir: tmp(), sceneDir: sceneDir(), image, object: meshOnly() });
    expect(image.refCalls.length).toBe(1);
    expect(report.used).toEqual(["o0"]);
    expect(report.warnings).toContainEqual({ code: "MASK_FALLBACK", id: "o0", reason: "unavailable" });
    expect(report.warnings).toContainEqual({ code: "MASK_ALL_FALLBACK", id: "*" });
  });

  it("MASK_EMPTY → Н2, MASK_FALLBACK with id in the report and build.json", async () => {
    const image = new FakeImageProvider();
    const object = new FakeObjectProvider({ fail: { a: "empty" } });
    const report = await runAssets(scene(["a"]), { ...LIVE, cacheDir: tmp(), sceneDir: sceneDir(), image, object });
    expect(image.refCalls.length).toBe(1);
    expect(report.warnings).toContainEqual({ code: "MASK_FALLBACK", id: "o0", reason: "empty" });
    const { report: check, ctx } = runCheck(demoFlat());
    const out = tmp();
    await writeDist(ctx, check, out, { startedAt: Date.now(), assets: report });
    const build = JSON.parse(readFileSync(join(out, "build.json"), "utf-8"));
    expect(build.warnings.some((w: string) => w.includes("MASK_FALLBACK") && w.includes("o0") && w.includes("empty"))).toBe(true);
  }, 90_000);

  it("SAM3D fails after the mask → failed, no fromRef/generate, MASK_FALLBACK id in warnings", async () => {
    const image = new FakeImageProvider();
    const object = new FakeObjectProvider({ fail: { a: "mesh" } });
    const report = await runAssets(scene(["a"]), { ...LIVE, cacheDir: tmp(), sceneDir: sceneDir(), image, object });
    expect(image.refCalls.length).toBe(0);
    expect(image.calls.length).toBe(0);
    expect(object.calls.length).toBe(0);
    expect(report.used).toEqual([]);
    expect(report.failed?.map((f: any) => f.id)).toEqual(["o0"]);
    expect((report.warnings ?? []).some((x) => x.code === "MASK_FALLBACK" && x.id === "o0")).toBe(true);
  });

  it("segmentation failure spends no mesh budget: a 0.16 cap still builds via Н2", async () => {
    const image = new FakeImageProvider();
    const object = new FakeObjectProvider({ fail: { a: "error" } });
    const report = await runAssets(scene(["a"]), {
      mode: "live",
      maxDollars: 0.16,
      cacheDir: tmp(),
      sceneDir: sceneDir(),
      image,
      object,
    });
    expect(report.used).toEqual(["o0"]);
    expect(report.cents).toBe(16);
    expect(report.warnings).toContainEqual({ code: "MASK_FALLBACK", id: "o0", reason: "error" });
  });

  it("no cache dir still writes pose:null for a used object", async () => {
    const { report: check, ctx } = runCheck(demoFlat());
    const out = tmp();
    await writeDist(ctx, check, out, {
      startedAt: Date.now(),
      assets: { used: ["p_table"], fallback: [], missing: [], cents: 0 },
    });
    const build = JSON.parse(readFileSync(join(out, "build.json"), "utf-8"));
    expect(build.assets.pose).toEqual({ p_table: null });
  }, 90_000);

  it("mask success logs one MESH row in the ledger", async () => {
    const cacheDir = tmp();
    const report = await runAssets(scene(["a"]), { ...LIVE, cacheDir, sceneDir: sceneDir(), image: new FakeImageProvider(), object: new FakeObjectProvider() });
    expect(report.used).toEqual(["o0"]);
    const ledger = readFileSync(join(cacheDir, "ledger.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(ledger.filter((e: any) => e.cents === 15).length).toBe(1);
  });

  it('mode "redraw" goes the Н2 way', async () => {
    const image = new FakeImageProvider();
    const object = new FakeObjectProvider();
    const report = await runAssets(scene(["a"], "redraw"), { ...LIVE, cacheDir: tmp(), sceneDir: sceneDir(), image, object });
    expect(object.sceneCalls.length).toBe(0);
    expect(image.refCalls.length).toBe(1);
    expect(report.used).toEqual(["o0"]);
    expect(report.warnings ?? []).toEqual([]);
  });

  it("mode is in the key: mask == implied mask != redraw; without ref the key is frozen", () => {
    const bytes = Buffer.from("A");
    const implied = cacheKey("object", "a bed", "1:1", { bytes, what: "bed" });
    const mask = cacheKey("object", "a bed", "1:1", { bytes, what: "bed", mode: "mask" });
    const redraw = cacheKey("object", "a bed", "1:1", { bytes, what: "bed", mode: "redraw" });
    expect(mask).toBe(implied);
    expect(redraw).not.toBe(mask);
    expect(cacheKey("object", "a wooden bed")).toBe("889db257d325ae5d96d9df1bef10f296c7e57ea724080d9078807dcdb81d267c");
  });

  it("schema accepts ref.mode", () => {
    const ok = demoFlat() as any;
    ok.assets.p_table.ref = { image: "refs/a.png", what: "стол", mode: "redraw" };
    expect(runCheck(ok).report.errors).toEqual([]);
  });

  it("pose from fromScene reaches build.json; without pose → null", async () => {
    for (const [pose, want] of [
      [{ rotation: [1, 0, 0, 0], translation: [0, 1, 2], scale: [1, 1, 1] }, null],
      [undefined, null],
    ] as const) {
      const base = demoFlat() as any;
      const dir = sceneDir();
      base.assets.p_table.ref = { image: "refs/room.png", what: "стол" };
      const object = new FakeObjectProvider(pose === undefined ? {} : { pose });
      const cacheDir = tmp();
      const report = await runAssets(base, { ...LIVE, cacheDir, sceneDir: dir, image: new FakeImageProvider(), object });
      expect(report.used).toContain("p_table");
      const { report: check, ctx } = runCheck(base);
      const out = tmp();
      await writeDist(ctx, check, out, { startedAt: Date.now(), assets: report, cacheDir, scenePath: join(dir, "scene.json") });
      const build = JSON.parse(readFileSync(join(out, "build.json"), "utf-8"));
      expect(build.assets.pose.p_table).toEqual(pose ?? want);
    }
  }, 180_000);
});
