// Record one stage page: a video (no sound, Playwright never captures audio) plus the moment the page got every
// sim event, so make.film lays each voice wav under the picture at the time it played live.
//   node bin/record.mjs <page url> <out dir> [max seconds] [WxH]
// -> <out dir>/<page>.webm, events.json ([{ms, type, who, text, audio, dur}], plus {ms, type: "ready"} when the world is built), last.png, critic.jsonl (window.__critic facts). Exit 3: no book_end/stop.
import { writeFileSync } from "node:fs";
import { chromium } from "playwright";

const [url, outDir, maxS = "600", size = "1280x720"] = process.argv.slice(2);
if (!url || !outDir) {
  console.error("usage: node bin/record.mjs <page url> <out dir> [max seconds] [WxH]");
  process.exit(2);
}
const [width, height] = size.split("x").map(Number);
const browser = await chromium.launch({ args: ["--use-gl=angle", "--autoplay-policy=no-user-gesture-required"] });
const ctx = await browser.newContext({ viewport: { width, height }, recordVideo: { dir: outDir, size: { width, height } } });
const t0 = Date.now();  // the video starts with the context
const page = await ctx.newPage();
const events = [];
await page.exposeFunction("__recEvent", (s) => events.push({ ms: Date.now() - t0, ...JSON.parse(s) }));
await page.addInitScript(() => {
  const ES = window.EventSource;
  window.EventSource = function (u, o) {
    const es = new ES(u, o);
    es.addEventListener("message", (m) => {
      try {
        const e = JSON.parse(m.data);
        window.__recEvent(JSON.stringify({ type: e.type, who: e.who, text: e.text, audio: e.audio, dur: e.dur }));
      } catch { /* not an event */ }
    });
    return es;
  };
  window.EventSource.prototype = ES.prototype;
});
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 200)));
await page.goto(url);
// the world is built (window.__ready): make.film cuts the black loading head before this moment
page.waitForFunction(() => window.__ready === true, null, { polling: 100, timeout: 0 })
  .then(() => events.push({ ms: Date.now() - t0, type: "ready" }))
  .catch(() => {});
const until = Date.now() + Number(maxS) * 1000;
const over = () => events.some((e) => e.type === "book_end" || e.type === "stop");
while (Date.now() < until && !over()) await page.waitForTimeout(500);
await page.waitForTimeout(3000);  // the last line's tail
writeFileSync(`${outDir}/events.json`, JSON.stringify(events, null, 1));
await page.screenshot({ path: `${outDir}/last.png` });
// the runtime writes one fact per 0.5 s into window.__critic (stage/critic.ts); make/critic.py judges them
// stage `t` runs on performance.now (seconds since navigation), events `ms` on Date.now - t0:
// shift facts onto the events clock so reply intervals match their frames
const timeOrigin = await page.evaluate(() => performance.timeOrigin).catch(() => t0);
const facts = await page.evaluate(() => window.__critic ?? []).catch(() => []);
for (const f of facts) f.t = Math.round((f.t + (timeOrigin - t0) / 1000) * 100) / 100;
writeFileSync(`${outDir}/critic.jsonl`, facts.map((f) => JSON.stringify(f)).join("\n") + (facts.length ? "\n" : ""));
await ctx.close();
await browser.close();
console.log(`record: ${events.length} events, ${events.filter((e) => e.audio).length} voiced, ${Math.round((Date.now() - t0) / 1000)} s`);
process.exit(over() ? 0 : 3);
