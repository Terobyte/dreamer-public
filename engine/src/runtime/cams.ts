import { OrthographicCamera, PerspectiveCamera, Vector3 } from "three";

export type AnyCamera = PerspectiveCamera | OrthographicCamera;

export interface CamSetup {
  camera: AnyCamera;
  mode: "walk" | "fixed" | "top";
  /** Mesh kinds the view hides (the top view drops ceilings and beams). */
  hide: Set<string>;
  error?: string;
}

/** Facing direction of a `yaw` in degrees, by the angle table (0 = +Z). */
export function yawDir(yaw: number): Vector3 {
  const a = (yaw * Math.PI) / 180;
  return new Vector3(Math.sin(a), 0, Math.cos(a));
}

/** Look direction of a `yaw` and a `pitch` (up +) in degrees: yaw, then pitch. */
export function lookDir(yaw: number, pitch: number): Vector3 {
  const a = (yaw * Math.PI) / 180;
  const b = (pitch * Math.PI) / 180;
  return new Vector3(Math.sin(a) * Math.cos(b), Math.sin(b), Math.cos(a) * Math.cos(b));
}

function walkCamera(aspect: number): PerspectiveCamera {
  return new PerspectiveCamera(70, aspect, 0.05, 500);
}

export function pickCamera(geo: any, params: URLSearchParams, aspect: number): CamSetup {
  const camId = params.get("cam");
  if (camId !== null) {
    const c = (geo.cameras ?? []).find((x: any) => String(x.id) === camId);
    if (!c) {
      return { camera: walkCamera(aspect), mode: "fixed", hide: new Set(), error: `unknown camera "${camId}"` };
    }
    const camera = new PerspectiveCamera(Number(c.fov ?? 60), aspect, 0.05, 500);
    camera.position.set(c.pos[0], c.pos[1], c.pos[2]);
    const look = c.look ?? [c.pos[0], c.pos[1], c.pos[2] - 1];
    camera.lookAt(look[0], look[1], look[2]);
    camera.updateMatrixWorld();
    return { camera, mode: "fixed", hide: new Set() };
  }

  if (params.get("top") === "1") {
    // framed on the actual mesh vertices, not the floor outlines: a wall or
    // cap body straddles the outline (it's centered on the wall axis, half
    // its thickness on either side) and sticks out past it (F13)
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const m of (geo.meshes ?? []) as any[]) {
      const pos = m.positions as number[];
      for (let i = 0; i < pos.length; i += 3) {
        minX = Math.min(minX, pos[i]);
        maxX = Math.max(maxX, pos[i]);
        minZ = Math.min(minZ, pos[i + 2]);
        maxZ = Math.max(maxZ, pos[i + 2]);
      }
    }
    const w = Math.max(maxX - minX, 1e-3);
    const h = Math.max(maxZ - minZ, 1e-3);
    const half = Math.max(w / 2, (h / 2) * aspect);
    const camera = new OrthographicCamera(-half, half, half / aspect, -half / aspect, 0.1, 1000);
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    camera.position.set(cx, geo.spawn.y + 100, cz);
    camera.up.set(0, 0, -1);
    camera.lookAt(cx, geo.spawn.y, cz);
    camera.updateMatrixWorld();
    return { camera, mode: "top", hide: new Set(["ceiling", "beam"]) };
  }

  return { camera: walkCamera(aspect), mode: "walk", hide: new Set() };
}
