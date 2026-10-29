import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium, type Browser } from "playwright";
import { CLOSE_GRACE_MS, closeWithin } from "../../src/build/shots.js";

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".glb": "model/gltf-binary",
};

export interface Served {
  url: string;
  /** Hold every response for `path` until the returned release is called. */
  gate(path: string): () => void;
  close(): Promise<void>;
}

/** Static server for a dist/ directory on an ephemeral port. */
export async function serve(dir: string): Promise<Served> {
  const gates = new Map<string, Promise<void>>();
  const server: Server = createServer(async (req, res) => {
    const rel = normalize(decodeURIComponent((req.url ?? "/").split("?")[0])).replace(/^(\.\.[/\\])+/, "");
    const name = rel === "/" || rel === "\\" ? "index.html" : rel.replace(/^[/\\]/, "");
    const hold = gates.get(`/${name}`);
    if (hold) await hold;
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
    gate(path: string): () => void {
      let release = (): void => {};
      gates.set(path, new Promise<void>((ok) => (release = ok)));
      return () => {
        gates.delete(path);
        release();
      };
    },
    close(): Promise<void> {
      // without dropping open sockets, close() waits for a still-open
      // browser's keep-alive connections to time out
      return new Promise<void>((ok) => {
        server.close(() => ok());
        server.closeAllConnections();
      });
    },
  };
}

export function launch(): Promise<Browser> {
  return chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
}

/**
 * Test teardown's browser close, bounded the way `runShots` bounds its own:
 * a loaded machine was seen taking over 10 s in `browser.close()`, past the
 * `afterAll` hook limit, with every assertion already done. After the grace
 * the close keeps going and the worker's exit kills what is left.
 */
export async function closeBrowser(browser: Browser | undefined): Promise<void> {
  if (browser) await closeWithin(browser, CLOSE_GRACE_MS);
}
