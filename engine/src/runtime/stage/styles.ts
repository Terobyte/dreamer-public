import { MOVES, SCHEMES } from "./moves.js";

/** К2 (camera moves): a style is a row of data (weights, rhythm, height, fov, shake); `pickMove` is the one place that
 *  turns a style plus the beat's tags into a move id. All randomness goes through the passed `rng`. */

export interface Style {
  /** weight per move/scheme id (order = order of the draw) */
  weights: Record<string, number>;
  /** wanted plan length, seconds (soft) */
  asl: [number, number];
  /** camera height above the room floor, metres (a wish: `legalCameraPoint` has the last word) */
  height: [number, number];
  /** vertical fov, degrees */
  fov: [number, number];
  /** shake, metres */
  shake: [number, number];
  /** share of plans with an `end`, 0..1 */
  move: number;
  cut: "hard" | "long";
  /** preference for frontal plans, 0..1 */
  symmetry: number;
  /** moves only as accents (scene start/end, entrance, look, a spoken line); other beats keep the base frames */
  accent?: boolean;
}
export interface MoveTags {
  first?: boolean;
  enter?: boolean;
  look?: boolean;
  last?: boolean;
}
export interface Pick {
  id: string;
  warnings: string[];
}

const st = (move: number, asl: [number, number], height: [number, number], fov: [number, number], shake: [number, number], cut: "hard" | "long", symmetry: number, weights: Record<string, number>): Style => ({ weights, asl, height, fov, shake, move, cut, symmetry });

const TABLE: Record<string, Style> = {
  // calm since Nov 3 (k12_storybook film read "effect for effect", trembling): mostly still plans, no shake, adult eye
  // height (0.6 m child_eye shot the Koshakan bedroom from inside the bed and missed Mirai lying on it)
  storybook: { ...st(0.35, [5, 8], [1.1, 1.5], [38, 50], [0, 0], "hard", 0.2, { medium: 3, wide: 2, close: 2, push_in: 1, pull_out: 1 }), accent: true },
  spielberg: st(0.8, [5, 9], [0.5, 1.5], [35, 55], [0.001, 0.004], "long", 0.2, { slow_push: 3, oner: 0, low: 2, crane_up: 1, over_the_shoulder: 2, reaction_cut: 2, wide: 1, close: 1 }),
  ozu: st(0, [6, 8], [0.5, 0.9], [40, 50], [0, 0], "long", 0.6, { tatami: 4, frontal: 3, medium: 2, wide: 1 }),
  anderson: st(0.3, [4, 6], [1.2, 1.5], [40, 55], [0, 0], "hard", 0.9, { frontal: 4, master: 2, truck: 2, whip_pan: 1, medium: 1 }),
  malick: st(0.9, [4, 8], [0.8, 1.7], [55, 75], [0.004, 0.008], "long", 0.1, { handheld: 3, drift: 2, arc: 2, low: 1, detail: 2, wide: 1 }),
  fincher: st(0.6, [2, 4], [1.0, 1.4], [32, 45], [0, 0], "hard", 0.4, { steadicam: 2, push_in: 3, close: 2, over_the_shoulder: 2, medium: 1 }),
  kubrick: st(0.5, [6, 9], [1.2, 1.5], [35, 45], [0, 0], "long", 0.9, { frontal: 3, slow_push: 3, master: 2, wide: 1 }),
  miyazaki: st(0.5, [6, 10], [0.6, 1.4], [40, 55], [0.001, 0.003], "long", 0.2, { drift: 2, pull_out: 2, wide: 3, detail: 1, medium: 1 }),
};

/** ids that only the bridge executes (`planScheme` on a list of beats): the director never picks them */
export const BRIDGE_ONLY = new Set(["oner", "rhythm_cut", "open_from_light"]);
/** the director never frames walkers from the front on a line */
const WALK_ONLY = new Set(["follow_behind", "lead"]);
const SYM_KEEP = new Set(["frontal", "tatami", "master", "medium"]);
/** schemes that move (atoms: `MoveDef.moving`) */
const MOVING_SCHEMES = new Set(["oner", "final_pull_out"]);
/** static stand-ins for forced scheme ids */
const SCHEME_STATIC: Record<string, string> = { final_pull_out: "wide" };

export function isMoving(id: string): boolean {
  return MOVES[id] ? MOVES[id].moving : MOVING_SCHEMES.has(id);
}
export function staticOf(id: string): string {
  return MOVES[id]?.staticOf ?? SCHEME_STATIC[id] ?? id;
}

/** throws on an id outside `MOVES ∪ SCHEMES` or a negative weight; returns the table */
export function validateStyles<T extends Record<string, Style>>(table: T): T {
  for (const [name, s] of Object.entries(table))
    for (const [id, w] of Object.entries(s.weights)) {
      if (!MOVES[id] && !SCHEMES[id]) throw new Error(`STYLE_UNKNOWN_MOVE ${name}.${id}`);
      if (!(w >= 0)) throw new Error(`STYLE_BAD_WEIGHT ${name}.${id}`);
    }
  return table;
}
export const STYLES: Record<string, Style> = validateStyles(TABLE);

/** One draw, fixed order: tag forcing, candidates, moving coin, weighted draw. `line` = the event is a spoken line. */
export function pickMove(style: Style, tags: MoveTags, rng: () => number, opts: { line?: boolean; noWalk?: boolean } = {}): Pick {
  const warnings: string[] = [];
  const forced = tags.last ? "final_pull_out" : tags.first ? "establishing" : tags.enter ? (opts.noWalk ? "crane_down" : "follow_side") : tags.look ? "over_the_shoulder" : null;
  if (forced) {
    const bad = (style.move === 0 && isMoving(forced)) || (!!opts.line && WALK_ONLY.has(forced));
    if (!bad) return { id: forced, warnings };
    warnings.push(`TAG_STATIC ${forced}`);
    return { id: staticOf(forced), warnings };
  }
  const sym = style.symmetry >= 0.6;
  const cands: Array<[string, number]> = [];
  for (const [id, w0] of Object.entries(style.weights)) {
    if (!(w0 > 0)) continue;
    if (BRIDGE_ONLY.has(id)) continue;
    if (style.move === 0 && isMoving(id)) continue;
    if (opts.line && WALK_ONLY.has(id)) continue;
    cands.push([id, sym && !SYM_KEEP.has(id) ? w0 / 4 : w0]);
  }
  const wantMoving = rng() < style.move;
  let pool = cands.filter(([id]) => isMoving(id) === wantMoving);
  if (!pool.length) pool = cands.filter(([id]) => isMoving(id) !== wantMoving);
  if (!pool.length) return { id: "wide", warnings };
  const sum = pool.reduce((a, [, w]) => a + w, 0);
  let r = rng() * sum;
  for (const [id, w] of pool) {
    if (r < w) return { id, warnings };
    r -= w;
  }
  return { id: pool[pool.length - 1][0], warnings };
}
