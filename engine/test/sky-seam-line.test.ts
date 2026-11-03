/** Koshakan meadow, Nov 3: a black vertical line stood in the sky in a third of the shots. mead_sky.png had columns
 *  4092–4095 black in rows 797–1023: the edit model painted a thin dark stroke into the gray seam band, and the paste
 *  kept it. A thin dark run across the seam is wiped, a wide dark shape (a tree) stays. */
import { describe, it, expect } from "vitest";
import { PNG } from "pngjs";
import { dropSeamLines } from "../src/assets/sky.js";

const img = (w: number, h: number, dark: (x: number, y: number) => boolean): PNG => {
  const p = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const d = (y * w + x) * 4;
      const v = dark(x, y) ? 0 : 220;
      p.data[d] = p.data[d + 1] = p.data[d + 2] = v;
      p.data[d + 3] = 255;
    }
  return p;
};
const at = (p: PNG, x: number, y: number): number => p.data[(y * p.width + x) * 4]!;

describe("dark stroke across the sky seam", () => {
  it("a 4 px black stroke at the wrap edge is wiped (both sides of x = 0)", () => {
    const p = img(64, 32, (x, y) => x >= 60 && y < 20);
    dropSeamLines(p, 0, 12);
    for (let x = 58; x < 64; x++) expect(at(p, x, 5)).toBeGreaterThan(150);
  });
  it("a wide dark shape is kept", () => {
    const p = img(64, 32, (x) => x >= 50 || x < 6);
    dropSeamLines(p, 0, 12);
    expect(at(p, 62, 5)).toBe(0);
    expect(at(p, 2, 5)).toBe(0);
  });
  it("away from the seam nothing changes", () => {
    const p = img(64, 32, (x) => x === 30);
    dropSeamLines(p, 0, 12);
    expect(at(p, 30, 5)).toBe(0);
  });
});
