import { describe, it, expect, vi } from "vitest";
import { Bone, BoxGeometry, Group, Mesh, MeshBasicMaterial, PerspectiveCamera, Scene, Vector3, type Object3D } from "three";

// L154 / Н9 (а): опускание при посадке по телу, а не константа SIT_DROP = 0.45. Ягнёнок Мирай (0,95 м)
// уходил в пол. Свойство: у сидящего таз (тазобедренный сустав) на высоте сиденья ±3 см,
// сиденье = `top` места, без `top` — длина голени рига.

/** a standing humanoid drawn at 1.7 m (feet on y = 0, hip joints 0.87, knees 0.45, ankles 0.05), legs straight
 *  down, plus a 1.7 m box for the bbox (bones have none); the actor rescales it to its height_m */
function rig(): Group {
  const root = new Group();
  const mk = (name: string, parent: Object3D, x: number, y: number): Bone => {
    const b = new Bone();
    b.name = name;
    b.position.set(x, y, 0);
    parent.add(b);
    return b;
  };
  const hips = mk("Hips", root, 0, 0.92);
  for (const [s, x] of [["Left", 0.1], ["Right", -0.1]] as const) {
    const up = mk(`${s}UpLeg`, hips, x, -0.05);
    const lo = mk(`${s}Leg`, up, 0, -0.42);
    const foot = mk(`${s}Foot`, lo, 0, -0.4);
    mk(`${s}ToeBase`, foot, 0, -0.05);
  }
  const box = new Mesh(new BoxGeometry(0.3, 1.7, 0.2), new MeshBasicMaterial());
  box.position.y = 0.85;
  root.add(box);
  root.updateMatrixWorld(true);
  return root;
}

vi.mock("../src/runtime/assets.js", async (orig) => ({
  ...(await orig<typeof import("../src/runtime/assets.js")>()),
  loadGlb: async () => rig(),
}));

const { startStage } = await import("../src/runtime/stage/index.js");
const { createActor } = await import("../src/runtime/stage/actors.js");
const { legHeights, sitDrop } = await import("../src/runtime/stage/pose.js");

const outline: Array<[number, number]> = [[0, 0], [10, 0], [10, 10], [0, 10]];
const W = 250, H = 250;
const layer = { level: null, y: 0, origin: [0, 0], w: W, h: H };
const full = (): Uint8Array => new Uint8Array(Math.ceil((W * H) / 8)).fill(255);

const run = (stage: any, frames: number, t0 = 1): void => {
  for (let i = 0; i < frames; i++) stage.update(1 / 60, t0 + i / 60);
};
/** world y of the hip joints (mean of the two thigh bones) and the rig's shin (knee -> ankle) after scaling */
function measure(grp: Object3D): { pelvis: number; shin: number } {
  grp.updateMatrixWorld(true);
  const wp = (n: string): Vector3 => grp.getObjectByName(n)!.getWorldPosition(new Vector3());
  const pelvis = (wp("LeftUpLeg").y + wp("RightUpLeg").y) / 2;
  return { pelvis, shin: wp("LeftLeg").distanceTo(wp("LeftFoot")) };
}
async function seated(heightM: number, top: number | undefined, how: "start" | "touch" | "start_pose") {
  const extra = how === "start_pose" ? { start: { Kid: "chair" }, start_pose: { Kid: "sit" } } : {};
  const scene = new Scene();
  const stage = await runtimeIn(scene, heightM, top, extra);
  if (how === "start") stage.handlers.start!({ type: "start", who: "Kid", place: "chair", pose: "sit" } as any);
  if (how === "touch") {
    stage.handlers.touch!({ type: "touch", who: "Kid", place: "chair", pose: "sit" } as any);
    run(stage, 60 * 8);
  }
  run(stage, 10, 20);
  const act = stage.api.actors().find((a: any) => a.who === "Kid")!.act;
  return { act, ...measure(scene.getObjectByName("actor:Kid")!) };
}
async function runtimeIn(scene: Scene, heightM: number, top: number | undefined, stageExtra: Record<string, unknown>) {
  const chair: Record<string, unknown> = { name: "chair", id: "chair", kind: "sit", room: "room", level: null, at: [5, 5], yaw: 0, look: null, obstacle: null, poses: ["sit", "stand"] };
  if (top !== undefined) chair.top = top;
  const rug = { name: "rug", id: "rug", kind: "stand", room: "room", level: null, at: [2, 2], yaw: 0, look: null, obstacle: null, poses: ["stand"] };
  return startStage({
    scene, camera: new PerspectiveCamera(50, 1, 0.1, 100), stageUrl: "stage/stage.json", sim: null,
    stage: { mode: "book", places: "stage/places.json", cast: "cast/cast.json", start: { Kid: "rug" }, ...stageExtra },
    places: [chair, rug], cast: { Kid: { glb: "kid.glb", height_m: heightM } },
    geo: { spawn: { at: [3, 5] }, floors: [{ room: "room", level: null, outline }], meshes: [] },
    layers: [{ layer, bits: full() }], nav: { ramps: [], doors: {} }, doorOpen: () => false,
  } as any);
}

