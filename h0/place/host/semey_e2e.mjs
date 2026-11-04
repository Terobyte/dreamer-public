// Live check of the Semey world (run from engine/ so playwright resolves):
//   SEMEY_KEY=<judge key> node ../h0/place/host/semey_e2e.mjs <url> <out dir> [look|build "<wish>" <place>|enter <place>|mobile|nogl]
// look: the yard, all five signs, place 1's door; build: E -> nick -> typed wish -> sure x2 -> waits for built -> walks in, reloads.
import { createRequire } from "node:module";
import fs from "node:fs";
const { chromium, devices } = createRequire(new URL("../../../engine/package.json", import.meta.url))("playwright");
const [url, out, mode = "look", ...rest] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const KEY = process.env.SEMEY_KEY || "";
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const args = mode === "nogl" ? ["--disable-webgl", "--disable-gpu"] : ["--use-gl=angle", "--enable-unsafe-swiftshader"];
const browser = await chromium.launch({ args });
const ctx = mode === "mobile" ? await browser.newContext({ ...devices["iPhone 13"] }) : await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();
const bad = [];
page.on("console", (m) => { if (m.type() === "error") log("page error:", m.text().slice(0, 200)); });
page.on("response", (r) => { if (r.status() >= 400) bad.push(r.status() + " " + r.url()); });
const t0 = Date.now();
await page.goto(url + (url.includes("?") ? "&" : "?") + "k=" + KEY);
const shot = (n) => page.screenshot({ path: `${out}/${n}.png` });
if (mode === "mobile" || mode === "nogl") {
  await page.waitForTimeout(8000);
  log("shell:", await page.evaluate(() => document.getElementById("shell-msg")?.textContent), "visible:", await page.evaluate(() => getComputedStyle(document.getElementById("shell")).display));
  log("video link:", await page.evaluate(() => document.getElementById("shell-video")?.href));
  await shot(mode); await browser.close(); process.exit(0);
}
await page.waitForFunction(() => window.__live, null, { timeout: 180000 });
await page.waitForFunction(() => getComputedStyle(document.getElementById("shell")).display === "none", null, { timeout: 30000 }).catch(() => log("shell still visible"));
log("first frame after", ((Date.now() - t0) / 1000).toFixed(1), "s; address bar:", page.url());
await page.waitForTimeout(2500);
const pose = async (s, n, ls, ln) => { await page.evaluate(([s, n, ls, ln]) => { const L = window.__live; const e = L.P(s, n), a = L.P(ls, ln).sub(e);
  L.placeMe(e, Math.atan2(-a.x, -a.z)); L.look(Math.atan2(-a.x, -a.z), -0.05); }, [s, n, ls, ln]); await page.waitForTimeout(700); };
const hint = () => page.evaluate(() => document.getElementById("lv-hint").textContent);
if (mode === "look") {
  await shot("00_start");
  await pose(40, 30, 40, 0); await shot("01_overview");
  const places = await page.evaluate(() => window.__live.slots.places);
  for (const p of places) { await pose(p.approach[0], p.approach[1] + 4, p.s, 1.5); await shot(`place_${p.id}`); log("place", p.id, p.state, "| hint at approach:"); await pose(p.approach[0], p.approach[1], p.s, 1.5); log("   ", await hint()); }
  // place 1: walk into the door ring, teleport inside
  await pose(40.6, 4.6, 40.6, 0);
  await page.keyboard.down("KeyW"); await page.waitForTimeout(1200); await page.keyboard.up("KeyW"); await page.waitForTimeout(2500);
  log("after the door:", await hint()); await shot("02_shop_inside");
}
if (mode === "build") {
  const [wish, place = "2"] = rest; const pid = +place;
  const p = (await page.evaluate(() => window.__live.slots.places)).find((x) => x.id === pid);
  await pose(p.approach[0], p.approach[1], p.s, 1.5);
  log("hint:", await hint());
  await page.keyboard.press("KeyE"); await page.waitForTimeout(500); await shot("b1_nick");
  await page.fill("#lv-card input", "tero_test"); await page.click("#lv-btns button.main"); await page.waitForTimeout(400);
  await page.fill("#lv-card textarea", wish); await shot("b2_wish"); await page.click("#lv-btns button.main"); await page.waitForTimeout(300);
  await shot("b3_sure"); await page.click("#lv-btns button.main"); await page.waitForTimeout(300);
  await shot("b4_sure2"); await page.click("#lv-btns button.main");
  await page.waitForTimeout(1500);
  log("dialog open after claim:", await page.evaluate(() => document.getElementById("lv-dlg").classList.contains("on")), await page.evaluate(() => document.getElementById("lv-card").textContent));
  await pose(p.approach[0], p.approach[1] + 6, p.s, 1.5);
  let last = "", shots = 0;
  for (;;) {
    const s = await page.evaluate((id) => window.__live.slots.places.find((x) => x.id === id), pid);
    const line = `${s.state} ${s.stage_text ?? ""} ${s.pct ?? ""} ${s.elapsed_s ?? ""}`;
    if (line.split(" ").slice(0, 2).join(" ") !== last) { log(line); last = line.split(" ").slice(0, 2).join(" "); }
    if ((shots === 0 && (s.pct ?? 0) > 30) || (shots === 1 && (s.pct ?? 0) > 70)) await shot(`b5_building_${shots++}`);
    if (s.state !== "building") break;
    if (Date.now() - t0 > 900000) { log("timeout"); break; }
    await page.waitForTimeout(3000);
  }
  await page.waitForTimeout(6000); await shot("b6_built");
}
if (mode === "build" || mode === "enter") {
  const pid = +(mode === "enter" ? rest[0] : rest[1] || 2);
  const p = (await page.evaluate(() => window.__live.slots.places)).find((x) => x.id === pid);
  if (p.state === "built") {
    await pose(p.approach[0], p.approach[1], p.s, 1.5); await page.waitForTimeout(8000);
    log("loaded:", await page.evaluate((id) => window.__live.sites.get(id).loaded, pid), "|", await hint());
    await shot("e1_front");
    // walk straight in through the door (the door faces the yard, its centre at s = place s)
    await page.keyboard.down("KeyW"); await page.waitForTimeout(3600); await page.keyboard.up("KeyW"); await page.waitForTimeout(600);
    const at = await page.evaluate(() => { const m = window.__live.me(); return [m.x, m.z]; });
    log("after walking in, at", at.map((v) => v.toFixed(2)).join(","));
    await shot("e2_inside");
    await page.evaluate(() => window.__live.look(window.__live.yawLooking(window.__live.nr), 0)); await page.waitForTimeout(500); await shot("e3_inside_looking_out");
    await page.reload(); await page.waitForFunction(() => window.__live, null, { timeout: 180000 }); await page.waitForTimeout(3000);
    log("after reload:", await page.evaluate((id) => window.__live.slots.places.find((x) => x.id === id).state, pid));
  }
}
log("4xx/5xx responses:", bad.length ? bad.slice(0, 10) : "none");
await browser.close();
