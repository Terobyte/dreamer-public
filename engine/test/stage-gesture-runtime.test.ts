import { describe, it, expect } from "vitest";
import { PerspectiveCamera, Scene, Group, Object3D, Quaternion } from "three";
import { startStage, lineSeed } from "../src/runtime/stage/index.js";
import { applyNod } from "../src/runtime/stage/actors.js";

const outline: Array<[number, number]> = [[0, 0], [10, 0], [10, 10], [0, 10]];
const places: any[] = [
  { name: "bed", id: "bed", kind: "sit", room: "room", level: null, at: [5, 5], yaw: 0,
    look: null, obstacle: null, poses: ["lie", "sit", "stand"], lie: { at: [5, 5], yaw: 180, head: [5, 5.5] } },
];
function boot(opts: { start_pose?: Record<string, string>; seed?: string; clips?: Record<string, string> }) {
  const scene = new Scene();
  const bits = new Uint8Array(Math.ceil((250 * 250) / 8));
  bits.fill(255);
  const layer = { level: null, y: 0, origin: [0, 0], w: 250, h: 250 };
  const stage = startStage({
    scene, camera: new PerspectiveCamera(50, 1, 0.1, 100), stageUrl: "stage/stage.json", sim: null,
    stage: { mode: "book", places: "stage/places.json", cast: "cast/cast.json",
      start: { Mama: "bed" }, start_pose: opts.start_pose, seed: opts.seed },
    places, cast: { Mama: { glb: "missing.glb", height_m: 1.7, clips: opts.clips ?? {} } },
    geo: { spawn: { at: [3, 5] }, floors: [{ room: "room", level: null, outline }], meshes: [] },
    layers: [{ layer, bits }], nav: { ramps: [], doors: {} }, doorOpen: () => false,
  } as any);
  return { scene, stage };
}
const groupOf = (scene: Scene, who: string): Group => scene.getObjectByName(`actor:${who}`) as Group;

describe("procedural gesture runtime (Н17 F2/F6)", () => {
  it("start_pose lie with no start/stage events -> line picks the procedural fallback, a bounded gesture plays", async () => {
    const { scene, stage } = boot({ start_pose: { Mama: "lie" }, clips: { shrug: "m/s.glb" } });
    const st = await stage;
    // talk is 1 s (dur), the gesture lasts 1.5 s: the (1.0, 1.5) window has gesture only
    st.handlers.line!({ type: "line", who: "Mama", text: "Well.", remarks: "sigh", dur: 0.5 });
    let peak = 0;
    for (let t = 1.01; t < 1.5; t += 1 / 60) {
      st.update(1 / 60, t);
      peak = Math.max(peak, Math.abs(groupOf(scene, "Mama").rotation.x));
    }
    expect(peak).toBeGreaterThan(0.01);
    st.update(1 / 60, 5);
    expect(Math.abs(groupOf(scene, "Mama").rotation.x)).toBeLessThan(1e-6);
  });
});

describe("line seed uses the scene seed (F7)", () => {
  it("same scene seed + index -> same seed; other scene seed or index -> other seed", () => {
    expect(lineSeed("sceneA", 0)).toBe(lineSeed("sceneA", 0));
    expect(lineSeed("sceneA", 0)).not.toBe(lineSeed("sceneB", 0));
    expect(lineSeed("sceneA", 0)).not.toBe(lineSeed("sceneA", 1));
  });
});

describe("procedural nod targets head/chest (F8)", () => {
  it("moves head and chest nodes, never the group; undo restores", () => {
    const root = new Group();
    const chest = new Object3D(); chest.name = "Chest";
    const head = new Object3D(); head.name = "Head";
    root.add(chest); chest.add(head);
    const undo = applyNod(root, 0.05);
    expect(head.quaternion.equals(new Quaternion())).toBe(false);
    expect(root.quaternion.equals(new Quaternion())).toBe(true);
    expect(head.quaternion.angleTo(new Quaternion())).toBeLessThanOrEqual(0.07);
    undo();
    expect(head.quaternion.equals(new Quaternion())).toBe(true);
    expect(chest.quaternion.equals(new Quaternion())).toBe(true);
  });
  it("safe on rigs without named bones: no throw, group untouched", () => {
    const bare = new Group();
    expect(() => { applyNod(bare, 0.06)(); }).not.toThrow();
    expect(bare.quaternion.equals(new Quaternion())).toBe(true);
  });
});
