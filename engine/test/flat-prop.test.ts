import { describe, it, expect } from "vitest";
import { runCheck } from "../src/check.js";
import { buildGeometry } from "../src/build/geometry.js";
import { propFacts } from "../src/build/write.js";
import { glbScale } from "../src/runtime/assets.js";
import { patched } from "./helpers/scene.js";

describe("flat prop", () => {
  it("test_flat_prop_scales_by_footprint", () => {
    const raw = patched([
      { op: "add", path: "/assets/p_rug", value: { kind: "object", prompt: "a flat round rug" } },
      {
        op: "add",
        path: "/props/-",
        value: { id: "rug", asset: "p_rug", room: "living", at: [2, 2.5], size: { w: 1.7, d: 1.7, h: 0.02 }, mount: "floor", yaw: 0, solid: false },
      },
    ]);
    const { report, ctx } = runCheck(raw);
    expect(report.errors).toEqual([]);
    const sizes = { p_rug: { w: 1, d: 1, h: 0.02 } };
    const geo = buildGeometry(ctx, { p_rug: "assets/p_rug.glb" }, sizes);
    const fact = propFacts(ctx.scene, geo, sizes).rug.fact!;
    expect(fact.w).toBeCloseTo(1.7, 6);
    expect(fact.d).toBeCloseTo(1.7, 6);
    expect(fact.h).toBeCloseTo(0.02, 6);
  });

  it("test_flat_prop_runtime_scale_applies_scaleY", () => {
    const raw = patched([
      { op: "add", path: "/assets/p_rug", value: { kind: "object", prompt: "a flat round rug" } },
      {
        op: "add",
        path: "/props/-",
        value: { id: "rug", asset: "p_rug", room: "living", at: [2, 2.5], size: { w: 1.7, d: 1.7, h: 0.02 }, mount: "floor", yaw: 0, solid: false },
      },
    ]);
    const { ctx } = runCheck(raw);
    const sizes = { p_rug: { w: 1, d: 1, h: 0.02 } };
    const geo = buildGeometry(ctx, { p_rug: "assets/p_rug.glb" }, sizes);
    const mesh = (geo.meshes as any[]).find((m) => m.kind === "prop" && typeof m.scale === "number");
    expect(mesh.scale).toBeCloseTo(1.7, 6);
    expect(mesh.scaleY).toBeCloseTo(1, 6);
    // the page must not stretch the rug's height by the footprint scale
    expect(glbScale({ glb: "assets/p_rug.glb", scale: mesh.scale, scaleY: mesh.scaleY })).toEqual([1.7, 1, 1.7]);
  });
});
