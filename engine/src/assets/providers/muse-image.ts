import { PNG } from "pngjs";
import type { ImageSize } from "../templates.js";
import type { ImageProvider } from "./types.js";

export const MUSE_BASE_URL = "https://api.meta-models.ai";
export const MUSE_IMAGE_MODEL = "meta-models/muse-image-1";

export const MUSE_TIMEOUT_MS = 120_000;

export interface MuseImageOpts {
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
}

/** Thrown for failures worth one retry: a transient 5xx, or Muse Image's
 * occasional spurious 400 on an otherwise valid prompt. Anything else
 * (401/403, a malformed response) is permanent and must not be retried. */
export class RetryableError extends Error {}

/** Rejects anything that isn't a complete, decodable PNG, so a 200 with a
 * garbage, truncated, or signature-only payload becomes a permanent failure
 * instead of a cached asset that breaks downstream decal/alpha processing. */
function requirePng(buf: Buffer): Buffer {
  try {
    PNG.sync.read(buf);
  } catch {
    throw new Error("muse-image: invalid image bytes");
  }
  return buf;
}

/**
 * Muse Image over HTTP. The key is read only from `process.env` — never
 * accepted as a constructor option, so it can't come from anywhere else —
 * and it lives in this object and nowhere else: no response body is ever
 * quoted in an error, because an upstream that echoes request headers would
 * otherwise put the key into `build.json`.
 */
export class MuseImageProvider implements ImageProvider {
  private readonly key: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(opts: MuseImageOpts = {}) {
    const key = process.env.META_MODEL_API_KEY ?? "";
    if (key === "") throw new Error("assets: live needs META_MODEL_API_KEY");
    this.key = key;
    this.baseUrl = (opts.baseUrl ?? process.env.META_MODEL_BASE_URL ?? MUSE_BASE_URL).replace(/\/$/, "");
    this.model = opts.model ?? MUSE_IMAGE_MODEL;
    this.timeoutMs = opts.timeoutMs ?? MUSE_TIMEOUT_MS;
  }

  async generate(prompt: string, size: ImageSize): Promise<Buffer> {
    const [width, height] = size.split("x").map(Number);
    const res = await fetch(`${this.baseUrl}/v1/images/generations`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: this.model, prompt, width, height, n: 1, response_format: "b64_json" }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const msg = `muse-image: HTTP ${res.status}`;
      throw res.status === 400 || res.status >= 500 ? new RetryableError(msg) : new Error(msg);
    }
    const body = (await res.json()) as { data?: { b64_json?: string; url?: string }[] };
    const first = body?.data?.[0];
    if (first?.b64_json !== undefined) {
      const buf = Buffer.from(first.b64_json, "base64");
      if (buf.length === 0) throw new Error("muse-image: empty image");
      return requirePng(buf);
    }
    if (typeof first?.url === "string") {
      const png = await fetch(first.url, { signal: AbortSignal.timeout(this.timeoutMs) });
      if (!png.ok) {
        const msg = `muse-image: image HTTP ${png.status}`;
        throw png.status === 400 || png.status >= 500 ? new RetryableError(msg) : new Error(msg);
      }
      const buf = Buffer.from(await png.arrayBuffer());
      if (buf.length === 0) throw new Error("muse-image: empty image");
      return requirePng(buf);
    }
    throw new Error("muse-image: response has no image");
  }

  /** `/v1/images/edits`, as `h0/h13_seam.py` calls it for the sky seam band. */
  async edit(png: Buffer, prompt: string): Promise<Buffer> {
    const form = new FormData();
    form.append("model", this.model);
    form.append("prompt", prompt);
    form.append("response_format", "b64_json");
    form.append("image", new Blob([new Uint8Array(png)], { type: "image/png" }), "img.png");
    const res = await fetch(`${this.baseUrl}/v1/images/edits`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.key}` },
      body: form,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const msg = `muse-image: edit HTTP ${res.status}`;
      throw res.status === 400 || res.status >= 500 ? new RetryableError(msg) : new Error(msg);
    }
    const body = (await res.json()) as { data?: { b64_json?: string }[] };
    const b64 = body?.data?.[0]?.b64_json;
    if (b64 === undefined) throw new Error("muse-image: edit response has no image");
    const buf = Buffer.from(b64, "base64");
    if (buf.length === 0) throw new Error("muse-image: empty image");
    return requirePng(buf);
  }
}
