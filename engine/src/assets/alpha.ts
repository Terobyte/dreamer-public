import { PNG } from "pngjs";

/** A pixel this bright in every channel counts as the plain white backdrop. */
const WHITE_MIN = 235;

const NB = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

/**
 * Cuts the backdrop out of a decal. Only white *connected to a corner* goes:
 * white inside the subject (an eye, a page) stays opaque. The one-pixel ring
 * of half-alpha keeps the cut edge from aliasing into a hard jaggy line.
 */
export function cutWhite(png: Buffer): Buffer {
  const img = PNG.sync.read(png);
  const { width: w, height: h, data } = img;
  const filled = new Uint8Array(w * h);
  const isWhite = (i: number): boolean => Math.min(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]) >= WHITE_MIN;

  const stack: number[] = [];
  for (const seed of [0, w - 1, (h - 1) * w, h * w - 1]) {
    if (!filled[seed] && isWhite(seed)) {
      filled[seed] = 1;
      stack.push(seed);
    }
  }
  while (stack.length > 0) {
    const i = stack.pop()!;
    const x = i % w;
    const y = (i - x) / w;
    for (const [dx, dy] of NB) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (filled[j] === 1 || !isWhite(j)) continue;
      filled[j] = 1;
      stack.push(j);
    }
  }

  for (let i = 0; i < w * h; i++) {
    if (filled[i] === 1) {
      data[i * 4 + 3] = 0;
      continue;
    }
    const x = i % w;
    const y = (i - x) / w;
    let onEdge = false;
    for (const [dx, dy] of NB) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (filled[ny * w + nx] === 1) {
        onEdge = true;
        break;
      }
    }
    data[i * 4 + 3] = onEdge ? 128 : 255;
  }
  return PNG.sync.write(img);
}
