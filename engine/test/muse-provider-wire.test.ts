import { afterEach, describe, expect, it, vi } from "vitest";
import { PNG } from "pngjs";
import { MuseImageProvider } from "../src/assets/providers/muse-image.js";

// The live Muse Image API (as pipe2 calls it): api.meta.ai, model muse-image-1.0, `size: "WxH"`.
// It rejects `width`/`height` with 400 "unknown parameter", and api.meta-models.ai does not resolve.
const png = PNG.sync.write(new PNG({ width: 1, height: 1 }));

describe("MuseImageProvider wire format", () => {
  const old = { key: process.env.META_MODEL_API_KEY, url: process.env.META_MODEL_BASE_URL };
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env.META_MODEL_API_KEY = old.key;
    if (old.url === undefined) delete process.env.META_MODEL_BASE_URL;
    else process.env.META_MODEL_BASE_URL = old.url;
  });

  it("posts to api.meta.ai with model muse-image-1.0 and size WxH", async () => {
    process.env.META_MODEL_API_KEY = "k";
    delete process.env.META_MODEL_BASE_URL;
    const seen: { url: string; body: any }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: any) => {
      seen.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }), { status: 200 });
    });
    await new MuseImageProvider().generate("an apple", "1024x1024");
    expect(seen[0].url).toBe("https://api.meta.ai/v1/images/generations");
    expect(seen[0].body).toEqual({ model: "muse-image-1.0", prompt: "an apple", n: 1, size: "1024x1024" });
  });
});
