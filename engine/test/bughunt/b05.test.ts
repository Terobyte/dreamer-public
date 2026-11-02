import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser } from "playwright";
import { launch, serve, type Served, closeBrowser } from "../browser/serve.js";

const ENGINE = fileURLToPath(new URL("../../", import.meta.url));

describe("B05: runtime with nav.layers = [] must not crash the page", () => {
  let browser: Browser;
  let site: Served;

  beforeAll(async () => {
    const dist = join(mkdtempSync(join(tmpdir(), "dreamer-")), "dist");
    const r = spawnSync(
      "node",
      ["--import", "tsx", "bin/dreamer.ts", "build", "../specs/examples/demo-flat.scene.json", "--out", dist, "--assets", "none", "--cache", mkdtempSync(join(tmpdir(), "dreamer-cache-"))],
      { cwd: ENGINE, encoding: "utf-8" },
    );
    if (r.status !== 0) throw new Error(`build failed: ${r.stderr}`);
    const navPath = join(dist, "nav.json");
    const nav = JSON.parse(readFileSync(navPath, "utf-8"));
    nav.layers = [];
    writeFileSync(navPath, JSON.stringify(nav));
    site = await serve(dist);
    browser = await launch();
  }, 90000);

  afterAll(async () => {
    await closeBrowser(browser);
    await site?.close();
  });

  it("no uncaught TypeError on load", async () => {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    const pageErrors: string[] = [];
    page.on("pageerror", (e) => pageErrors.push(String(e)));
    await page.goto(site.url, { timeout: 90000 });
    await page.waitForTimeout(3000);
    await page.close();
    expect(pageErrors).toEqual([]);
  }, 90000);
});
