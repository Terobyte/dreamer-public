/**
 * D4 (decision 5): the diegetic "загрузка" plaque, made at run time (engine/src/decals is
 * build-time only). Bridge event `placard {door, text, id?}` hangs it on a door
 * (anchor and orientation from DoorDef: middle of the doorway, along the door line);
 * `{clear: true, door?}` takes it (or all of them) down. No assets: a canvas texture.
 */
import * as THREE from "three";
import type { DoorDef } from "./doors.js";
import type { StageEvent } from "./bridge.js";

export interface PlacardPose {
  pos: [number, number, number];
  /** turn about world Y that lays a +Z-facing plane into the door plane */
  yaw: number;
}

export interface PlacardHandle {
  remove(): void;
}

export interface PlacardDeps {
  door(id: string): DoorDef | null | undefined;
  add(text: string, pose: PlacardPose): PlacardHandle;
  warn(msg: string): void;
}

/** Middle of the doorway, a bit above the handle, lying in the door's plane. */
export function placardPose(def: DoorDef): PlacardPose {
  const [hx, hz] = def.hinge_at;
  const [cx, cz] = def.closed_end;
  const y0 = def.y0 ?? 0;
  const y1 = def.y1 ?? y0 + def.height;
  return {
    pos: [(hx + cx) / 2, y0 + 0.65 * (y1 - y0), (hz + cz) / 2],
    yaw: -Math.atan2(cz - hz, cx - hx),
  };
}

export function createPlacards(deps: PlacardDeps): { handle(e: StageEvent): boolean; active(): string[] } {
  const up = new Map<string, PlacardHandle>();
  const clear = (id: string): void => {
    up.get(id)?.remove();
    up.delete(id);
  };
  return {
    // F6: true only when a plaque was actually hung (a clear always succeeds);
    // the page confirms the effect to the sim only then
    handle(e: StageEvent): boolean {
      const id = typeof e.door === "string" ? e.door : null;
      if (e.clear === true) {
        if (id) clear(id);
        else for (const k of [...up.keys()]) clear(k);
        return true;
      }
      const def = id ? deps.door(id) : null;
      if (!id || !def) {
        deps.warn(`placard: door "${String(e.door)}" is not in the engine scene`);
        return false;
      }
      clear(id);
      up.set(id, deps.add(String(e.text ?? "загрузка"), placardPose(def)));
      return true;
    },
    active: () => [...up.keys()],
  };
}

/** The page's adder: a two-faced canvas plane in front of and behind the leaf. */
export function threePlacard(scene: THREE.Object3D, doc: Document): PlacardDeps["add"] {
  return (text, pose) => {
    const c = doc.createElement("canvas");
    c.width = 512;
    c.height = 160;
    const g = c.getContext("2d");
    if (g) {
      g.fillStyle = "#f4ead2";
      g.fillRect(0, 0, c.width, c.height);
      g.strokeStyle = "#5a4630";
      g.lineWidth = 10;
      g.strokeRect(5, 5, c.width - 10, c.height - 10);
      g.fillStyle = "#3a2c1c";
      g.font = "bold 72px serif";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(text, c.width / 2, c.height / 2);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false });
    const geo = new THREE.PlaneGeometry(0.6, 0.19);
    const group = new THREE.Group();
    for (const side of [1, -1]) {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(0, 0, side * 0.07);
      if (side < 0) m.rotation.y = Math.PI;
      group.add(m);
    }
    group.position.set(...pose.pos);
    group.rotation.y = pose.yaw;
    group.name = "placard";
    scene.add(group);
    return {
      remove: () => {
        scene.remove(group);
        geo.dispose();
        mat.dispose();
        tex.dispose();
      },
    };
  };
}
