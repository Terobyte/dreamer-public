// Dreamer Home e2e against `python3 -m home --fake`: tabs, play + back, Create to Your scenes, mic, screenshots.
//   cd h0 && node home/e2e.mjs            (starts and stops its own fake Home; screenshots -> h0/out/home/)
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const H0 = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(H0, "..", "engine", "package.json"));
const { chromium } = require("playwright");
const OUT = join(H0, "out", "home");
mkdirSync(OUT, { recursive: true });

const port = await new Promise((ok) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const runs = join(OUT, "e2e-runs");
rmSync(runs, { recursive: true, force: true });
const home = spawn("python3", ["-c", `import sys; sys.argv=['home']; from home.server import serve; srv, h = serve(${port}, True, runs=${JSON.stringify(runs)}); print('up', flush=True); import atexit; atexit.register(h.shutdown)
try:
    srv.serve_forever()
finally:
    h.shutdown()`], { cwd: H0, stdio: ["ignore", "pipe", "inherit"] });
await new Promise((ok) => home.stdout.once("data", ok));
const URL = `http://127.0.0.1:${port}/`;

let failed = 0;
const check = (cond, what) => { console.log(`${cond ? "ok  " : "FAIL"} ${what}`); if (!cond) failed++; };

const browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, permissions: ["microphone"] });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  // 1. tabs
  await page.goto(URL + "#book");
  await page.waitForSelector("#shelf article");
  const book = await page.$$eval("#shelf article", (a) => a.map((x) => x.dataset.id));
  check(JSON.stringify(book) === JSON.stringify(["koshakan-bedroom", "koshakan-bathroom", "koshakan-meadow", "sherlock-221b"]), `Book shows the 4 book scenes (${book})`);
  await page.screenshot({ path: join(OUT, "book_1280.png") });
  await page.click("#tab-freestyle");
  await page.waitForFunction(() => document.querySelectorAll("#shelf article[data-mode=freestyle]").length > 0);
  const free = await page.$$eval("#shelf article", (a) => a.map((x) => x.dataset.id));
  check(free.length === 5 && free.includes("kozb7-yard"), `Freestyle shows 5 incl. the yard (${free})`);
  const yardBtn = await page.textContent('#shelf article[data-id="kozb7-yard"] .primary');
  check(yardBtn === "Walk in", "the yard's button says Walk in");
  await page.screenshot({ path: join(OUT, "freestyle_1280.png") });

  // 2. play + back
  await page.click('#shelf article[data-id="koshakan-bedroom"] .primary');
  await page.waitForSelector("#stage:not([hidden])");
  const src = await page.getAttribute("#frame", "src");
  check(src.includes("id=koshakan-bedroom") && src.includes("mode=freestyle"), `the frame opens the scene in freestyle (${src})`);
  const inner = await page.frameLocator("#frame").locator("#fake-scene").textContent();
  check(inner.includes("koshakan-bedroom"), "the scene page loaded inside the frame");
  check(await page.isHidden("#home"), "Home is hidden while a scene plays");
  await page.click("#back");
  await page.waitForSelector("#home:not([hidden])");
  const sess = await (await page.request.get(URL + "api/session")).json();
  check(sess.alive === false, "← Home stopped the scene");

  // 3. a scene that dies shows the stopped plate
  await page.click("#tab-book");
  await page.click('#shelf article[data-id="sherlock-221b"] .primary');
  await page.waitForSelector("#stage:not([hidden])");
  await page.request.post(URL + "api/stop", { headers: { "Content-Type": "application/json" }, data: "{}" });
  await page.waitForSelector("#dead:not([hidden])", { timeout: 8000 });
  check(true, "a stopped scene shows 'The scene stopped'");
  await page.click("#dead-back");
  await page.waitForSelector("#home:not([hidden])");

  // 4. create
  await page.click("#tab-create");
  await page.waitForSelector(".world");
  await page.screenshot({ path: join(OUT, "create_1280.png") });
  check(await page.isDisabled("#build"), "Build is off until there is an idea");
  // mic: hold to talk with the fake device, the fake ASR text lands in the field
  const mic = await page.$("#mic");
  const box = await mic.boundingBox();
  await page.mouse.move(box.x + 10, box.y + 10);
  await page.mouse.down();
  await page.waitForTimeout(900);
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector("#idea").value.length > 10, null, { timeout: 8000 });
  check((await page.inputValue("#idea")).includes("library"), "hold to talk put the (fake) Meta ASR text into the field");
  await page.fill("#idea", "Mirai finds a lost kitten in the meadow and wants to keep it");
  await page.click('.world[data-world="koshakan-house"]');
  check(!(await page.isDisabled("#build")), "Build is on");
  await page.click("#build");
  await page.waitForSelector("#stages li");
  await page.waitForFunction(() => /Ready in/.test(document.querySelector("#build-msg").textContent), null, { timeout: 60000 });
  const stages = await page.$$eval("#stages li", (l) => l.map((x) => `${x.dataset.stage}:${x.className}`));
  check(stages[0] === "chapter:ok" && stages.every((s) => s.endsWith(":ok")), `every stage done (${stages})`);
  await page.waitForSelector("#mine article");
  await page.screenshot({ path: join(OUT, "create_done_1280.png") });
  const mine = await page.$$eval("#mine article", (a) => a.length);
  check(mine === 1, "the new scene is in Your scenes");
  await page.click("#mine article .primary");
  await page.waitForSelector("#stage:not([hidden])");
  const src2 = await page.getAttribute("#frame", "src");
  check(/id=home-\d{8}-\d{6}&mode=book/.test(src2), `Your scene opens as a book (${src2})`);
  await page.click("#back");
  await page.waitForSelector("#home:not([hidden])");

  // 5. phone width
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await phone.goto(URL + "#book");
  await phone.waitForSelector("#shelf article");
  const wide = await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
  check(wide, "no sideways scroll at 390 px");
  await phone.screenshot({ path: join(OUT, "book_390.png"), fullPage: false });
  await phone.goto(URL + "#create");
  await phone.waitForSelector(".world");
  await phone.screenshot({ path: join(OUT, "create_390.png"), fullPage: true });

  check(errors.length === 0, `no page errors ${errors.join(" | ")}`);
} finally {
  await browser.close();
  home.kill("SIGTERM");
  rmSync(runs, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} FAILED` : "\nall ok");
process.exit(failed ? 1 : 0);
