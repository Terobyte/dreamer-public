import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { bundleRuntime } from "../../src/build/write.js";
import { launch, serve, closeBrowser, type Served } from "./serve.js";

const TESTDATA = fileURLToPath(new URL("../../../h0/make/testdata/", import.meta.url));
const HAS = (() => {
  try {
    return existsSync(chromium.executablePath()) && existsSync(join(TESTDATA, "world_run", "dist", "index.html"));
  } catch {
    return false;
  }
})();

// case targets and yaws come from expect_touch.json; the window spot is read back from the places.json fixture file
const EXPECT = JSON.parse(readFileSync(join(TESTDATA, "expect_touch.json"), "utf-8"));
const place = (name: string, id: string, kind: string, at: [number, number], yaw: number, look: [number, number] | null) => ({
  name, id, kind, room: "living", level: "L0", at, yaw, look, obstacle: null,
});
const PLACES = [
  place("armchair", "living_armchair", "sit", [4.22, 3.26], 180, null),
  place("window", "living_window", "stand", [2.0, 1.0], 0, [2.0, 0.0]),
  place("spot a", "spot_a", "stand", EXPECT.actors_start["Edward Rochester"], 0, null),
  place("spot b", "spot_b", "stand", EXPECT.actors_start["Jane Eyre"], 0, null),
];
const LOG = [
  { type: "snapshot", seq: 0 }, // as the real sim: a book run's snapshot carries no mode (F35)
  { type: "line", who: "Edward Rochester", text: "Sit with me.", role: "hero", touch: "armchair" },
  { type: "line", who: "Jane Eyre", text: "May I?", role: "hero", touch: "armchair" },
  { type: "narrator", text: "Mr. Rochester rose and went to the window" },
  { type: "line", who: "Jane Eyre", text: "Do you play?", role: "hero", touch: "piano" },
];

