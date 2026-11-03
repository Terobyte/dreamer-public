import { PNG } from "pngjs";
import type { Issue } from "../types.js";
import { msg } from "../report/messages.js";

/** How many columns either side of the moved seam are cross-faded. */
const BLEND = 1 / 16;
/** `h0/h13_seam.py` on a 2048×1024 sky: a 160 px gray band, feathered 80 px each side. */
const GAP = 160 / 2048;
const FEATHER = 80 / 2048;
const GRAY = 128;

export const SEAM_PROMPT =
  "Fill the flat gray vertical band in the middle so the scene continues seamlessly from the left half into the right half. Do not change anything outside the gray band.";

/** An image-edit call: the picture with a gray band in, the band painted in out. */
export type EditFn = (png: Buffer, prompt: string) => Promise<Buffer>;

type SeamResult = { ok: true; png: Buffer } | { ok: false; issue: Issue };

function notTwoToOne(src: PNG, id: string): SeamResult | null {
  const { width: w, height: h } = src;
  if (w === 2 * h) return null;
  const reason = `панорама ${w}×${h}, нужна 2:1`;
  return {
    ok: false,
    issue: { code: "ASSET_FAILED", stage: "assets", path: `/assets/${id}`, msg: msg("ASSET_FAILED", { id, reason }) },
  };
}

/** The panorama shifted by `by` columns (wrapping), so the seam moves to the middle. */
function roll(src: PNG, by: number): PNG {
  const { width: w, height: h } = src;
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (y * w + ((((x + by) % w) + w) % w)) * 4;
      const d = (y * w + x) * 4;
      for (let c = 0; c < 4; c++) out.data[d + c] = src.data[s + c];
    }
  }
  return out;
}