describe("seated actor: the pelvis lands on the seat (drop from the body, not SIT_DROP 0.45)", () => {
  const cases: Array<[number, number | undefined]> = [[0.95, undefined], [0.95, 0.3], [1.65, undefined], [1.65, 0.45]];
  for (const [h, top] of cases) {
    for (const how of ["start", "touch", "start_pose"] as const) {
      it(`height ${h} m, ${top === undefined ? "no top (seat = shin)" : `top ${top} m`}, seated by ${how}`, async () => {
        const b = await seated(h, top, how);
        expect(b.act).toBe("sit");
        const seat = top ?? b.shin;
        expect(Math.abs(b.pelvis - seat), `pelvis ${b.pelvis.toFixed(3)} vs seat ${seat.toFixed(3)}`).toBeLessThan(0.03);
      });
    }
  }
  it("standing again puts the feet back on the floor (no leftover drop)", async () => {
    const scene = new Scene();
    const stage = await runtimeIn(scene, 0.95, undefined, {});
    run(stage, 5);
    const standing = measure(scene.getObjectByName("actor:Kid")!).pelvis;
    stage.handlers.start!({ type: "start", who: "Kid", place: "chair", pose: "sit" } as any);
    run(stage, 5, 5);
    stage.handlers.start!({ type: "start", who: "Kid", place: "rug" } as any);
    run(stage, 5, 10);
    expect(measure(scene.getObjectByName("actor:Kid")!).pelvis).toBeCloseTo(standing, 3);
  });
  it("a seated actor that turns in place keeps its seat (top), not the shin", async () => {
    const a = await createActor("Kid", "kid.glb", 0.95, [5, 5], 0, 0);
    a.teleport([5, 5], 0, "sit", 0, 0.3);
    a.update(1 / 60, 1);
    const before = measure(a.group).pelvis;
    expect(before).toBeCloseTo(0.3, 2);
    a.go([], 90, "sit");
    for (let i = 0; i < 60; i++) a.update(1 / 60, 2 + i / 60);
    expect(a.act()).toBe("sit");
    expect(measure(a.group).pelvis).toBeCloseTo(before, 3);
  });
});

describe("legHeights / sitDrop", () => {
  it("measures the rig's hip joints and shin; a box has no legs", () => {
    const l = legHeights(rig())!;
    expect(l.pelvis).toBeCloseTo(0.87, 6);
    expect(l.shin).toBeCloseTo(0.4, 6);
    expect(legHeights(new Group())).toBeNull();
  });
  it("drop = pelvis - seat (top, else shin); no legs -> 0.45 m scaled by height", () => {
    const l = { pelvis: 0.87, shin: 0.4 };
    expect(sitDrop(l, 1.7)).toBeCloseTo(0.47, 6);
    expect(sitDrop(l, 1.7, 0.45)).toBeCloseTo(0.42, 6);
    expect(sitDrop(null, 1.7)).toBeCloseTo(0.45, 6);
    expect(sitDrop(null, 0.95)).toBeCloseTo(0.45 * 0.95 / 1.7, 6);
  });
});
