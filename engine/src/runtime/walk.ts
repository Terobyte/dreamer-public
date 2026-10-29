import { floorAtRooms, navBit, rampUnder, rampWalkable, type NavLayer, type NavRamp } from "../nav/floor.js";
import type { V2 } from "../geom/vec.js";

export const EYE = 1.6;
export const SPEED = 1.4;

export interface Floor {
  y: number;
  outline: V2[];
}

export interface Walker {
  pos(): [number, number, number];
  /** Step by (dx, dz); a blocked cell slides along x and z on their own. */
  tryMove(dx: number, dz: number): [number, number, number];
  teleport(x: number, z: number): [number, number, number];
}

/** The layers and flights a walk may use beyond the one it starts on. */
export interface MoreNav {
  layers: Array<{ layer: NavLayer; bits: Uint8Array }>;
  ramps: NavRamp[];
}

/** Capsule walk over the nav bitmap: the cell under the capsule centre decides. */
export function makeWalker(
  layer: NavLayer,
  bits: Uint8Array,
  floors: Floor[],
  start: V2,
  more?: MoreNav,
): Walker {
  const layers = [{ layer, bits }, ...(more?.layers ?? [])];
  const ramps = more?.ramps ?? [];
  let x = start[0];
  let z = start[1];
  let fy = floorAtRooms(floors, x, z, layer.y, ramps) ?? layer.y;

  /**
   * On a flight the grid says nothing -- a ramp cuts across the layers it
   * joins -- so its own strip decides. Off it, the layer whose floor sits
   * closest to the height the capsule is standing at owns the cell.
   */
  const open = (nx: number, nz: number): boolean => {
    // the same flight `floorAtRooms` stands the capsule on, not just the
    // first footprint hit: stacked flights share a plan
    const on = rampUnder(ramps, nx, nz, fy);
    if (on.inside) return on.ramp !== null && rampWalkable(on.ramp, nx, nz);
    let best = layers[0];
    for (const L of layers) {
      if (Math.abs(L.layer.y - fy) < Math.abs(best.layer.y - fy)) best = L;
    }
    return navBit(best.layer, best.bits, nx, nz);
  };

  const step = (nx: number, nz: number): boolean => {
    if (!open(nx, nz)) return false;
    const y = floorAtRooms(floors, nx, nz, fy, ramps);
    if (y === null) return false;
    x = nx;
    z = nz;
    fy = y;
    return true;
  };

  const here = (): [number, number, number] => [x, fy + EYE, z];

  return {
    pos: here,
    tryMove(dx: number, dz: number): [number, number, number] {
      if (!step(x + dx, z + dz)) {
        if (dx !== 0) step(x + dx, z);
        if (dz !== 0) step(x, z + dz);
      }
      return here();
    },
    teleport(nx: number, nz: number): [number, number, number] {
      if (!open(nx, nz)) throw new Error(`cell (${nx}, ${nz}) is not walkable`);
      const y = floorAtRooms(floors, nx, nz, fy, ramps);
      if (y === null) throw new Error(`no floor under (${nx}, ${nz})`);
      x = nx;
      z = nz;
      fy = y;
      return here();
    },
  };
}

export interface Keys {
  dir(yaw: number, dt: number): [number, number];
  yaw(): number;
  pitch(): number;
}

export const PITCH_MAX = 85;

/** One mouse step of look, 0.2 deg/px; pitch (up +) stays within +-PITCH_MAX. */
export function mouseLook(yaw: number, pitch: number, mx: number, my: number): [number, number] {
  const p = Math.max(-PITCH_MAX, Math.min(PITCH_MAX, pitch - my * 0.2));
  return [yaw - mx * 0.2, p];
}

/** WASD + mouse look; the pointer locks on click, as a walk-around page does. */
export function controls(dom: HTMLElement, yaw0: number): Keys {
  const down = new Set<string>();
  let yaw = yaw0;
  let pitch = 0;
  addEventListener("keydown", (e) => down.add(e.code));
  addEventListener("keyup", (e) => down.delete(e.code));
  dom.addEventListener("click", () => void dom.requestPointerLock?.());
  addEventListener("mousemove", (e) => {
    if (document.pointerLockElement === dom) [yaw, pitch] = mouseLook(yaw, pitch, e.movementX, e.movementY);
  });
  return {
    yaw: () => yaw,
    pitch: () => pitch,
    dir(y: number, dt: number): [number, number] {
      const f = (down.has("KeyW") ? 1 : 0) - (down.has("KeyS") ? 1 : 0);
      const s = (down.has("KeyD") ? 1 : 0) - (down.has("KeyA") ? 1 : 0);
      if (f === 0 && s === 0) return [0, 0];
      const a = (y * Math.PI) / 180;
      // yaw 0 faces +Z, 90 faces +X (angle table)
      const fx = Math.sin(a);
      const fz = Math.cos(a);
      const len = Math.hypot(f, s);
      const d = (SPEED * dt) / len;
      return [(f * fx + s * fz) * d, (f * fz - s * fx) * d];
    },
  };
}
