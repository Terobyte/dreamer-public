import { describe, it, expect, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCheck } from "../src/check.js";
import { demoFlat, patched } from "./helpers/scene.js";
import type { ImageSize } from "../src/assets/templates.js";
import { cachePaths } from "../src/assets/cache.js";
import { runAssets, sceneAssets, missingAssets, type AssetRef } from "../src/assets/run.js";
import { CapError, totalCents } from "../src/assets/cost.js";
import { FakeImageProvider, FakeObjectProvider, fakeGlb, fakePng } from "../src/assets/providers/fake.js";
import { MuseImageProvider, RetryableError } from "../src/assets/providers/muse-image.js";
import { Sam3dProvider } from "../src/assets/providers/sam3d.js";
import type { ImageProvider, ObjectProvider } from "../src/assets/providers/types.js";

const ENGINE = fileURLToPath(new URL("..", import.meta.url));
const DEMO = "../specs/examples/demo-flat.scene.json";

/** Lets one test make a single `writeFileSync` path fail, to prove a local
 * write failure is never double-charged against the money cap. `partial`
 * additionally writes a truncated payload to the real path before throwing,
 * to prove the asset is still reported missing rather than "used" off a
 * half-written file. */
const writeFailState = vi.hoisted(() => ({ failPath: null as string | null, partial: false }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: (path: unknown, data: unknown, opts?: unknown) => {
      if (path === writeFailState.failPath) {
        if (writeFailState.partial) {
          (actual.writeFileSync as any)(path, (data as Buffer).subarray(0, 8), opts);
        }
        throw new Error("ENOSPC: simulated disk full");
      }
      return (actual.writeFileSync as any)(path, data, opts);
    },
  };
});

function cli(args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("node", ["--import", "tsx", "bin/dreamer.ts", ...args], { cwd: ENGINE, encoding: "utf-8" });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "dreamer-"));
}

function validated(scene: unknown): any {
  return runCheck(scene).ctx.scene;
}

function fillCache(dir: string, refs: AssetRef[], skip: string[] = []): void {
  for (const a of refs) {
    if (skip.includes(a.id)) continue;
    if (a.kind === "object") writeFileSync(join(dir, `${a.key}.glb`), fakeGlb());
    else writeFileSync(join(dir, `${a.key}.png`), fakePng(4, 4, [120, 90, 60], a.kind === "decal"));
  }
}

