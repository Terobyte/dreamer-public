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
