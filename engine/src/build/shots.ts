import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { chromium, type Browser } from "playwright";

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".glb": "model/gltf-binary",
};

export interface ShotsOptions {
  width: number;
  height: number;
  /** How long a camera may take to reach `window.__ready`, in milliseconds. */
  readyTimeoutMs: number;
}

export const SHOTS_DEFAULTS: ShotsOptions = { width: 1280, height: 720, readyTimeoutMs: 20000 };

interface GeoCamera {
  id: string;
  ref?: string | null;
}

/**
 * `fetch` refuses file:// URLs, so the page can never load geometry.json off
 * disk: every shot is taken over a throwaway local server on an ephemeral port.
 */
export async function serveDist(dir: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer(async (req, res) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent((req.url ?? "/").split("?")[0]);
    } catch {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("bad request");
      return;
    }
    const rel = normalize(decoded).replace(/^(\.\.[/\\])+/, "");
    const name = rel === "/" || rel === "\\" ? "index.html" : rel.replace(/^[/\\]/, "");
    try {
      const body = await readFile(join(dir, name));
      res.writeHead(200, { "content-type": MIME[extname(name)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    }
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise<void>((ok) => server.close(() => ok())),
  };
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Safe for both text content and a double-quoted attribute value. */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]!);
}

/**
 * The contract is `shots/<camera id>.png`, so an id that is already a legal
 * filename is kept verbatim (`front:view` -> `front:view.png`); only what
 * would make the name point somewhere else is replaced: path separators,
 * control characters, and the two names that mean a directory (`.`, `..`).
 * Distinct ids can sanitize to the same string (e.g. `room/left` and
 * `room_left`), so a colliding base gets its index appended; that suffixed
 * name is itself checked against every name already assigned (including
 * another camera's literal id, e.g. `room_left-0`), and grows a further
 * `-<index>` suffix until it is unique. An id with no collision at all keeps
 * its plain name.
 */
function shotFileNames(cameras: GeoCamera[]): string[] {
  const base = cameras.map((c) => {
    const safe = c.id.replace(/[/\\\x00-\x1f]/g, "_");
    return safe === "" || safe === "." || safe === ".." ? `_${safe}` : safe;
  });
  const counts = new Map<string, number>();
  for (const b of base) counts.set(b, (counts.get(b) ?? 0) + 1);
  const used = new Set<string>();
  return base.map((b, i) => {
    let name = (counts.get(b) ?? 0) > 1 ? `${b}-${i}` : b;
    while (used.has(name)) name = `${name}-${i}`;
    used.add(name);
    return `${name}.png`;
  });
}

/**
 * A relative `href` built from a filename that may contain URL-reserved
 * characters (`#`, `%`, `?`, ...) must have each path segment percent-encoded,
 * or the browser mis-parses it before a request is even sent (e.g. `#` starts
 * a fragment) and the server's single `decodeURIComponent` on the request
 * path exactly undoes this encoding.
 */
function encodeHrefPath(relPath: string): string {
  return relPath.split("/").map(encodeURIComponent).join("/");
}

