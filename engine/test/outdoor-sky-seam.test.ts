/** Koshakan meadow, Nov 3: a black vertical line stood in the sky in most shots, 4 px wide, from the zenith to the
 *  horizon, right on the dome's u = 0/1 seam (the panorama mirrors there). The mip chosen at the seam's UV jump
 *  sampled black. The sky texture wraps in u and has no mips. */
import { describe, it, expect } from "vitest";
import { DataTexture, LinearFilter, RepeatWrapping } from "three";
import { skyTexture } from "../src/runtime/outdoor.js";

describe("sky dome texture", () => {
  it("wraps across the seam and samples no mip", () => {
    const t = skyTexture(new DataTexture(new Uint8Array(4 * 4 * 2), 4, 2));
    expect(t.wrapS).toBe(RepeatWrapping);
    expect(t.generateMipmaps).toBe(false);
    expect(t.minFilter).toBe(LinearFilter);
  });
});
