import { floorAtRooms, navBit, type NavLayer } from "../nav/floor.js";
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

/** Capsule walk over the nav bitmap: the cell under the capsule centre decides. */
export function makeWalker(layer: NavLayer, bits: Uint8Array, floors: Floor[], start: V2): Walker {
  let x = start[0];
  let z = start[1];
  let fy = floorAtRooms(floors, x, z, layer.y) ?? layer.y;

  const step = (nx: number, nz: number): boolean => {
    if (!navBit(layer, bits, nx, nz)) return false;
    const y = floorAtRooms(floors, nx, nz, fy);
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
      if (!navBit(layer, bits, nx, nz)) throw new Error(`cell (${nx}, ${nz}) is not walkable`);
      const y = floorAtRooms(floors, nx, nz, fy);
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
}

/** WASD + mouse look; the pointer locks on click, as a walk-around page does. */
export function controls(dom: HTMLElement, yaw0: number): Keys {
  const down = new Set<string>();
  let yaw = yaw0;
  addEventListener("keydown", (e) => down.add(e.code));
  addEventListener("keyup", (e) => down.delete(e.code));
  dom.addEventListener("click", () => void dom.requestPointerLock?.());
  addEventListener("mousemove", (e) => {
    if (document.pointerLockElement === dom) yaw -= e.movementX * 0.2;
  });
  return {
    yaw: () => yaw,
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
