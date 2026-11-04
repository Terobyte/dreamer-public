/** The director's sight probe on a tape. The page records each step's "no"s next to its inputs (critic atCut), so
 *  a film's frame replays in a test with the answers the world gave (Koshakan k3 32.63 s: without them the replay
 *  took a frame the film's director had been refused). */
import type { V3 } from "./camera.js";

export type Probe = (cam: V3, look: V3) => boolean;
const r3 = (x: number): number => Math.round(x * 1000) / 1000;

/** wraps the world's probe: every answer passes through, the blocked queries (cam + look, mm) are kept, `cap` at most */
export function tapeProbe(probe: Probe, cap = 400): { clear: Probe; blocked: number[][] } {
  const blocked: number[][] = [];
  const clear: Probe = (cam, look) => {
    const ok = probe(cam, look);
    if (!ok && blocked.length < cap) blocked.push([...cam, ...look].map(r3));
    return ok;
  };
  return { clear, blocked };
}

/** the probe of a replay: no for a query within `tol` (per coordinate) of a recorded no, else yes */
export function replayProbe(blocked: number[][], tol = 0.01): Probe {
  return (cam, look) => {
    const q = [...cam, ...look];
    return !blocked.some((b) => b.every((v, i) => Math.abs(v - q[i]) <= tol));
  };
}

/** the random draws of one director step on the tape (the page's rng is shared with the probe's own director, so a
 *  replay without them drifts off the film; Koshakan f5's back-of-head frames did not replay from the cut windows) */
export function tapeRng(rng: () => number): { rng: () => number; drawn: number[] } {
  const drawn: number[] = [];
  return { rng: () => { const v = rng(); drawn.push(v); return v; }, drawn };
}

/** the taped draws in order, then `rest` */
export function replayRng(drawn: number[], rest: () => number): () => number {
  let i = 0;
  return () => (i < drawn.length ? drawn[i++]! : rest());
}
