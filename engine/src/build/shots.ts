import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { mark } from "../report/timing.js";
import { shotBaseNames } from "./shotnames.js";

function shotFileNames(cameras: GeoCamera[]): string[] {
  return shotBaseNames(cameras).map((n) => `${n}.png`);
}

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
    // `close()` alone waits for every keep-alive socket to idle out (5 s by
    // default), and a chromium still shutting down after its close grace
    // holds one: drop them, every file has been served by now
    close: () =>
      new Promise<void>((ok) => {
        server.close(() => ok());
        server.closeAllConnections();
      }),
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
 * A relative `href` built from a filename that may contain URL-reserved
 * characters (`#`, `%`, `?`, ...) must have each path segment percent-encoded,
 * or the browser mis-parses it before a request is even sent (e.g. `#` starts
 * a fragment) and the server's single `decodeURIComponent` on the request
 * path exactly undoes this encoding.
 */
function encodeHrefPath(relPath: string): string {
  return relPath.split("/").map(encodeURIComponent).join("/");
}

/**
 * One row per camera with a ref: the ref on the left, the shot taken just now
 * on the right. Cameras without a ref go in a separate list at the bottom.
 */
export function sheetHtml(cameras: GeoCamera[], opts: ShotsOptions): string {
  const names = shotFileNames(cameras);
  const paired: string[] = [];
  const bare: string[] = [];
  cameras.forEach((c, i) => {
    const shotSrc = encodeHrefPath(`shots/${names[i]}`);
    if (!c.ref) {
      bare.push(
        `<div class="row"><div class="cell">` +
          `<img class="pane" src="${shotSrc}"><div class="cap">нет ref</div></div></div>`,
      );
      return;
    }
    paired.push(
      `<div class="row"><div class="cell"><img class="pane" src="${encodeHrefPath(c.ref)}"><div class="cap">ref</div></div>` +
        `<div class="cell"><img class="pane" src="${shotSrc}"><div class="cap">${escapeHtml(c.id)}</div></div></div>`,
    );
  });
  const head = `<div class="cap">${paired.length} из ${cameras.length} камер с референсом</div>`;
  const tail = bare.length > 0 ? `\n<div class="cap">без референса</div>\n${bare.join("\n")}` : "";
  const rows = `${head}\n${paired.join("\n")}${tail}`;
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

/**
 * How long a launched chromium gets to shut down gracefully. Under a loaded
 * machine `browser.close()` was measured taking 12 s on its own (with the ready
 * wait itself bounded to 2 s), which blew `--ready-timeout` deadlines. Every
 * file is already written by the time we close, so there is nothing left to
 * wait for: after the grace the close keeps going in the background, and the
 * CLI's `process.exit` makes Playwright's exit handler kill the process.
 */
export const CLOSE_GRACE_MS = 1000;

export async function closeWithin(browser: Browser, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const closing = browser.close().catch(() => undefined);
  await Promise.race([closing, new Promise<void>((ok) => (timer = setTimeout(ok, ms)))]);
  clearTimeout(timer);
}

export interface RunShotsDeps {
  /** Reuse an already-launched browser instead of starting a new one. */
  browser?: Browser;
  /** Reuse an already-running static server instead of starting a new one. */
  served?: { url: string; close: () => Promise<void> };
  /** Ready wait; replaceable so tests need no real clock. Rejects when the page never gets ready. */
  waitReady?: (page: Page, timeoutMs: number) => Promise<void>;
  /**
   * Clock for the default ready wait; the deadline `readyTimeoutMs` is armed
   * on this clock instead of the real one, so tests advance it by hand.
   * When absent the real `setTimeout`/`clearTimeout` run, as before.
   */
  timers?: ReadyTimers;
}

export interface ReadyTimers {
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

const realTimers: ReadyTimers = {
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (id) => clearTimeout(id as NodeJS.Timeout),
};

/**
 * The page's own wait carries no deadline: the injected clock owns it, so a
 * test that never advances its fake timers never times out either.
 */
const defaultWaitReady = async (page: Page, timeoutMs: number, timers: ReadyTimers = realTimers): Promise<void> => {
  let id: unknown;
  try {
    await Promise.race([
      page.waitForFunction("window.__ready === true", undefined, { timeout: 0 }),
      new Promise<never>((_, reject) => {
        id = timers.setTimeout(() => reject(new Error("timeout")), timeoutMs);
      }),
    ]);
  } finally {
    if (id !== undefined) timers.clearTimeout(id);
  }
};

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
      mark("ready-wait");
      try {
        await (deps.waitReady ?? ((p, t) => defaultWaitReady(p, t, deps.timers)))(page, opts.readyTimeoutMs);
      } catch {
        mark("ready-timeout");
        console.error(`camera ${cam.id}: page never set window.__ready`);
        // no page.close() here: closing the browser below closes the page, and
        // each extra round-trip to a loaded chromium eats into the deadline
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
    if (!deps.browser) await closeWithin(browser, CLOSE_GRACE_MS);
    if (!deps.served) await served.close();
  }
}
