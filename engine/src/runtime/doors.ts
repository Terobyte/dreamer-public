/** Door state in the page: turn around the hinge, block the capsule, be touched. */
export const TURN_S = 0.6;
export const TOUCH_M = 1.2;

type P2 = [number, number];

/** One entry of `build.json` `doors` (hinge, swing sector ends from the passport). */
export interface DoorDef {
  id: string;
  rooms: string[];
  hinge_at: P2;
  swing: string | null;
  width: number;
  height: number;
  open: boolean;
  /** far jamb on the inner face: where the leaf tip is when closed */
  closed_end: P2;
  /** hinge + width along the swing normal: where the leaf tip is fully open */
  open_end: P2;
  /** leaf vertical span in world Y; older fixtures omit it and mean 0..height */
  y0?: number;
  y1?: number;
}

export type DoorState = "open" | "closed" | "locked";

export interface Door {
  def: DoorDef;
  open(): void;
  close(): void;
  lock(): void;
  unlock(): void;
  update(dt: number): void;
  state(): DoorState;
  /** degrees from closed, signed like the sweep toward `swing` */
  angle(): number;
  sweepDeg(): number;
  /** radians the leaf mesh has turned from the pose it was built in */
  meshTurn(): number;
  blocks(): boolean;
  /** hinge and current tip of the leaf */
  segment(): [P2, P2];
}

const dirAngle = (from: P2, to: P2): number => Math.atan2(to[0] - from[0], to[1] - from[1]);

/** Signed radians that turn the closed leaf onto the open one (wrapped to ±pi). */
export function sweepOf(def: DoorDef): number {
  let s = dirAngle(def.hinge_at, def.open_end) - dirAngle(def.hinge_at, def.closed_end);
  while (s > Math.PI) s -= 2 * Math.PI;
  while (s < -Math.PI) s += 2 * Math.PI;
  return s;
}

/** Where a mesh turned by `theta` (about +Y) around `pivot` sits: its position offset. */
export function pivotOffset(pivot: P2, theta: number): P2 {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return [pivot[0] - (pivot[0] * c + pivot[1] * s), pivot[1] - (-pivot[0] * s + pivot[1] * c)];
}

export function makeDoor(def: DoorDef, onBlock?: (blocked: boolean) => void): Door {
  const sweep = sweepOf(def);
  let want: DoorState = def.open ? "open" : "closed";
  let p = def.open ? 1 : 0;
  const blocks = (): boolean => want !== "open";
  const set = (next: DoorState): void => {
    const before = blocks();
    want = next;
    if (blocks() !== before) onBlock?.(blocks());
  };
  const door: Door = {
    def,
    open: () => {
      if (want !== "locked") set("open");
    },
    close: () => {
      if (want !== "locked") set("closed");
    },
    lock: () => set("locked"),
    unlock: () => {
      if (want === "locked") set("closed");
    },
    update(dt: number): void {
      const to = want === "open" ? 1 : 0;
      const d = dt / TURN_S;
      p = to > p ? Math.min(to, p + d) : Math.max(to, p - d);
    },
    state: () => want,
    angle: () => ((p * sweep) / Math.PI) * 180,
    sweepDeg: () => (sweep / Math.PI) * 180,
    meshTurn: () => (p - (def.open ? 1 : 0)) * sweep,
    blocks,
    segment(): [P2, P2] {
      const h = def.hinge_at;
      const a = p * sweep;
      const vx = def.closed_end[0] - h[0];
      const vz = def.closed_end[1] - h[1];
      const c = Math.cos(a);
      const s = Math.sin(a);
      return [h, [h[0] + vx * c + vz * s, h[1] - vx * s + vz * c]];
    },
  };
  return door;
}

/** The door whose leaf the player looks at from within `TOUCH_M`, nearest first. */
export function touchTarget(doors: Door[], at: P2, yawDeg: number, pitchDeg = 0, eyeY = 1.6): string | null {
  const yaw = (yawDeg * Math.PI) / 180;
  const dx = Math.sin(yaw);
  const dz = Math.cos(yaw);
  const tanP = Math.tan((pitchDeg * Math.PI) / 180);
  let best: string | null = null;
  let bestT = Infinity;
  for (const door of doors) {
    const [a, b] = door.segment();
    const ex = b[0] - a[0];
    const ez = b[1] - a[1];
    const den = dx * ez - dz * ex;
    if (Math.abs(den) < 1e-9) continue;
    const ax = a[0] - at[0];
    const az = a[1] - at[1];
    const t = (ax * ez - az * ex) / den;
    const s = (ax * dz - az * dx) / den;
    // written so a NaN (bad position or angle) fails the test instead of slipping past it
    if (!(t >= 0 && t <= TOUCH_M && s >= 0 && s <= 1 && t < bestT)) continue;
    // the gaze is a 3D ray: at horizontal distance t it climbs to eyeY + t*tan(pitch)
    const y0 = door.def.y0 ?? 0;
    const y1 = door.def.y1 ?? y0 + door.def.height;
    const y = eyeY + t * tanP;
    if (!(y >= y0 - 1e-9 && y <= y1 + 1e-9)) continue;
    best = door.def.id;
    bestT = t;
  }
  return best;
}

/** Set or clear one door's nav cells in a layer's bitmap (the walker shares the array). */
export function setCells(bits: Uint8Array, cells: number[], on: boolean): void {
  for (const n of cells) {
    if (on) bits[n >> 3] |= 1 << (n & 7);
    else bits[n >> 3] &= ~(1 << (n & 7));
  }
}