function ledger(dir: string): { kind: string; key: string; cents: number }[] {
  const p = join(dir, "ledger.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

/** Fails the first `times` attempts for one asset, then behaves. */
class FlakyObjectProvider implements ObjectProvider {
  readonly calls: { name: string }[] = [];
  private seen = 0;

  constructor(
    private readonly bad: string,
    private readonly times: number,
  ) {}

  async mesh(_png: Buffer, name: string): Promise<Buffer> {
    this.calls.push({ name });
    if (name === this.bad && this.seen++ < this.times) throw new Error(`sam3d: no mesh for ${name}`);
    return fakeGlb();
  }
}

/** Counts how many generate() calls overlap in time. */
class SlowImageProvider implements ImageProvider {
  readonly calls: { prompt: string; size: ImageSize }[] = [];
  live = 0;
  peak = 0;

  async generate(prompt: string, size: ImageSize): Promise<Buffer> {
    this.calls.push({ prompt, size });
    this.live++;
    this.peak = Math.max(this.peak, this.live);
    await new Promise((r) => setTimeout(r, 20));
    this.live--;
    return fakePng(4, 4, [10, 20, 30], true);
  }
}

/** demo-flat plus `n` extra tiles, one wall band each, so images outnumber the pool. */
function manyTiles(n: number): unknown {
  const assets: Record<string, unknown> = {};
  const materials: Record<string, unknown> = {};
  const bands: unknown[] = [];
  for (let k = 0; k < n; k++) {
    assets[`t_${k}`] = { kind: "tile", prompt: `extra tile number ${k}` };
    materials[`m_${k}`] = { tile: `t_${k}`, repeat_m: 1 };
    bands.push({ to: Number((0.1 * (k + 1)).toFixed(3)), material: `m_${k}` });
  }
  const base = demoFlat() as any;
  return patched([
    { op: "replace", path: "/assets", value: { ...base.assets, ...assets } },
    { op: "replace", path: "/materials", value: { ...base.materials, ...materials } },
    { op: "replace", path: "/rooms/0/walls/bands", value: bands },
  ]);
}

describe("assets live", () => {
  it("test_cache_key", async () => {
    const scene = validated(demoFlat());
    const dir = tmp();
    fillCache(dir, sceneAssets(scene));
    const image = new FakeImageProvider();
    const object = new FakeObjectProvider();
    const rep = await runAssets(scene, { mode: "live", cacheDir: dir, image, object, maxDollars: 1 });
    expect(image.calls.length).toBe(0);
    expect(object.calls.length).toBe(0);
    expect(rep.used.length).toBe(10);
    expect(rep.missing).toEqual([]);
    expect(rep.cents).toBe(0);
  });

  it("test_live_fills_cache", async () => {
    const scene = validated(demoFlat());
    const dir = tmp();
    const image = new FakeImageProvider();
    const object = new FakeObjectProvider();
    const rep = await runAssets(scene, { mode: "live", cacheDir: dir, image, object, maxDollars: 1 });
    expect(image.calls.length).toBe(10);
    expect(object.calls.length).toBe(5);
    for (const ref of sceneAssets(scene)) {
      const p = cachePaths(dir, ref.key);
      expect(existsSync(ref.kind === "object" ? p.glb : p.png)).toBe(true);
    }
    expect(ledger(dir).length).toBe(15);
    expect(rep.cents).toBe(85);
    expect(rep.missing).toEqual([]);
    expect(rep.used.length).toBe(10);
  });

  it("test_cap_exact", async () => {
    const scene = validated(demoFlat());
    const dir = tmp();
    expect(totalCents(sceneAssets(scene))).toBe(85);
    const rep = await runAssets(scene, {
      mode: "live",
      cacheDir: dir,
      image: new FakeImageProvider(),
      object: new FakeObjectProvider(),
      maxDollars: 0.85,
    });
    expect(rep.cents).toBe(85);
    expect(rep.missing).toEqual([]);
  });

  it("test_refuse_over_cap", async () => {
    const scene = validated(demoFlat());
    const dir = tmp();
    const image = new FakeImageProvider();
    const object = new FakeObjectProvider();
    await expect(
      runAssets(scene, { mode: "live", cacheDir: dir, image, object, maxDollars: 0.1 }),
    ).rejects.toThrow(CapError);
    await expect(
      runAssets(scene, { mode: "live", cacheDir: dir, image, object, maxDollars: 0.1 }),
    ).rejects.toThrow(/85/);
    expect(image.calls.length).toBe(0);
    expect(object.calls.length).toBe(0);

    const r = cli(["build", DEMO, "--out", join(tmp(), "dist"), "--assets", "live", "--cache", tmp()]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--max-dollars");
  });

  it("test_refuse_non_finite_cap", async () => {
    const scene = validated(demoFlat());
    const dir = tmp();
    const image = new FakeImageProvider();
    const object = new FakeObjectProvider();
    await expect(
      runAssets(scene, { mode: "live", cacheDir: dir, image, object, maxDollars: NaN }),
    ).rejects.toThrow(/positive/);
    await expect(
      runAssets(scene, { mode: "live", cacheDir: dir, image, object, maxDollars: Infinity }),
    ).rejects.toThrow(/positive/);
    expect(image.calls.length).toBe(0);
    expect(object.calls.length).toBe(0);
  });

  it("test_write_failure_not_double_charged", async () => {
    const scene = validated(demoFlat());
    const dir = tmp();
    const refs = sceneAssets(scene);
    const tileRef = refs.find((r) => r.kind !== "object")!;
    writeFailState.failPath = cachePaths(dir, tileRef.key).png;
    try {
      const image = new FakeImageProvider();
      const object = new FakeObjectProvider();
      const rep = await runAssets(scene, { mode: "live", cacheDir: dir, image, object, maxDollars: 1 });
      const rows = ledger(dir).filter((e) => e.key === tileRef.key);
      expect(rows.length).toBe(1);
      expect(rep.missing).toContain(tileRef.id);
    } finally {
      writeFailState.failPath = null;
    }
  });

  it("test_glb_write_failure_not_double_charged", async () => {
    const scene = validated(demoFlat());
    const dir = tmp();
    const refs = sceneAssets(scene);
    const objectRef = refs.find((r) => r.kind === "object")!;
    writeFailState.failPath = cachePaths(dir, objectRef.key).glb;
    try {
      const image = new FakeImageProvider();
      const object = new FakeObjectProvider();
      const rep = await runAssets(scene, { mode: "live", cacheDir: dir, image, object, maxDollars: 1 });
      expect(object.calls.filter((c) => c.name === objectRef.id).length).toBe(1);
      expect(ledger(dir).filter((e) => e.key === objectRef.key).length).toBe(2); // image row + one mesh row
      expect(rep.missing).toContain(objectRef.id);
    } finally {
      writeFailState.failPath = null;
    }
  });

  it("test_stop_mid_batch", async () => {
    const scene = validated(demoFlat());
    const dir = tmp();
    const image = new FakeImageProvider();
    const object = new FlakyObjectProvider("p_sofa", 1);
    const rep = await runAssets(scene, { mode: "live", cacheDir: dir, image, object, maxDollars: 0.85 });
    expect(object.calls.length).toBe(5);
    expect(rep.missing).toEqual(["p_sofa"]);
    expect(ledger(dir).reduce((s, e) => s + e.cents, 0)).toBeLessThanOrEqual(85);
  });

  it("test_one_failure_isolated", async () => {
    const scene = validated(demoFlat());
    const dir = tmp();
    const image = new FakeImageProvider();
    const object = new FlakyObjectProvider("p_vase", 99);
    const rep = await runAssets(scene, { mode: "live", cacheDir: dir, image, object, maxDollars: 2 });
    expect(rep.missing).toEqual(["p_vase"]);
    expect(rep.used.length).toBe(9);
    for (const ref of sceneAssets(scene)) {
      if (ref.id === "p_vase") continue;
      const p = cachePaths(dir, ref.key);
      expect(existsSync(ref.kind === "object" ? p.glb : p.png)).toBe(true);
    }
  });

  it("test_image_concurrency_cap", async () => {
    const scene = validated(manyTiles(20));
    const refs = sceneAssets(scene);
    expect(refs.length).toBe(30);
    expect(totalCents(refs)).toBe(105);
    const dir = tmp();
    const image = new SlowImageProvider();
    const rep = await runAssets(scene, { mode: "live", cacheDir: dir, image, object: new FakeObjectProvider(), maxDollars: 2 });
    expect(image.calls.length).toBe(30);
    expect(image.peak).toBe(16);
    expect(rep.cents).toBe(105);
  });

  it("test_key_not_leaked", async () => {
    const KEY = "sk-test-LEAK";
    const server = createServer((req, res) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(`upstream refused: authorization=${req.headers.authorization ?? ""}`);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const prev = process.env.META_MODEL_API_KEY;
    process.env.META_MODEL_API_KEY = KEY;
    const logs: string[] = [];
    const log = console.log;
    const err = console.error;
    console.log = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
    console.error = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
    try {
      const { report, ctx } = runCheck(demoFlat());
      const dir = tmp();
      const out = join(tmp(), "dist");
      const rep = await runAssets(ctx.scene, {
        mode: "live",
        cacheDir: dir,
        image: new MuseImageProvider({ baseUrl: `http://127.0.0.1:${port}` }),
        object: new FakeObjectProvider(),
        maxDollars: 2,
      });
      expect(rep.used).toEqual([]);
      expect(rep.missing.length).toBe(10);
      const { writeDist } = await import("../src/build/write.js");
      await writeDist(ctx, report, out, { startedAt: Date.now(), assets: rep, cacheDir: dir });
      const haystacks = [
        JSON.stringify(rep),
        readFileSync(join(out, "build.json"), "utf-8"),
        logs.join("\n"),
        ...readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf-8")),
      ];
      for (const h of haystacks) expect(h).not.toContain(KEY);
    } finally {
      console.log = log;
      console.error = err;
      if (prev === undefined) delete process.env.META_MODEL_API_KEY;
      else process.env.META_MODEL_API_KEY = prev;
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("test_malformed_image_rejected", async () => {
    const server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ b64_json: "" }] }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const prev = process.env.META_MODEL_API_KEY;
    process.env.META_MODEL_API_KEY = "sk-test";
    try {
      const provider = new MuseImageProvider({ baseUrl: `http://127.0.0.1:${port}` });
      await expect(provider.generate("a tile", "512x512")).rejects.toThrow();
    } finally {
      if (prev === undefined) delete process.env.META_MODEL_API_KEY;
      else process.env.META_MODEL_API_KEY = prev;
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("test_mesh_starts_with_its_image", async () => {
    class ObjectFirstImage implements ImageProvider {
      readonly slowEnds: number[] = [];
      async generate(prompt: string, _size: ImageSize): Promise<Buffer> {
        const slow = !prompt.startsWith("single object");
        await new Promise((r) => setTimeout(r, slow ? 100 : 5));
        if (slow) this.slowEnds.push(Date.now());
        return fakePng(4, 4, [1, 2, 3], true);
      }
    }
    class SlowMesh implements ObjectProvider {
      readonly calls: { name: string }[] = [];
      readonly starts: number[] = [];
      live = 0;
      peak = 0;
      async mesh(_png: Buffer, name: string): Promise<Buffer> {
        this.calls.push({ name });
        this.starts.push(Date.now());
        this.live++;
        this.peak = Math.max(this.peak, this.live);
        await new Promise((r) => setTimeout(r, 50));
        this.live--;
        return fakeGlb();
      }
    }
    const scene = validated(demoFlat());
    const dir = tmp();
    const image = new ObjectFirstImage();
    const object = new SlowMesh();
    const rep = await runAssets(scene, { mode: "live", cacheDir: dir, image, object, maxDollars: 1 });
    expect(rep.missing).toEqual([]);
    expect(object.calls.length).toBe(5);
    // Every mesh has to start well before the first slow (tile/decal) image
    // call finishes — proof it doesn't wait for the whole image pool to drain.
    const firstSlowEnd = Math.min(...image.slowEnds);
    expect(Math.max(...object.starts)).toBeLessThan(firstSlowEnd);
    // Meshes have to run concurrently with each other, not one after another.
    expect(object.peak).toBeGreaterThanOrEqual(2);
  });

  it("test_mesh_retry_reuses_cached_image", async () => {
    const scene = validated(demoFlat());
    const dir = tmp();
    const image = new FakeImageProvider();
    const object1 = new FlakyObjectProvider("p_sofa", 99);
    const rep1 = await runAssets(scene, { mode: "live", cacheDir: dir, image, object: object1, maxDollars: 2 });
    expect(rep1.missing).toEqual(["p_sofa"]);
    const imageCallsAfterRun1 = image.calls.length;
    const ref = sceneAssets(scene).find((r) => r.id === "p_sofa")!;
    expect(existsSync(cachePaths(dir, ref.key).src)).toBe(true);

    const object2 = new FlakyObjectProvider("p_sofa", 0);
    const rep2 = await runAssets(scene, { mode: "live", cacheDir: dir, image, object: object2, maxDollars: 0.15 });
    expect(image.calls.length).toBe(imageCallsAfterRun1);
    expect(rep2.missing).toEqual([]);
  });

  it("test_full_cache_no_key_needed", () => {
    const scene = validated(demoFlat());
    const dir = tmp();
    fillCache(dir, sceneAssets(scene));
    expect(missingAssets(scene, dir)).toEqual([]);
    const prevKey = process.env.META_MODEL_API_KEY;
    delete process.env.META_MODEL_API_KEY;
    try {
      const r = cli(["build", DEMO, "--out", join(tmp(), "dist"), "--assets", "live", "--max-dollars", "1", "--cache", dir]);
      expect(r.status).toBe(0);
    } finally {
      if (prevKey !== undefined) process.env.META_MODEL_API_KEY = prevKey;
    }
  });

  it("test_muse_no_retry_on_permanent_error", async () => {
    let hits = 0;
    const server = createServer((_req, res) => {
      hits++;
      res.writeHead(401);
      res.end("no");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const prevKey = process.env.META_MODEL_API_KEY;
    process.env.META_MODEL_API_KEY = "sk-test";
    try {
      const scene = validated(demoFlat());
      const dir = tmp();
      const rep = await runAssets(scene, {
        mode: "live",
        cacheDir: dir,
        maxDollars: 1,
        image: new MuseImageProvider({ baseUrl: `http://127.0.0.1:${port}` }),
        object: new FakeObjectProvider(),
      });
      expect(hits).toBe(10);
      expect(rep.missing.length).toBe(10);
    } finally {
      if (prevKey === undefined) delete process.env.META_MODEL_API_KEY;
      else process.env.META_MODEL_API_KEY = prevKey;
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("test_muse_rejects_invalid_image_bytes", async () => {
    let hits = 0;
    const server = createServer((_req, res) => {
      hits++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ b64_json: Buffer.from("not a png").toString("base64") }] }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const prevKey = process.env.META_MODEL_API_KEY;
    process.env.META_MODEL_API_KEY = "sk-test";
    try {
      const scene = validated(demoFlat());
      const dir = tmp();
      const rep = await runAssets(scene, {
        mode: "live",
        cacheDir: dir,
        maxDollars: 1,
        image: new MuseImageProvider({ baseUrl: `http://127.0.0.1:${port}` }),
        object: new FakeObjectProvider(),
      });
      expect(hits).toBe(10);
      expect(rep.missing.length).toBe(10);
    } finally {
      if (prevKey === undefined) delete process.env.META_MODEL_API_KEY;
      else process.env.META_MODEL_API_KEY = prevKey;
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("test_muse_retries_on_5xx", async () => {
    let hits = 0;
    const server = createServer((_req, res) => {
      hits++;
      res.writeHead(503);
      res.end("retry");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const prevKey = process.env.META_MODEL_API_KEY;
    process.env.META_MODEL_API_KEY = "sk-test";
    try {
      const scene = validated(demoFlat());
      const dir = tmp();
      const rep = await runAssets(scene, {
        mode: "live",
        cacheDir: dir,
        maxDollars: 1,
        image: new MuseImageProvider({ baseUrl: `http://127.0.0.1:${port}` }),
        object: new FakeObjectProvider(),
      });
      expect(hits).toBe(20);
      expect(rep.missing.length).toBe(10);
    } finally {
      if (prevKey === undefined) delete process.env.META_MODEL_API_KEY;
      else process.env.META_MODEL_API_KEY = prevKey;
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("test_muse_classifies_retryable_errors", async () => {
    const permServer = createServer((_req, res) => {
      res.writeHead(401);
      res.end("no");
    });
    await new Promise<void>((r) => permServer.listen(0, "127.0.0.1", r));
    const permPort = (permServer.address() as { port: number }).port;
    const tempServer = createServer((_req, res) => {
      res.writeHead(503);
      res.end("retry");
    });
    await new Promise<void>((r) => tempServer.listen(0, "127.0.0.1", r));
    const tempPort = (tempServer.address() as { port: number }).port;
    const prevKey = process.env.META_MODEL_API_KEY;
    process.env.META_MODEL_API_KEY = "sk-test";
    try {
      const permProvider = new MuseImageProvider({ baseUrl: `http://127.0.0.1:${permPort}` });
      let permErr: unknown;
      try {
        await permProvider.generate("x", "1024x1024");
      } catch (e) {
        permErr = e;
      }
      expect(permErr).toBeInstanceOf(Error);
      expect(permErr).not.toBeInstanceOf(RetryableError);

      const tempProvider = new MuseImageProvider({ baseUrl: `http://127.0.0.1:${tempPort}` });
      let tempErr: unknown;
      try {
        await tempProvider.generate("x", "1024x1024");
      } catch (e) {
        tempErr = e;
      }
      expect(tempErr).toBeInstanceOf(RetryableError);
    } finally {
      if (prevKey === undefined) delete process.env.META_MODEL_API_KEY;
      else process.env.META_MODEL_API_KEY = prevKey;
      await new Promise<void>((r) => permServer.close(() => r()));
      await new Promise<void>((r) => tempServer.close(() => r()));
    }
  });

  it("test_muse_image_timeout", async () => {
    const server = createServer(() => {
      // never responds
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const prevKey = process.env.META_MODEL_API_KEY;
    process.env.META_MODEL_API_KEY = "sk-test";
    try {
      const provider = new MuseImageProvider({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 50 });
      const start = Date.now();
      await expect(provider.generate("x", "1024x1024")).rejects.toThrow();
      expect(Date.now() - start).toBeLessThan(1000);
    } finally {
      if (prevKey === undefined) delete process.env.META_MODEL_API_KEY;
      else process.env.META_MODEL_API_KEY = prevKey;
      server.closeAllConnections?.();
      server.close();
    }
  });

  it("test_sam3d_timeout", async () => {
    const server = createServer(() => {
      // never responds
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const prevKey = process.env.META_MODEL_API_KEY;
    process.env.META_MODEL_API_KEY = "sk-test";
    try {
      const provider = new Sam3dProvider({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 50 });
      const start = Date.now();
      await expect(provider.mesh(fakePng(1, 1, [1, 1, 1]), "x")).rejects.toThrow();
      expect(Date.now() - start).toBeLessThan(1000);
    } finally {
      if (prevKey === undefined) delete process.env.META_MODEL_API_KEY;
      else process.env.META_MODEL_API_KEY = prevKey;
      server.closeAllConnections?.();
      server.close();
    }
  });

  it("test_muse_api_key_only_from_env", async () => {
    let seenAuth = "";
    const server = createServer((req, res) => {
      seenAuth = req.headers.authorization ?? "";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ b64_json: fakePng(1, 1, [1, 1, 1]).toString("base64") }] }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const prevKey = process.env.META_MODEL_API_KEY;
    process.env.META_MODEL_API_KEY = "sk-env-key";
    try {
      const provider = new MuseImageProvider({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "sk-should-be-ignored" } as any);
      await provider.generate("x", "1024x1024");
      expect(seenAuth).toBe("Bearer sk-env-key");
    } finally {
      if (prevKey === undefined) delete process.env.META_MODEL_API_KEY;
      else process.env.META_MODEL_API_KEY = prevKey;
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("test_sam3d_api_key_only_from_env", async () => {
    let seenAuth = "";
    const server = createServer((req, res) => {
      seenAuth = req.headers.authorization ?? "";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ b64_glb: fakeGlb().toString("base64") }] }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const prevKey = process.env.META_MODEL_API_KEY;
    process.env.META_MODEL_API_KEY = "sk-env-key-2";
    try {
      const provider = new Sam3dProvider({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "sk-ignored" } as any);
      await provider.mesh(fakePng(1, 1, [1, 1, 1]), "test");
      expect(seenAuth).toBe("Bearer sk-env-key-2");
    } finally {
      if (prevKey === undefined) delete process.env.META_MODEL_API_KEY;
      else process.env.META_MODEL_API_KEY = prevKey;
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("test_muse_rejects_signature_only_png", async () => {
    const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ b64_json: PNG_SIGNATURE.toString("base64") }] }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const prevKey = process.env.META_MODEL_API_KEY;
    process.env.META_MODEL_API_KEY = "sk-test";
    try {
      const provider = new MuseImageProvider({ baseUrl: `http://127.0.0.1:${port}` });
      await expect(provider.generate("a tile", "1024x1024")).rejects.toThrow();
    } finally {
      if (prevKey === undefined) delete process.env.META_MODEL_API_KEY;
      else process.env.META_MODEL_API_KEY = prevKey;
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("test_partial_write_isolated_not_used", async () => {
    const scene = validated(demoFlat());
    const dir = tmp();
    const refs = sceneAssets(scene);
    const tileRef = refs.find((r) => r.kind !== "object")!;
    writeFailState.failPath = cachePaths(dir, tileRef.key).png;
    writeFailState.partial = true;
    try {
      const image = new FakeImageProvider();
      const object = new FakeObjectProvider();
      const rep = await runAssets(scene, { mode: "live", cacheDir: dir, image, object, maxDollars: 1 });
      expect(rep.missing).toContain(tileRef.id);
      expect(rep.used).not.toContain(tileRef.id);
    } finally {
      writeFailState.failPath = null;
      writeFailState.partial = false;
    }
  });
});
