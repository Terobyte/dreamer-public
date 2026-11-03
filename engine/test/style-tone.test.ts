import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runCheck } from "../src/check.js";
import { buildGeometry } from "../src/build/geometry.js";

// main.ts reads geo.style.tone / exposure; the build dropped them, so no world could set them (debt sweep Nov 3)
const demo = (): any => JSON.parse(readFileSync(new URL("../../specs/examples/demo-flat.scene.json", import.meta.url), "utf8"));

describe("style tone and exposure reach geometry.json", () => {
  it("copied when the scene sets them", () => {
    const s = demo();
    s.style = { ...(s.style ?? {}), tone: "none", exposure: 1.2 };
    const { report, ctx } = runCheck(s);
    expect(report.errors).toEqual([]);
    const g = buildGeometry(ctx);
    expect(g.style.tone).toBe("none");
    expect(g.style.exposure).toBe(1.2);
  });
  it("absent when it does not (older worlds keep their hashes)", () => {
    const { ctx } = runCheck(demo());
    const g = buildGeometry(ctx);
    expect("tone" in g.style).toBe(false);
    expect("exposure" in g.style).toBe(false);
  });
});
