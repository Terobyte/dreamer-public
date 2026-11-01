import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheKey } from "../src/assets/cache.js";
import { runAssets } from "../src/assets/run.js";
import { FakeImageProvider, FakeObjectProvider, fakePng } from "../src/assets/providers/fake.js";
import { MuseImageProvider } from "../src/assets/providers/muse-image.js";
import type { ImageProvider } from "../src/assets/providers/types.js";
import { runCheck } from "../src/check.js";
import { writeDist } from "../src/build/write.js";
import { demoFlat } from "./helpers/scene.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "dreamer-ref-"));
}

/** Two object assets with the same prompt; `bed` carries a reference image. */
function scene(refImage = "refs/bedroom.png"): any {
  return {
    assets: {
      bed: { kind: "object", prompt: "a wooden bed", ref: { image: refImage, what: "кровать у левой стены", mode: "redraw" } },
      chair: { kind: "object", prompt: "a wooden chair" },
    },
    props: [{ asset: "bed" }, { asset: "chair" }],
  };
}

function sceneDir(): string {
  const dir = tmp();
  const refs = join(dir, "refs");
  mkdirSync(refs, { recursive: true });
  writeFileSync(join(refs, "bedroom.png"), fakePng(2, 2, [10, 20, 30]));
  return dir;
}

const LIVE = { mode: "live" as const, maxDollars: 100 };

