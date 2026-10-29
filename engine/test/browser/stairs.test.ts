import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser } from "playwright";
import { launch, serve, type Served, closeBrowser } from "./serve.js";

const ENGINE = fileURLToPath(new URL("../../", import.meta.url));
const SCENE = fileURLToPath(new URL("../../../specs/examples/demo.scene.json", import.meta.url));

let browser: Browser;
let site: Served;

beforeAll(async () => {
  const dist = join(mkdtempSync(join(tmpdir(), "dreamer-")), "dist");
  const r = spawnSync(
    "node",
    [
      "--import",
      "tsx",
      "bin/dreamer.ts",
      "build",
      SCENE,
      "--out",
      dist,
      "--assets",
      "none",
      "--cache",
      mkdtempSync(join(tmpdir(), "dreamer-cache-")),
    ],
    { cwd: ENGINE, encoding: "utf-8" },
  );
  if (r.status !== 0) throw new Error(`build failed: ${r.stderr}`);
  browser = await launch();
  site = await serve(dist);
}, 30000);

afterAll(async () => {
  // browser first: its open connections are what a server close waits on
  await closeBrowser(browser);
  await site?.close();
});

describe("stairs walk", () => {
  it("test_walk_stairs", async () => {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    const errors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(site.url + "?walk=1");
    await page.waitForFunction("window.__ready === true", null, { timeout: 15000 });

    const p = (await page.evaluate(`
      const d = window.__dreamer;
      d.teleport(1.4, 11.65);
      for (let i = 0; i < 150; i++) d.tryMove(0, -0.05);
      d.pos();
    `)) as number[];
    expect(errors).toEqual([]);
    expect(p[2]).toBeLessThan(6.0);
    expect(p[1]).toBeCloseTo(3.6 + 1.6, 2);
    await page.close();
  }, 30000);
});
