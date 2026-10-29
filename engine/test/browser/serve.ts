import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium, type Browser } from "playwright";

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
      return new Promise<void>((ok) => server.close(() => ok()));
    },
  };
}

export function launch(): Promise<Browser> {
  return chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
}
