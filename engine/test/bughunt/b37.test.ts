import { describe, it, expect } from "vitest";
import { PNG } from "pngjs";
import { inpaintSky } from "../../src/assets/sky.js";

// GRAY in src/assets/sky.ts: the colour of the blanked seam band.
const GRAY = 128;
const SRC = [200, 100, 50, 255];

async function run(w: number, h: number): Promise<PNG> {
  const src = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) {
    src.data[i * 4] = SRC[0];
    src.data[i * 4 + 1] = SRC[1];
    src.data[i * 4 + 2] = SRC[2];
    src.data[i * 4 + 3] = SRC[3];
  }
  const res = await inpaintSky(PNG.sync.write(src), async (png) => png);
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error("inpaintSky failed");
  const out = PNG.sync.read(res.png);
  expect(out.width).toBe(w);
  expect(out.height).toBe(h);
  return out;
}

describe("B37: inpaintSky with odd height must not shift RGBA bytes", () => {
  for (const [w, h] of [[10, 5], [202, 101]] as const) {
    it(`echo edit on ${w}x${h} opaque panorama keeps alpha and channel order`, async () => {
      const out = await run(w, h);
      const px = (x: number, y: number) => Array.from(out.data.slice((y * w + x) * 4, (y * w + x) * 4 + 4));

      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const p = px(x, y);
          // alpha is never overwritten
          expect(p[3], `alpha at ${x},${y}`).toBe(255);
          // each colour channel is the source or the gray band (or a blend of them)
          for (let c = 0; c < 3; c++) {
            const lo = Math.min(SRC[c], GRAY) - 1;
            const hi = Math.max(SRC[c], GRAY) + 1;
            expect(p[c], `channel ${c} at ${x},${y}`).toBeGreaterThanOrEqual(lo);
            expect(p[c], `channel ${c} at ${x},${y}`).toBeLessThanOrEqual(hi);
          }
        }
      }

      // the seam band lands on the original left/right edges, so the middle
      // column (outside the crop after the roll back) must be untouched
      for (let y = 0; y < h; y++) {
        expect(px(w / 2, y)).toEqual(SRC);
      }
    });
  }
});
