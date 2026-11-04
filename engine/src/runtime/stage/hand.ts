/** Hand placement for one scene (`stage.hand` -> hand.json): from a beat on, an actor stands where the hand put her,
 *  as in Sonnet's Koshakan demo (story.js: p0 / yaw per segment). The rules place everyone else; a pin is the last
 *  word for its actor until a later pin or her next move. The user, Nov 3: the lap hug is too fine for the rules. */
import type { V2 } from "./places.js";

export interface HandPin {
  beat: number;
  who: string;
  /** relative to this actor: fwd / left of her root along her yaw (m), up from her support (m), yaw off hers (deg) */
  rel?: string;
  fwd?: number;
  left?: number;
  up?: number;
  /** world: ground point and support height */
  at?: V2;
  y?: number;
  yaw?: number;
}

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** hand.json -> pins sorted by beat; a pin without an integer beat, a name, or a place (`rel` or `at`) is dropped */
export function parseHand(raw: unknown, warnings: string[]): HandPin[] {
  const pins = (raw as { pins?: unknown } | null)?.pins;
  if (!Array.isArray(pins)) return [];
  const out: HandPin[] = [];
  for (const p of pins as Array<Record<string, unknown>>) {
    const ok = p && Number.isInteger(p.beat) && typeof p.who === "string"
      && (typeof p.rel === "string" || (Array.isArray(p.at) && p.at.length === 2 && p.at.every(num)));
    if (!ok) {
      warnings.push(`stage: hand pin ${JSON.stringify(p)} needs beat, who and rel or at -> dropped`);
      continue;
    }
    const pin: HandPin = { beat: p.beat as number, who: p.who as string };
    if (typeof p.rel === "string") {
      pin.rel = p.rel;
      for (const k of ["fwd", "left", "up"] as const) if (num(p[k])) pin[k] = p[k] as number;
    } else pin.at = [(p.at as number[])[0]!, (p.at as number[])[1]!];
    if (num(p.y)) pin.y = p.y;
    if (num(p.yaw)) pin.yaw = p.yaw;
    out.push(pin);
  }
  return out.sort((a, b) => a.beat - b.beat);
}

/** where a pin puts its actor; `rel` = the other actor now (null when the pin is relative and she is not there).
 *  A null y / yaw keeps the actor's own. */
export function pinPose(pin: HandPin, rel: { pos: V2; yaw: number; y: number } | null): { at: V2; y: number | null; yaw: number | null } | null {
  if (!pin.rel) return { at: pin.at!, y: pin.y ?? null, yaw: pin.yaw ?? null };
  if (!rel) return null;
  const r = (rel.yaw * Math.PI) / 180;
  const f: V2 = [Math.sin(r), Math.cos(r)], l: V2 = [Math.cos(r), -Math.sin(r)];
  const fw = pin.fwd ?? 0, lf = pin.left ?? 0;
  return {
    at: [rel.pos[0] + f[0] * fw + l[0] * lf, rel.pos[1] + f[1] * fw + l[1] * lf],
    y: rel.y + (pin.up ?? 0),
    yaw: pin.yaw === undefined ? null : (((rel.yaw + pin.yaw) % 360) + 360) % 360,
  };
}
