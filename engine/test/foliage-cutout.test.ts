import { describe, expect, it } from "vitest";
import { DoubleSide } from "three";
import { cutDarkTexels } from "../src/runtime/assets.js";

// An ordinary double-sided MASK prop without the foliage tag must pass
// through untouched: its dark texels stay opaque (same map object, no
// canvas cutout). Runs in node with no DOM — the unfixed code reaches
// `document.createElement` and throws, the fixed code skips before that.
describe("cutDarkTexels guard", () => {
  it("test_unmarked_double_sided_keeps_dark_texels", () => {
    const map = { image: { width: 1, height: 1 } };
    const mat = {
      userData: {},
      side: DoubleSide,
      alphaTest: 0.5,
      map,
    };
    const root = { traverse: (cb: (o: unknown) => void) => cb({ material: mat }) };
    cutDarkTexels(root as never);
    expect((mat as { map: unknown }).map).toBe(map);
  });
});
