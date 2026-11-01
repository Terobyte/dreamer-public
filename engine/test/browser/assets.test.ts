import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { launch, serve, type Served, closeBrowser } from "./serve.js";
import { demoFlat } from "../helpers/scene.js";
import { runCheck } from "../../src/check.js";
import { sceneAssets } from "../../src/assets/run.js";
import { fakeGlb, fakePng } from "../../src/assets/providers/fake.js";

const ENGINE = fileURLToPath(new URL("../../", import.meta.url));
const DEMO = "../specs/examples/demo-flat.scene.json";

let browser: Browser;
let site: Served;

/** A cache the fake providers could have left behind, for every asset the scene uses. */
function fullCache(): string {
  const dir = mkdtempSync(join(tmpdir(), "dreamer-cache-"));
  for (const a of sceneAssets(runCheck(demoFlat()).ctx.scene)) {
    if (a.kind === "object") writeFileSync(join(dir, `${a.key}.glb`), fakeGlb());
    else writeFileSync(join(dir, `${a.key}.png`), fakePng(8, 8, [120, 90, 60], a.kind === "decal"));
  }
  return dir;
}

async function open(): Promise<{ page: Page; consoleErrors: string[]; pageErrors: string[] }> {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.goto(site.url);
  return { page, consoleErrors, pageErrors };
}

describe("page with assets", () => {
  beforeAll(async () => {
    const dist = join(mkdtempSync(join(tmpdir(), "dreamer-")), "dist");
    const r = spawnSync(
      "node",
      ["--import", "tsx", "bin/dreamer.ts", "build", DEMO, "--out", dist, "--assets", "cache", "--cache", fullCache()],
      { cwd: ENGINE, encoding: "utf-8" },
    );
    if (r.status !== 0) throw new Error(`build failed: ${r.stderr}`);
    browser = await launch();
    site = await serve(dist);
  }, 30000);

  afterAll(async () => {
    // the browser must close before we wait on the server: a page that is
    // still mid-request against a gated path would otherwise keep the
    // server's open connection alive and hang server.close() forever
    await closeBrowser(browser);
    await site?.close();
  });

  it("test_ready_after_assets", async () => {
    // the page must not call itself ready while a GLB is still in flight: a
    // screenshot taken then would show an OBB box instead of the prop
    const release = site.gate("/assets/p_sofa.glb");
    let page: Page | undefined;
    try {
      ({ page } = await open());
      await page.waitForTimeout(1000);
      expect(await page.evaluate("window.__ready === true")).toBe(false);
      release();
      await page.waitForFunction("window.__ready === true", null, { timeout: 5000 });
    } finally {
      release();
      await page?.close();
    }
  }, 30000);

  it("test_textured_page", async () => {
    const { page, consoleErrors, pageErrors } = await open();
    await page.waitForFunction("window.__ready === true", null, { timeout: 90_000 });
    const floor = await page.evaluate('window.__dreamer.inspect("living:floor")');
    const sofa = await page.evaluate('window.__dreamer.inspect("sofa")');
    expect([consoleErrors, pageErrors]).toEqual([[], []]);
    expect((floor as any).hasMap).toBe(true);
    expect((sofa as any).type).toBe("Group");
    await page.close();
  }, 30000);
});