/** One row per camera: the ref on the left, the shot taken just now on the right. */
export function sheetHtml(cameras: GeoCamera[], opts: ShotsOptions): string {
  const names = shotFileNames(cameras);
  const rows = cameras
    .map((c, i) => {
      const shotSrc = encodeHrefPath(`shots/${names[i]}`);
      if (!c.ref) {
        return (
          `<div class="row"><div class="cell">` +
          `<img class="pane" src="${shotSrc}"><div class="cap">нет ref</div></div></div>`
        );
      }
      return (
        `<div class="row"><div class="cell"><img class="pane" src="${encodeHrefPath(c.ref)}"><div class="cap">ref</div></div>` +
        `<div class="cell"><img class="pane" src="${shotSrc}"><div class="cap">${escapeHtml(c.id)}</div></div></div>`
      );
    })
    .join("\n");
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>sheet</title>
<link rel="icon" href="data:,">
<style>
  body { margin: 0; background: #111; color: #ddd; font: 14px sans-serif; }
  .row { display: flex; gap: 8px; padding: 8px; }
  .cell { width: ${opts.width}px; }
  .pane { width: ${opts.width}px; height: ${opts.height}px; object-fit: contain; background: #000; display: block; }
  .none { display: flex; align-items: center; justify-content: center; color: #888; }
  .cap { padding: 4px 0; }
</style></head>
<body>
${rows}
</body></html>
`;
}

/**
 * The plan svg sizes itself in svg user units, which can be fractional; a
 * viewport is whole pixels, so the png is the svg rounded down (and never
 * degenerate).
 */
function svgPixelSize(svg: string): { width: number; height: number } {
  const tag = /<svg\b[^>]*>/.exec(svg)?.[0] ?? "";
  const num = (attr: string): number => Number(new RegExp(`\\s${attr}="([\\d.]+)"`).exec(tag)?.[1] ?? NaN);
  const w = Math.floor(num("width"));
  const h = Math.floor(num("height"));
  if (!Number.isFinite(w) || w <= 0 || !Number.isFinite(h) || h <= 0) {
    throw new Error(`top.svg has no valid width/height (got width=${num("width")}, height=${num("height")})`);
  }
  return { width: w, height: h };
}

/**
 * `build` and `check` never open a browser, so the labelled plan is rasterized
 * here. The svg is inlined into a blank page instead of being fetched from the
 * dist server: served with an unknown MIME type a browser downloads an svg
 * rather than drawing it, and the markup is already on disk next to us.
 */
async function renderTopPng(dist: string, browser: Browser): Promise<void> {
  const svgPath = join(dist, "top.svg");
  let svg: string;
  try {
    svg = readFileSync(svgPath, "utf-8");
  } catch (e) {
    throw new Error(`cannot read ${svgPath}: ${String(e)}`);
  }
  const size = svgPixelSize(svg);
  const page = await browser.newPage({ viewport: size, deviceScaleFactor: 1 });
  try {
    await page.setContent(
      `<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,">` +
        `<style>html,body{margin:0;background:#fff}svg{display:block}</style></head>` +
        `<body>${svg}</body></html>`,
    );
    await page.screenshot({ path: join(dist, "top.png") });
  } finally {
    await page.close();
  }
}

export interface RunShotsDeps {
  /** Reuse an already-launched browser instead of starting a new one. */
  browser?: Browser;
  /** Reuse an already-running static server instead of starting a new one. */
  served?: { url: string; close: () => Promise<void> };
}

/**
 * Screenshots every camera of an already built `dist/` and lays the shots out
 * next to their refs. Returns the process exit code: 2 if any camera never
 * reached `__ready`, which is the only way a shot can be silently empty.
 */
export async function runShots(
  dist: string,
  opts: ShotsOptions = SHOTS_DEFAULTS,
  deps: RunShotsDeps = {},
): Promise<number> {
  let geometry: { cameras?: GeoCamera[] };
  try {
    geometry = JSON.parse(readFileSync(join(dist, "geometry.json"), "utf-8"));
  } catch (e) {
    console.error(`cannot read ${join(dist, "geometry.json")}: ${String(e)}`);
    return 2;
  }
  const cameras = geometry.cameras ?? [];
  const names = shotFileNames(cameras);
  writeFileSync(join(dist, "sheet.html"), sheetHtml(cameras, opts));
  mkdirSync(join(dist, "shots"), { recursive: true });

  const served = deps.served ?? (await serveDist(dist));
  const browser =
    deps.browser ?? (await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] }));
  try {
    const page = await browser.newPage({
      viewport: { width: opts.width, height: opts.height },
      deviceScaleFactor: 1,
    });
    for (let i = 0; i < cameras.length; i++) {
      const cam = cameras[i]!;
      await page.goto(`${served.url}index.html?cam=${encodeURIComponent(cam.id)}`);
      try {
        await page.waitForFunction("window.__ready === true", undefined, { timeout: opts.readyTimeoutMs });
      } catch {
        console.error(`camera ${cam.id}: page never set window.__ready`);
        await page.close();
        return 2;
      }
      await page.screenshot({ path: join(dist, "shots", names[i]!) });
    }
    await page.close();
    // The sheet is plain HTML snapped by the same browser: no image library
    // has to stitch the rows together.
    const sheet = await browser.newPage({
      viewport: { width: opts.width * 2 + 24, height: opts.height + 48 },
      deviceScaleFactor: 1,
    });
    await sheet.goto(`${served.url}sheet.html`);
    await sheet.screenshot({ path: join(dist, "sheet.png"), fullPage: true });
    await sheet.close();
    try {
      await renderTopPng(dist, browser);
    } catch (e) {
      console.error(String(e));
      return 2;
    }
    return 0;
  } finally {
    if (!deps.browser) await browser.close();
    if (!deps.served) await served.close();
  }
}