/** Bilinear resample: an edit model may hand back its own canvas size. */
function resize(src: PNG, w: number, h: number): PNG {
  if (src.width === w && src.height === h) return src;
  const out = new PNG({ width: w, height: h });
  const sx = src.width / w;
  const sy = src.height / h;
  for (let y = 0; y < h; y++) {
    const fy = Math.min(src.height - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(src.height - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(src.width - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(src.width - 1, x0 + 1);
      const tx = fx - x0;
      const d = (y * w + x) * 4;
      for (let c = 0; c < 4; c++) {
        const p = (yy: number, xx: number): number => src.data[(yy * src.width + xx) * 4 + c];
        const top = p(y0, x0) * (1 - tx) + p(y0, x1) * tx;
        const bot = p(y1, x0) * (1 - tx) + p(y1, x1) * tx;
        out.data[d + c] = Math.round(top * (1 - ty) + bot * ty);
      }
    }
  }
  return out;
}

/**
 * Thin dark strokes across the seam (column `cx`, ±`half`, wrapping) are wiped: per row, a run of at most `maxW`
 * pixels darker than half the window's median brightness becomes a blend of its two neighbours. A wide dark shape
 * (a tree, a hill) is wider than `maxW` or sets the median, so it stays. Koshakan meadow, Nov 3: the edit model
 * painted a 4 px black stroke into the gray band and the dome showed it as a pole from the zenith to the horizon.
 */
export function dropSeamLines(img: PNG, cx: number, half: number, maxW = 6): void {
  const { width: w, height: h } = img;
  const xs: number[] = [];
  for (let o = -half; o <= half; o++) xs.push((((cx + o) % w) + w) % w);
  const lum = (y: number, x: number): number => {
    const d = (y * w + x) * 4;
    return 0.299 * img.data[d]! + 0.587 * img.data[d + 1]! + 0.114 * img.data[d + 2]!;
  };
  for (let y = 0; y < h; y++) {
    const l = xs.map((x) => lum(y, x));
    const med = [...l].sort((a, b) => a - b)[l.length >> 1]!;
    const dark = l.map((v) => v < med * 0.5);
    for (let i = 0; i < xs.length; ) {
      if (!dark[i]) {
        i++;
        continue;
      }
      let j = i;
      while (j < xs.length && dark[j]) j++;
      if (j - i <= maxW && i > 0 && j < xs.length) {
        const a = (y * w + xs[i - 1]!) * 4;
        const b = (y * w + xs[j]!) * 4;
        for (let k = i; k < j; k++) {
          const t = (k - i + 1) / (j - i + 1);
          const d = (y * w + xs[k]!) * 4;
          for (let c = 0; c < 4; c++) img.data[d + c] = Math.round(img.data[a + c]! * (1 - t) + img.data[b + c]! * t);
        }
      }
      i = j;
    }
  }
}

/**
 * The seam step of `h0/h13_seam.py`, without a model: shift the panorama by
 * half its width so the old left/right seam lands in the middle, then
 * cross-fade a band across it. The new left and right edges were neighbouring
 * columns of the original, so the 360° wrap is continuous. This is the
 * fallback when no image-edit call is available or it fails.
 */
export function seamSky(png: Buffer, id = "sky"): SeamResult {
  const src = PNG.sync.read(png);
  const bad = notTwoToOne(src, id);
  if (bad) return bad;
  const { width: w, height: h } = src;
  const half = w / 2;
  const out = roll(src, half);
  // fill the seam (now at x = half): each row across the band becomes a linear
  // blend between the band's two outer columns
  const r = Math.max(1, Math.round(w * BLEND));
  const x0 = half - r;
  const x1 = half + r - 1;
  for (let y = 0; y < h; y++) {
    const a = (y * w + x0) * 4;
    const b = (y * w + x1) * 4;
    for (let x = x0 + 1; x < x1; x++) {
      const t = (x - x0) / (x1 - x0);
      const d = (y * w + x) * 4;
      for (let c = 0; c < 4; c++) out.data[d + c] = Math.round(out.data[a + c] * (1 - t) + out.data[b + c] * t);
    }
  }
  return { ok: true, png: PNG.sync.write(out) };
}

/**
 * The full recipe of `h0/h13_seam.py`: roll by half, cut the h×h square over
 * the seam, blank a gray band down its middle, let the edit model paint the
 * band, then paste the edit back with a feather (the band entirely from the
 * edit, fading to the original over `FEATHER` either side) and roll back.
 */
export async function inpaintSky(png: Buffer, edit: EditFn, id = "sky"): Promise<SeamResult> {
  const src = PNG.sync.read(png);
  const bad = notTwoToOne(src, id);
  if (bad) return bad;
  const { width: w, height: h } = src;
  const rolled = roll(src, w / 2);
  const left = Math.floor(w / 2 - h / 2); // a whole pixel: an odd h would shift the RGBA bytes
  const gap = Math.max(2, Math.round(w * GAP));
  const feather = Math.max(1, Math.round(w * FEATHER));

  const crop = new PNG({ width: h, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < h; x++) {
      const s = (y * w + left + x) * 4;
      const d = (y * h + x) * 4;
      const blank = Math.abs(x + 0.5 - h / 2) < gap / 2;
      for (let c = 0; c < 3; c++) crop.data[d + c] = blank ? GRAY : rolled.data[s + c];
      crop.data[d + 3] = 255;
    }
  }
  const painted = resize(PNG.sync.read(await edit(PNG.sync.write(crop), SEAM_PROMPT)), h, h);

  for (let x = 0; x < h; x++) {
    const alpha = Math.min(1, Math.max(0, 1 - (Math.abs(x + 0.5 - h / 2) - gap / 2) / feather));
    if (alpha === 0) continue;
    for (let y = 0; y < h; y++) {
      const d = (y * w + left + x) * 4;
      const e = (y * h + x) * 4;
      for (let c = 0; c < 3; c++) rolled.data[d + c] = Math.round(rolled.data[d + c] * (1 - alpha) + painted.data[e + c] * alpha);
    }
  }
  const back = roll(rolled, -w / 2);
  dropSeamLines(back, 0, Math.round(gap / 2 + feather));
  return { ok: true, png: PNG.sync.write(back) };
}
