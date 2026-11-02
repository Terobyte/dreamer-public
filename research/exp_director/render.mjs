// render N deterministic frames of Sonnet's hand demo without a server (files served via route)
import { chromium } from "/Users/terobyte/Desktop/Projects/Active/meta/engine/node_modules/playwright/index.mjs";
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { extname, join } from "node:path";
const [scene, out, n = 9, storyOverride] = process.argv.slice(2);
const ROOT = "/Users/terobyte/Desktop/Projects/Active/anymove/runs/koshakan/demo";
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".glb": "model/gltf-binary", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".ktx2": "image/ktx2", ".wasm": "application/wasm", ".bin": "application/octet-stream" };
const b = await chromium.launch({ args: ["--use-gl=angle", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const p = await b.newPage({ viewport: { width: 640, height: 360 } });
await p.route("http://demo.local/**", (r) => {
  const u = new URL(r.request().url()); const f = storyOverride && u.pathname === "/story.js" ? storyOverride : join(ROOT, decodeURIComponent(u.pathname));
  if (!existsSync(f)) return r.fulfill({ status: 404, body: "" });
  r.fulfill({ status: 200, body: readFileSync(realpathSync(f)), headers: { "content-type": MIME[extname(f)] ?? "application/octet-stream" } });
});
p.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 300)));
await p.goto(`http://demo.local/index.html?scene=${scene}&t=0`);
await p.waitForFunction(() => window.__ready === true, null, { timeout: 180000 });
const total = await p.evaluate((s) => window.__sceneTotal(s), scene);
console.log("total", total);
for (let i = 0; i < n; i++) {
  const t = total * (i + 0.5) / n;
  await p.evaluate(([s, t]) => window.__jump(s, t), [scene, t]); await p.waitForTimeout(300);
  await p.screenshot({ path: `${out}/${String(i).padStart(3, "0")}.png` });
}
await b.close();