describe("asset ref", () => {
  it("cacheKey without ref is byte-identical to the frozen key", () => {
    expect(cacheKey("object", "a wooden bed")).toBe(
      "889db257d325ae5d96d9df1bef10f296c7e57ea724080d9078807dcdb81d267c",
    );
    expect(cacheKey("tile", "oak floor", "1:1")).toBe(cacheKey("tile", "oak floor"));
  });

  it("same prompt, different ref → different keys", () => {
    const a = cacheKey("object", "a bed", "1:1", { bytes: Buffer.from("A"), what: "bed" });
    const b = cacheKey("object", "a bed", "1:1", { bytes: Buffer.from("B"), what: "bed" });
    const c = cacheKey("object", "a bed", "1:1", { bytes: Buffer.from("A"), what: "other" });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(cacheKey("object", "a bed"));
  });

  it("fake provider gets the ref bytes and what", async () => {
    const dir = sceneDir();
    const image = new FakeImageProvider();
    const report = await runAssets(scene(), { ...LIVE, cacheDir: tmp(), sceneDir: dir, image, object: new FakeObjectProvider() });
    expect(image.refCalls.length).toBe(1);
    expect(image.refCalls[0].what).toBe("кровать у левой стены");
    expect(image.refCalls[0].bytes.equals(readFileSync(join(dir, "refs/bedroom.png")))).toBe(true);
    expect(image.calls.length).toBe(1); // only the chair goes by text
    expect(report.used.sort()).toEqual(["bed", "chair"]);
    expect(report.warnings ?? []).toEqual([]);
  });

  it("provider without fromRef → REF_IGNORED in report and build.json", async () => {
    const fake = new FakeImageProvider();
    const image: ImageProvider = { generate: (p, s) => fake.generate(p, s) };
    const dir = sceneDir();
    const report = await runAssets(scene(), { ...LIVE, cacheDir: tmp(), sceneDir: dir, image, object: new FakeObjectProvider() });
    expect(report.warnings).toEqual([{ code: "REF_IGNORED", id: "bed" }]);
    expect(report.used.sort()).toEqual(["bed", "chair"]);

    // end to end: the very same report reaches build.json, not a hand-made copy
    const { report: check, ctx } = runCheck(demoFlat());
    const out = tmp();
    await writeDist(ctx, check, out, {
      startedAt: Date.now(),
      assets: report,
    });
    const build = JSON.parse(readFileSync(join(out, "build.json"), "utf-8"));
    expect(build.warnings.some((w: string) => w.includes("REF_IGNORED") && w.includes("bed"))).toBe(true);
  }, 90_000);

  it("missing ref image → failed REF_MISSING, the rest is built", async () => {
    const image = new FakeImageProvider();
    const report = await runAssets(scene("refs/nope.png"), { ...LIVE, cacheDir: tmp(), sceneDir: sceneDir(), image, object: new FakeObjectProvider() });
    expect(report.failed?.map((f: any) => [f.reason, f.id])).toEqual([["REF_MISSING", "bed"]]);
    expect(report.used).toEqual(["chair"]);
    expect(report.fallback).toContain("bed");
    expect(image.refCalls.length).toBe(0);
  });

  it("ref outside sceneDir → failed REF_PATH, file not read", async () => {
    for (const bad of ["../x.png", "/etc/hosts"]) {
      const image = new FakeImageProvider();
      const report = await runAssets(scene(bad), { ...LIVE, cacheDir: tmp(), sceneDir: sceneDir(), image, object: new FakeObjectProvider() });
      expect(report.failed?.map((f: any) => [f.reason, f.id])).toEqual([["REF_PATH", "bed"]]);
      expect(report.used).toEqual(["chair"]);
      expect(image.refCalls.length).toBe(0);
    }
  });

  it("MuseImageProvider.fromRef posts the picture and what to /v1/images/edits", async () => {
    const realFetch = globalThis.fetch;
    const prevKey = process.env.META_MODEL_API_KEY;
    process.env.META_MODEL_API_KEY = "test-key";
    const seen: { url: string; form: FormData }[] = [];
    globalThis.fetch = (async (url: any, init: any) => {
      seen.push({ url: String(url), form: init.body as FormData });
      const b64 = fakePng(2, 2, [1, 2, 3]).toString("base64");
      return new Response(JSON.stringify({ data: [{ b64_json: b64 }] }), { status: 200 });
    }) as typeof fetch;
    try {
      const p = new MuseImageProvider({ baseUrl: "http://muse.test" });
      const src = fakePng(3, 3, [9, 9, 9]);
      const out = await p.fromRef!({ bytes: src, what: "кровать у левой стены" }, "a wooden bed", "1024x1024");
      expect(out.length).toBeGreaterThan(0);
      expect(seen.length).toBe(1);
      expect(seen[0].url).toBe("http://muse.test/v1/images/edits");
      expect(String(seen[0].form.get("prompt"))).toContain("кровать у левой стены");
      const img = seen[0].form.get("image") as Blob;
      expect(Buffer.from(await img.arrayBuffer()).equals(src)).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
      if (prevKey === undefined) delete process.env.META_MODEL_API_KEY;
      else process.env.META_MODEL_API_KEY = prevKey;
    }
  });

  it("schema: ref on object accepted, on decal and tile → REF_KIND", () => {
    const ok = demoFlat() as any;
    ok.assets.p_table.ref = { image: "refs/a.png", what: "стол" };
    expect(runCheck(ok).report.errors).toEqual([]);
    for (const id of ["d_portrait", "t_wall"]) {
      const bad = demoFlat() as any;
      bad.assets[id].ref = { image: "refs/a.png", what: "x" };
      expect(runCheck(bad).report.errors.map((e) => e.code)).toEqual(["REF_KIND"]);
    }
  });

  it("symlink escaping sceneDir → REF_PATH, bytes never read", async () => {
    const dir = sceneDir();
    const outside = join(tmp(), "secret.bin");
    writeFileSync(outside, Buffer.from("top-secret-bytes"));
    const { symlinkSync } = await import("node:fs");
    symlinkSync(outside, join(dir, "refs", "x.png"));
    const image = new FakeImageProvider();
    const report = await runAssets(scene("refs/x.png"), { ...LIVE, cacheDir: tmp(), sceneDir: dir, image, object: new FakeObjectProvider() });
    expect(report.failed?.map((f: any) => [f.reason, f.id])).toEqual([["REF_PATH", "bed"]]);
    expect(report.used).toEqual(["chair"]);
    expect(image.refCalls.length).toBe(0);
  });

  it("sub/../ staying inside sceneDir is accepted", async () => {
    const dir = sceneDir();
    mkdirSync(join(dir, "sub"), { recursive: true });
    const image = new FakeImageProvider();
    const report = await runAssets(scene("sub/../refs/bedroom.png"), { ...LIVE, cacheDir: tmp(), sceneDir: dir, image, object: new FakeObjectProvider() });
    expect(report.failed ?? []).toEqual([]);
    expect(report.used).toContain("bed");
    expect(image.refCalls.length).toBe(1);
  });

  it("sceneDir / accepts a relative path inside it", async () => {
    const dir = sceneDir();
    const { relative } = await import("node:path");
    const rel = relative("/", join(dir, "refs", "bedroom.png"));
    const image = new FakeImageProvider();
    const report = await runAssets(scene(rel), { ...LIVE, cacheDir: tmp(), sceneDir: "/", image, object: new FakeObjectProvider() });
    expect(report.failed ?? []).toEqual([]);
    expect(report.used).toContain("bed");
    expect(image.refCalls.length).toBe(1);
  });

  it("MuseImageProvider.fromRef uploads JPEG bytes as image/jpeg", async () => {
    const realFetch = globalThis.fetch;
    const prevKey = process.env.META_MODEL_API_KEY;
    process.env.META_MODEL_API_KEY = "test-key";
    const seen: { url: string; form: FormData }[] = [];
    globalThis.fetch = (async (url: any, init: any) => {
      seen.push({ url: String(url), form: init.body as FormData });
      const b64 = fakePng(2, 2, [1, 2, 3]).toString("base64");
      return new Response(JSON.stringify({ data: [{ b64_json: b64 }] }), { status: 200 });
    }) as typeof fetch;
    try {
      const p = new MuseImageProvider({ baseUrl: "http://muse.test" });
      const src = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
      await p.fromRef!({ bytes: src, what: "bed" }, "a bed", "1024x1024");
      expect(seen.length).toBe(1);
      const img = seen[0].form.get("image") as File;
      expect(img.type).toBe("image/jpeg");
      expect(img.name).toBe("img.jpg");
      expect(Buffer.from(await img.arrayBuffer()).equals(src)).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
      if (prevKey === undefined) delete process.env.META_MODEL_API_KEY;
      else process.env.META_MODEL_API_KEY = prevKey;
    }
  });
});
