import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runAssets } from "../src/assets/run.js";
import { FakeDenseObjectProvider, FakeImageProvider, fakeDenseGlb, fakePng } from "../src/assets/providers/fake.js";
import { glbTriangles } from "../src/assets/tris.js";
import { writeDist } from "../src/build/write.js";
import { runCheck } from "../src/check.js";

const ENGINE = fileURLToPath(new URL("..", import.meta.url));
const SCENE_DIR = join(ENGINE, "test/scenes/koshakan");
const SCENE_PATH = join(SCENE_DIR, "bedroom.scene.json");
const FRAME = readFileSync(join(SCENE_DIR, "bedroom_empty.png"));
const DENSE = { a_bed: 8000, a_nightstand: 6000, "кровать": 8000, "тумбочка": 6000 };

/** The fake image provider, except that a 2:1 request (the sky) gets a real 2:1 picture. */
class AcceptImage extends FakeImageProvider {
  override async generate(prompt: string, size: any): Promise<Buffer> {
    const [w, h] = String(size).split("x").map(Number);
    if (w === 2 * h) {
      await super.generate(prompt, size);
      return fakePng(32, 16, [120, 150, 200]);
    }
    return super.generate(prompt, size);
  }
}

function sceneJson(mutate?: (s: any) => void): any {
  const s = JSON.parse(readFileSync(SCENE_PATH, "utf-8"));
  mutate?.(s);
  return s;
}

function hashTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of readdirSync(dir).sort()) out[f] = createHash("sha256").update(readFileSync(join(dir, f))).digest("hex");
  return out;
}

async function accept(scene: any, object: FakeDenseObjectProvider, image = new AcceptImage()) {
  const cache = mkdtempSync(join(tmpdir(), "dreamer-kosh-cache-"));
  const out = join(mkdtempSync(join(tmpdir(), "dreamer-kosh-")), "dist");
  const { report, ctx } = runCheck(scene);
  expect(report.errors).toEqual([]);
  const assets = await runAssets(ctx.scene, { mode: "live", maxDollars: 100, cacheDir: cache, sceneDir: SCENE_DIR, image, object });
  const before = hashTree(cache);
  await writeDist(ctx, report, out, { startedAt: Date.now(), assets, cacheDir: cache, scenePath: SCENE_PATH });
  expect(hashTree(cache)).toEqual(before);
  const build = JSON.parse(readFileSync(join(out, "build.json"), "utf-8"));
  const ids = (JSON.parse(readFileSync(join(out, "geometry.json"), "utf-8")).cameras as { id: string }[]).map((c) => c.id);
  mkdirSync(join(out, "shots"), { recursive: true });
  for (const id of ids) writeFileSync(join(out, "shots", `${id}.png`), fakePng(8, 8, [1, 2, 3]));
  const scenePath = join(out, "..", "bedroom.scene.json");
  writeFileSync(scenePath, JSON.stringify(scene));
  const chk = spawnSync("node", ["--import", "tsx", "bin/dreamer.ts", "check", scenePath, "--built", out], { cwd: ENGINE, encoding: "utf-8" });
  return { assets, build, text: chk.stdout + chk.stderr, status: chk.status };
}

function expectCut(build: any): void {
  const cut = build.assets.cut;
  expect(cut.a_bed.from).toBe(8000);
  expect(cut.a_bed.to).toBeLessThanOrEqual(5000);
  expect(cut.a_nightstand.from).toBe(6000);
  expect(cut.a_nightstand.to).toBeLessThanOrEqual(1000);
}

describe("koshakan acceptance (engine level, fake providers)", () => {
  it("fakeDenseGlb has exactly the triangles asked for", () => {
    expect(glbTriangles(fakeDenseGlb(8000))).toBe(8000);
    expect(glbTriangles(fakeDenseGlb(6000))).toBe(6000);
    expect(glbTriangles(fakeDenseGlb(8001))).toBe(8001);
    expect(glbTriangles(fakeDenseGlb(1))).toBe(1);
  });

  it("redraw: runAssets → build → check --built, dense meshes cut into budget", async () => {
    const image = new AcceptImage();
    const object = new FakeDenseObjectProvider(DENSE);
    const r = await accept(sceneJson(), object, image);
    expect(image.refCalls.length).toBe(1);
    expect(image.refCalls[0].bytes.equals(FRAME)).toBe(true);
    expect(image.refCalls[0].what).toBe("кровать");
    expect((r.assets.failed ?? []).filter((f: any) => f.reason === "REF_MISSING")).toEqual([]);
    expectCut(r.build);
    expect(r.text).not.toMatch(/TRI_PROP_BUDGET/);
    expect(r.status, r.text).toBe(0);
  }, 180_000);

  it("default (no ref.mode): fromScene gets the frame bytes and what, fromRef is not called", async () => {
    const image = new AcceptImage();
    const object = new FakeDenseObjectProvider(DENSE);
    const r = await accept(sceneJson((s) => delete s.assets.a_bed.ref.mode), object, image);
    expect(object.sceneCalls.length).toBe(1);
    expect(object.sceneCalls[0].what).toBe("кровать");
    expect(object.sceneCalls[0].bytes.equals(FRAME)).toBe(true);
    expect(image.refCalls.length).toBe(0);
    expect(r.assets.warnings ?? []).toEqual([]);
    expectCut(r.build);
    expect(r.text).not.toMatch(/TRI_PROP_BUDGET/);
    expect(r.status, r.text).toBe(0);
  }, 180_000);

  it("MASK_EMPTY: falls back to redraw, MASK_FALLBACK lands in build.json", async () => {
    const image = new AcceptImage();
    const object = new FakeDenseObjectProvider(DENSE, { fail: { "кровать": "empty" } });
    const r = await accept(sceneJson((s) => delete s.assets.a_bed.ref.mode), object, image);
    expect(image.refCalls.length).toBe(1);
    expect(image.refCalls[0].bytes.equals(FRAME)).toBe(true);
    expect(r.build.warnings.some((w: string) => w.includes("MASK_FALLBACK") && w.includes("a_bed"))).toBe(true);
    expectCut(r.build);
    expect(r.text).not.toMatch(/TRI_PROP_BUDGET/);
    expect(r.status, r.text).toBe(0);
  }, 180_000);
});
