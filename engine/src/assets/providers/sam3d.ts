/**
 * PARKED (11-02, LESSONS L163): dead code. There is no SAM3D on the Meta API, so
 * this HTTP provider never worked and `build --assets live` falls back to boxes
 * for every object. Live meshes go through pipe2 (`AssetQueue` -> SAM3D on Modal)
 * into the cache, then `dreamer build --assets cache`. Do not extend this file;
 * remove it or make `live` fail loudly when the engine is next touched.
 */
import type { ObjectProvider } from "./types.js";

export const SAM3D_BASE_URL = "https://api.meta-models.ai";
export const SAM3D_MODEL = "meta-models/sam-3d-objects";

export const SAM3D_TIMEOUT_MS = 120_000;

export interface Sam3dOpts {
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
}

/** SAM3D over HTTP: one reference image in, one GLB out. Errors never quote
 * the body. The key is read only from `process.env` — never accepted as a
 * constructor option. */
export class Sam3dProvider implements ObjectProvider {
  private readonly key: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(opts: Sam3dOpts = {}) {
    const key = process.env.META_MODEL_API_KEY ?? "";
    if (key === "") throw new Error("assets: live needs META_MODEL_API_KEY");
    this.key = key;
    this.baseUrl = (opts.baseUrl ?? process.env.META_MODEL_BASE_URL ?? SAM3D_BASE_URL).replace(/\/$/, "");
    this.model = opts.model ?? SAM3D_MODEL;
    this.timeoutMs = opts.timeoutMs ?? SAM3D_TIMEOUT_MS;
  }

  async mesh(png: Buffer, name: string): Promise<Buffer> {
    const res = await fetch(`${this.baseUrl}/v1/3d/generations`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: this.model, name, image: png.toString("base64"), format: "glb" }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`sam3d: HTTP ${res.status}`);
    const body = (await res.json()) as { data?: { b64_glb?: string; url?: string }[] };
    const first = body?.data?.[0];
    if (first?.b64_glb !== undefined) return Buffer.from(first.b64_glb, "base64");
    if (typeof first?.url === "string") {
      const glb = await fetch(first.url, { signal: AbortSignal.timeout(this.timeoutMs) });
      if (!glb.ok) throw new Error(`sam3d: mesh HTTP ${glb.status}`);
      return Buffer.from(await glb.arrayBuffer());
    }
    throw new Error("sam3d: response has no mesh");
  }
}
