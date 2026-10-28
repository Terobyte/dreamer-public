import type { Issue, Passport, Report, Stage, StageStatus } from "../types.js";

export const STAGES: Stage[] = ["schema", "plan", "openings", "stairs", "props", "decals", "cameras", "nav"];

export function emptyPassport(): Passport {
  return { edges: [], snaps: [], openings: [], props: [], decals: [] };
}

export function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

export function roundReport(value: unknown): unknown {
  if (typeof value === "number") return round3(value);
  if (Array.isArray(value)) return value.map(roundReport);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = roundReport(v);
    return out;
  }
  return value;
}

export function makeReport(stages: StageStatus[], passport: Passport, errors: Issue[], warnings: Issue[]): Report {
  return { ok: errors.length === 0, stages, passport, errors, warnings };
}
