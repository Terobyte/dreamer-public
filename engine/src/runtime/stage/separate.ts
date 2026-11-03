// Н9: раздвигание актёров в плоскости x–z. Чистая функция: детерминирована
// (фиксированный порядок пар, без rng), число итераций ограничено стандартом 50.
export function separate(
  pos: ReadonlyArray<readonly [number, number]>,
  radii: ReadonlyArray<number> | number,
  opts: { touch?: ReadonlyArray<readonly [number, number]>; maxIters?: number; fixed?: ReadonlyArray<boolean> } = {},
): { pos: Array<[number, number]>; iterations: number } {
  const n = pos.length;
  // fixed (a seated actor, a booked spot): never moves; the free one of the pair takes the whole push
  const fixed = (i: number): boolean => !!opts.fixed?.[i];
  const rs: number[] = Array.isArray(radii) ? [...radii] : pos.map(() => radii);
  const out: Array<[number, number]> = pos.map((p) => [p[0], p[1]]);
  const touchSet = new Set(
    (opts.touch ?? []).map(([a, b]) => (a < b ? `${a}:${b}` : `${b}:${a}`)),
  );
  // F9: стандартный предел — 50 (так обещает карта фич); maxIters его только снижает
  const STANDARD_CAP = 50;
  const req = opts.maxIters ?? STANDARD_CAP;
  const MAX = Number.isFinite(req) ? Math.min(Math.max(1, Math.floor(req)), STANDARD_CAP) : STANDARD_CAP;
  // до 8 проходов по парам на одну counted-итерацию: плотная группа
  // из 5 совпавших актёров сходится в пределах стандарта (F5)
  const SWEEPS = 8;
  let iterations = 0;
  for (let it = 0; it < MAX; it++) {
    let moved = false;
    for (let s = 0; s < SWEEPS; s++) {
      let swept = false;
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          if (fixed(i) && fixed(j)) continue;
          const key = `${i}:${j}`;
          const allow = touchSet.has(key) ? 0.15 : 0;
          const min = rs[i]! + rs[j]! - allow;
          const dx = out[j]![0] - out[i]![0];
          const dz = out[j]![1] - out[i]![1];
          const d = Math.hypot(dx, dz);
          if (d >= min - 1e-9) continue;
          const need = min - d;
          let ux: number;
          let uz: number;
          if (d < 1e-9) {
            const ang = (((i * 131 + j * 57) % 360) * Math.PI) / 180;
            ux = Math.cos(ang);
            uz = Math.sin(ang);
          } else {
            ux = dx / d;
            uz = dz / d;
          }
          const wi = fixed(i) ? 0 : fixed(j) ? need : need / 2;
          const wj = fixed(j) ? 0 : fixed(i) ? need : need / 2;
          const pix0 = out[i]![0];
          const piz1 = out[i]![1];
          const pjx0 = out[j]![0];
          const pjz1 = out[j]![1];
          out[i]![0] -= ux * wi;
          out[i]![1] -= uz * wi;
          out[j]![0] += ux * wj;
          out[j]![1] += uz * wj;
          if (out[i]![0] !== pix0 || out[i]![1] !== piz1 || out[j]![0] !== pjx0 || out[j]![1] !== pjz1) swept = true;
        }
      }
      if (!swept) break;
      moved = true;
    }
    iterations = it + 1;
    if (!moved) break;
  }
  return { pos: out, iterations };
}

/** how much room past the two capsules a walker keeps behind another walker (m) */
const SINGLE_FILE_GAP = 0.25;
/**
 * Walkers go single file (Squidward v22 video 2:27–2:39: two walkers on one route, through one door, inside each other
 * all the way; `separate` lets walkers be). For each pair of walkers closer than their capsules plus the gap, the one
 * that has the other ahead of it waits (pace 0) this frame; on one spot, or each ahead of the other, the later name
 * waits. A standing actor is never waited for. Pure: pace per actor, 1 = walk on.
 */
export function yieldPace(list: ReadonlyArray<{ who: string; pos: readonly [number, number]; yaw: number; radius: number; moving: boolean }>): Map<string, number> {
  const pace = new Map<string, number>(list.map((a) => [a.who, 1]));
  const dir = (yaw: number): [number, number] => [Math.sin((yaw * Math.PI) / 180), Math.cos((yaw * Math.PI) / 180)];
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i]!;
      const b = list[j]!;
      if (!a.moving || !b.moving) continue;
      const dx = b.pos[0] - a.pos[0];
      const dz = b.pos[1] - a.pos[1];
      if (Math.hypot(dx, dz) >= a.radius + b.radius + SINGLE_FILE_GAP) continue;
      const da = dir(a.yaw);
      const db = dir(b.yaw);
      const bAhead = dx * da[0] + dz * da[1] > 1e-3;
      const aAhead = -dx * db[0] - dz * db[1] > 1e-3;
      const waits = bAhead && !aAhead ? a : aAhead && !bAhead ? b : a.who > b.who ? a : b;
      pace.set(waits.who, 0);
    }
  return pace;
}
