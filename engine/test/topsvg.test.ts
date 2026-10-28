import { describe, expect, beforeAll, test } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCheck } from "../src/check.js";
import { topSvg } from "../src/report/topsvg.js";
import { demoFlat } from "./helpers/scene.js";
import type { Report } from "../src/types.js";

const engineDir = fileURLToPath(new URL("..", import.meta.url));
const scenePath = fileURLToPath(new URL("../../specs/examples/demo-flat.scene.json", import.meta.url));

let svg: string;
let report: Report;

beforeAll(() => {
  const a = runCheck(demoFlat());
  const b = runCheck(demoFlat());
  svg = topSvg(a.ctx);
  report = a.report;
  // deterministic: same input, byte-identical output
  expect(topSvg(b.ctx)).toBe(svg);
});

function texts(s: string): string[] {
  return [...s.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
}

describe("top.svg", () => {
  test("test_top_svg", () => {
    const t = texts(svg);
    for (const want of ["living", "hall", "living#1", "front", "sea", "chairs.0"]) {
      expect(t, want).toContain(want);
    }
    const props = [...svg.matchAll(/<polygon class="prop" data-id="([^"]+)"/g)].map((m) => m[1]);
    expect(props.length).toBe(8);
    expect(new Set(props).size).toBe(8);

    const sofa = (report.passport.props as Array<{ id: string; obb: [number, number][] }>).find(
      (p) => p.id === "sofa",
    )!;
    const m = svg.match(/<polygon class="prop" data-id="sofa" points="([^"]+)"/);
    expect(m).not.toBeNull();
    const got = m![1].split(" ").map((p) => p.split(",").map(Number));
    expect(got.length).toBe(4);
    sofa.obb.forEach((c, i) => {
      expect(got[i][0]).toBeCloseTo(c[0] * 40, 1);
      expect(got[i][1]).toBeCloseTo(c[1] * 40, 1);
    });
  });

  test("test_all_geometry_has_data_id", () => {
    // every rendered geometry element must carry a data-id, including wall bodies
    for (const m of svg.matchAll(/<(polygon|line|circle|path)\b[^>]*\/>/g)) {
      expect(m[0], m[0]).toMatch(/data-id="/);
    }
  });

  test("test_cli_writes_svg", () => {
    const dir = mkdtempSync(join(tmpdir(), "dreamer-svg-"));
    const reportPath = join(dir, "x.json");
    execFileSync("node", ["--import", "tsx", "bin/dreamer.ts", "check", scenePath, "--report", reportPath], {
      cwd: engineDir,
      stdio: "pipe",
    });
    expect(existsSync(join(dir, "demo-flat.top.svg"))).toBe(true);
    void writeFileSync;
  });
});

describe("terra re-review", () => {
  test("test_body_is_one_compound_path", () => {
    // outer contour and holes must be filled together, or the hole covers the floor
    const out = runCheck(demoFlat());
    const s = topSvg(out.ctx);
    expect(s).not.toMatch(/<polygon class="body"/);
    const m = s.match(/<path class="body" data-id="L0\.wall" fill-rule="nonzero" d="([^"]+)"\/>/);
    expect(m).not.toBeNull();
    const body = (out.ctx as any).levels.get("L0").body as unknown[];
    expect((m![1].match(/M/g) ?? []).length).toBe(body.length);
  });
});
