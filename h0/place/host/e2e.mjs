// End-to-end check of a voice wish in a built place (run from engine/ so playwright resolves):
//   node ../h0/place/host/e2e.mjs http://localhost:18811/ "<wish text>" <out dir> [wav]
// With a wav the wish goes through the real mic path's server half (/asr), else it is typed (__wish).
import { createRequire } from "node:module";
const { chromium } = createRequire(new URL("../../../engine/package.json", import.meta.url))("playwright");
import fs from "node:fs";
const [url, text, out, wav] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ["--use-gl=angle"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") console.log("page:", m.text().slice(0, 200)); });
await page.goto(url);
await page.waitForFunction(() => window.__dreamer && window.__wish, null, { timeout: 120000 });
await page.waitForTimeout(1500);
let wish = text;
if (wav) {
  const r = await fetch(new URL("/asr", url), { method: "POST", headers: { "Content-Type": "audio/wav" }, body: fs.readFileSync(wav) }).then((x) => x.json());
  console.log("asr:", r);
  wish = r.text;
}
// face the house wall from the yard (house is at -z... we look toward +z where n = 0)
await page.evaluate((t) => { window.__wish(t); }, wish);
const t0 = Date.now();
let placed = false, shots = 0, last = null;
for (;;) {
  const st = await page.evaluate(() => [...document.querySelectorAll("#bar .pct, #bar .st")].map((e) => e.textContent).join(" | "));
  if (st !== last) { console.log(((Date.now() - t0) / 1000).toFixed(1) + "s", st); last = st; }
  if (!placed) {
    const box = await page.evaluate(async () => {
      const ids = [...document.querySelectorAll("#bar")].length; // noop
      return null;
    });
  }
  const parts = fs.readdirSync(new URL("../../../runs/yard-kozb7/parts/", import.meta.url)).sort();
  const pct = parseFloat(st) || 0;
  if (!placed && st.includes("%")) {
    // stand 9 m out in the yard in front of the site
    const j = await fetch(new URL("/part/" + parts[parts.length - 1], url)).then((x) => x.json());
    if (j.box) {
      const cx = (j.box.x0 + j.box.x1) / 2, z = j.box.z0 - 8;
      await page.evaluate(([x, z]) => { window.__dreamer.teleport(x, z); }, [cx, z]);
      for (const yaw of [0, 90, 180, 270]) {
        await page.evaluate((y) => window.__dreamer.look(y * Math.PI / 180), yaw);
        const d = await page.evaluate(() => window.__dreamer.camera().dir);
        if (d[2] > 0.9) { console.log("yaw", yaw); break; }
      }
      placed = true;
    }
  }
  if (placed && ((shots === 0 && pct > 30) || (shots === 1 && pct > 70))) {
    await page.screenshot({ path: `${out}/build_${shots}.png` }); shots++;
  }
  if (/Ready in|Failed/.test(st)) break;
  if (Date.now() - t0 > 600000) { console.log("timeout"); break; }
  await page.waitForTimeout(1000);
}
await page.waitForTimeout(1200);
await page.screenshot({ path: `${out}/reveal.png` });
await page.waitForTimeout(2500);
await page.screenshot({ path: `${out}/after.png` });
await browser.close();