describe.skipIf(!HAS)("stage in the browser (?stage=)", () => {
  let served: Served;
  let sse: Server;
  let browser: Awaited<ReturnType<typeof launch>>;
  const clients: ServerResponse[] = [];
  const posts: string[] = [];
  let simUrl = "";
  let runDir = "";
  // F4: the page only ever sees what is read back from the log.jsonl fixture file.
  let feed: any[] = [];
  const emit = (i: number): void => {
    for (const c of clients) c.write(`data: ${JSON.stringify(feed[i])}\n\n`);
  };

  beforeAll(async () => {
    const run = mkdtempSync(join(tmpdir(), "dreamer-stage-"));
    cpSync(join(TESTDATA, "world_run", "dist"), join(run, "world", "run", "dist"), { recursive: true });
    // the fixture's runtime.js predates the stage: bundle the current runtime into the copy
    await bundleRuntime(join(run, "world", "run", "dist", "runtime.js"));
    cpSync(join(TESTDATA, "cast"), join(run, "cast"), { recursive: true });
    mkdirSync(join(run, "stage"));
    writeFileSync(join(run, "stage", "places.json"), JSON.stringify({ places: PLACES, warnings: [] }));
    writeFileSync(
      join(run, "stage", "stage.json"),
      JSON.stringify({
        dist: "world/run/dist", places: "stage/places.json", cast: "cast/cast.json", mode: "book",
        start: { "Edward Rochester": "spot a", "Jane Eyre": "spot b" },
      }),
    );
    writeFileSync(join(run, "log.jsonl"), LOG.map((e) => JSON.stringify(e)).join("\n"));
    runDir = run;
    feed = readFileSync(join(run, "log.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    served = await serve(run);
    sse = createServer((req, res) => {
      const head = { "access-control-allow-origin": "*", "access-control-allow-headers": "*" };
      if (req.method === "OPTIONS") return void res.writeHead(204, head).end();
      if (req.method === "POST") {
        posts.push(req.url ?? "");
        return void res.writeHead(200, head).end("{}");
      }
      res.writeHead(200, { ...head, "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(": hi\n\n");
      clients.push(res);
    });
    await new Promise<void>((ok) => sse.listen(0, "127.0.0.1", ok));
    simUrl = `http://127.0.0.1:${(sse.address() as { port: number }).port}`;
    browser = await launch();
  }, 90_000);

  afterAll(async () => {
    for (const c of clients) c.end();
    sse?.closeAllConnections();
    await new Promise<void>((ok) => (sse ? sse.close(() => ok()) : ok()));
    await served?.close();
    await closeBrowser(browser);
  });

  const stageUrl = (): string =>
    `${served.url}world/run/dist/index.html?sim=${encodeURIComponent(simUrl)}&stage=${encodeURIComponent("../../../stage/stage.json")}`;
  const actors = (page: any): Promise<Array<{ who: string; pos: [number, number]; yaw: number; act: string }>> =>
    page.evaluate(() => (window as any).__dreamer.stage.actors());
  const near = async (page: any, who: string, want: [number, number], yaw: number | null): Promise<void> => {
    await page.waitForFunction(
      ([w, x, z, y]: [string, number, number, number | null]) => {
        const a = (window as any).__dreamer.stage.actors().find((q: any) => q.who === w);
        if (!a || Math.hypot(a.pos[0] - x, a.pos[1] - z) > 0.3) return false;
        if (y === null) return true;
        return Math.abs(((a.yaw - y + 540) % 360) - 180) <= 10;
      },
      [who, want[0], want[1], yaw] as [string, number, number, number | null],
      { timeout: 10_000 },
    );
  };

  it("test_browser_stage_four_touch_cases_and_camera", async () => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(stageUrl());
    await page.waitForFunction(() => (window as any).__ready === true, undefined, { timeout: 60_000 });
    // SSE client connected before the first event is sent
    await page.waitForFunction(() => !!(window as any).__dreamer.stage, undefined, { timeout: 10_000 });
    // F5: the camera bounds are sampled on every frame, not just once per case.
    await page.evaluate(() => {
      (window as any).__camsamples = [];
      const tick = (): void => {
        const st = (window as any).__dreamer.stage;
        if (st) (window as any).__camsamples.push(st.camera());
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    for (let i = 0; i < 50 && clients.length === 0; i++) await new Promise((r) => setTimeout(r, 100));
    expect(clients.length).toBeGreaterThan(0);

    const cs = EXPECT.cases;
    expect((await actors(page)).length).toBe(2); // the cast

    const geo = JSON.parse(readFileSync(join(TESTDATA, "world_run", "dist", "geometry.json"), "utf-8"));
    const samples: Array<{ pos: number[]; room: string | null; height: number | null }> = [];
    const sample = async (): Promise<void> => void samples.push(await page.evaluate(() => (window as any).__dreamer.stage.camera()));

    // F36: the very first frame is already directed into the room
    await sample();
    // F35: stage.json mode book -> the button is there before any event, and G posts /freestyle
    expect(await page.evaluate(() => (document.getElementById("free") as HTMLButtonElement | null)?.hidden)).toBe(false);
    emit(0); // a snapshot without mode changes nothing
    await page.keyboard.press("g");
    await new Promise((r) => setTimeout(r, 300));
    expect(posts).toContain("/freestyle");

    emit(1); // case 1
    await near(page, cs[0].who, cs[0].target, cs[0].yaw);
    await page.waitForFunction((w) => (window as any).__dreamer.stage.actors().find((q: any) => q.who === w).act === "sit", cs[0].who, { timeout: 5000 });
    await sample();

    emit(2); // case 2: beside the taken chair (target + yaw from expect_touch.json)
    await near(page, cs[1].who, cs[1].target, cs[1].yaw);
    await page.waitForFunction((w) => (window as any).__dreamer.stage.actors().find((q: any) => q.who === w).act === "idle", cs[1].who, { timeout: 5000 });
    await sample();

    emit(3); // case 3: the narrator's remark walks Rochester to the window (target + yaw from expect_touch.json)
    await near(page, cs[2].who, cs[2].target, cs[2].yaw);
    await sample();

    const before = (await actors(page)).find((a) => a.who === cs[3].who)!;
    emit(4); // case 4: no piano
    await new Promise((r) => setTimeout(r, 1500));
    const after = (await actors(page)).find((a) => a.who === cs[3].who)!;
    expect(Math.hypot(after.pos[0] - before.pos[0], after.pos[1] - before.pos[1])).toBeLessThanOrEqual(0.05);
    expect(Math.abs(((after.yaw - before.yaw + 540) % 360) - 180)).toBeLessThanOrEqual(10);
    await sample();

    // the camera was inside the room of the shot, 0.3 m from the walls, below the ceiling - on every sample
    const every = await page.evaluate(
      () => (window as any).__camsamples as Array<{ pos: number[]; room: string | null; height: number | null }>,
    );
    expect(every.length).toBeGreaterThan(0);
    // F29: every frame counts; a frame with no room is a failure, not a skip
    for (const s of [...samples, ...every]) {
      expect(s.room).not.toBeNull();
      const f = geo.floors.find((q: any) => q.room === s.room);
      expect(f).toBeTruthy();
      const xs = f.outline.map((p: number[]) => p[0]);
      const zs = f.outline.map((p: number[]) => p[1]);
      expect(s.pos[0]).toBeGreaterThanOrEqual(Math.min(...xs) + 0.3 - 1e-6);
      expect(s.pos[0]).toBeLessThanOrEqual(Math.max(...xs) - 0.3 + 1e-6);
      expect(s.pos[2]).toBeGreaterThanOrEqual(Math.min(...zs) + 0.3 - 1e-6);
      expect(s.pos[2]).toBeLessThanOrEqual(Math.max(...zs) - 0.3 + 1e-6);
      expect(s.pos[1]).toBeLessThanOrEqual((s.height ?? 0) - 0.3 + 1e-6);
    }
    const texts = await page.evaluate(() => (window as any).__dreamer.stage.subs());
    expect(texts).toContain("Mr. Rochester rose and went to the window");
    expect(errors).toEqual([]);
    await page.close();
  }, 120_000);

  it("test_browser_no_stage_param_means_no_stage", async () => {
    const page = await browser.newPage();
    await page.goto(`${served.url}world/run/dist/index.html`);
    await page.waitForFunction(() => (window as any).__ready === true, undefined, { timeout: 60_000 });
    expect(await page.evaluate(() => (window as any).__dreamer.stage)).toBeNull();
    expect(await page.evaluate(() => !!document.getElementById("free"))).toBe(false);
    await page.close();
  }, 90_000);
});
