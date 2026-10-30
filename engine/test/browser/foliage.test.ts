import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { PNG } from "pngjs";
import type { Browser } from "playwright";
import { normalizeGlb } from "../../src/assets/glb.js";
import { launch, closeBrowser } from "./serve.js";

const ENGINE = fileURLToPath(new URL("../../", import.meta.url));
const OAK = fileURLToPath(new URL("../fixtures/oak_tripo.glb", import.meta.url));

let browser: Browser | undefined;
let server: Server;
let url = "";

beforeAll(async () => {
  try {
    browser = await launch();
  } catch (e) {
    // Skip only when Chromium is not installed here; a real launch failure
    // (bad flags, crash) must fail the test, not hide as a skip.
    if (e instanceof Error && /executable|not installed|ENOENT/i.test(e.message)) return;
    throw e;
  }
  const out = await build({
    entryPoints: [fileURLToPath(new URL("./oak-entry.ts", import.meta.url))],
    bundle: true,
    write: false,
    format: "iife",
    absWorkingDir: ENGINE,
  });
  const js = out.outputFiles[0].text.replace(/<\/script/g, "<\\/script");
  server = createServer((req, res) => {
    if (req.url === "/oak.glb") res.end(normalizeGlb(readFileSync(OAK), 0, { foliage: true }).glb);
    else {
      res.setHeader("content-type", "text/html");
      res.end(`<body><script>${js}</script>`);
    }
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
}, 30000);

afterAll(async () => {
  if (browser) await closeBrowser(browser);
  server?.closeAllConnections();
  server?.close();
});

describe("oak foliage in the page", () => {
  it("test_oak_crown_has_no_black_pixels", async (ctx) => {
    if (!browser) return ctx.skip();
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    try {
      await page.goto(url);
      const data: string = await page.evaluate(`window.shoot("/oak.glb")`);
      const png = PNG.sync.read(Buffer.from(data.split(",")[1], "base64"));
      // Crown region from the oak's own silhouette (F9/F11/F14/F16): per
      // row, the drawn (non-white) span. The canopy is the wide part of the
      // tree, the trunk the narrow part, so the crown is every row from the
      // top of the tree down to the LAST row at least 35% as wide as the
      // widest row — lower canopy leaves included, the trunk below excluded.
      // Within that band every drawn pixel is checked; the contract forbids
      // exact pure black (0,0,0), which lit bark never renders as while the
      // uncut leaf shards did.
      const white = (i: number) => png.data[i] > 250 && png.data[i + 1] > 250 && png.data[i + 2] > 250;
      const rowWidth: number[] = [];
      let minY = png.height, maxY = -1;
      for (let y = 0; y < png.height; y++) {
        let lo = png.width, hi = -1;
        for (let x = 0; x < png.width; x++) {
          if (white((y * png.width + x) * 4)) continue;
          if (x < lo) lo = x;
          hi = x;
        }
        rowWidth.push(hi - lo + 1);
        if (hi >= 0) {
          if (y < minY) minY = y;
          maxY = y;
        }
      }
      // The measured region really is the oak: it fills most of the frame.
      expect(maxY - minY).toBeGreaterThan(png.height * 0.5);
      const widest = Math.max(...rowWidth);
      let crownBottom = minY;
      for (let y = minY; y <= maxY; y++) if (rowWidth[y] >= widest * 0.35) crownBottom = y;
      let drawn = 0;
      let crownDrawn = 0;
      let black = 0;
      for (let y = minY; y <= maxY; y++) {
        for (let x = 0; x < png.width; x++) {
          const i = (y * png.width + x) * 4;
          if (white(i)) continue;
          drawn++;
          if (y > crownBottom) continue;
          crownDrawn++;
          if (png.data[i] === 0 && png.data[i + 1] === 0 && png.data[i + 2] === 0) black++;
        }
      }
      expect(drawn).toBeGreaterThan(1000); // the oak is actually there
      // the band is the crown, and it holds the bulk of the tree: what is
      // left below it is only the narrow trunk
      expect(crownDrawn).toBeGreaterThan(drawn * 0.7);
      expect(crownBottom - minY).toBeGreaterThan((maxY - minY) * 0.4);
      expect(black).toBe(0);
    } finally {
      await page.close();
    }
  }, 60000);

  it("test_unmarked_dark_texture_keeps_alpha", async (ctx) => {
    // F8/F12: a real decodable dark texture on an ordinary (unmarked) prop
    // through the page's own cutDarkTexels — dark texels stay opaque. The
    // marked foliage case is the positive control: its dark texel is cut.
    if (!browser) return ctx.skip();
    const page = await browser.newPage();
    try {
      await page.goto(url);
      const plain: number[] = await page.evaluate(`window.probeCutout(false)`);
      expect(plain[0]).toBe(255);
      expect(plain[1]).toBe(255);
      const cut: number[] = await page.evaluate(`window.probeCutout(true)`);
      expect(cut[0]).toBe(0);
      expect(cut[1]).toBe(255);
    } finally {
      await page.close();
    }
  }, 60000);
});
