import { describe, it, expect, vi } from "vitest";
import { Bone, BoxGeometry, Group, Mesh, MeshBasicMaterial, PerspectiveCamera, Scene, Vector3, type Object3D } from "three";

// cast-auto: sitting down / standing up is eased over SEAT_S (0.6 s), not a pop. Was: L154 / Н9 (а): опускание при посадке по телу, а не константа SIT_DROP = 0.45. Ягнёнок Мирай (0,95 м)
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


function pelvisY(grp: Object3D): number {
  grp.updateMatrixWorld(true);
  const wp = (n: string): Vector3 => grp.getObjectByName(n)!.getWorldPosition(new Vector3());
  return (wp("LeftUpLeg").y + wp("RightUpLeg").y) / 2;
}

describe("sit down / stand up are eased, not a pop", () => {
  it("the pelvis goes down over ~0.6 s after the actor sits, then rests on the seat", async () => {
    const a = await createActor("Kid", "kid.glb", 1.7, [5, 5], 0, 0);
    a.update(1 / 60, 1);
    const standing = pelvisY(a.group);
    a.go([], 0, "sit", 0, 0.45);
    let t = 1;
    a.update(1 / 60, (t += 1 / 60));
    expect(a.act()).toBe("sit");
    const first = pelvisY(a.group);
    expect(standing - first, "no pop: the first seated frame is still near standing").toBeLessThan(0.05);
    for (let i = 0; i < 17; i++) a.update(1 / 60, (t += 1 / 60));
    const mid = pelvisY(a.group);
    expect(mid).toBeLessThan(first - 0.05);
    expect(mid).toBeGreaterThan(0.45 + 0.05);
    for (let i = 0; i < 40; i++) a.update(1 / 60, (t += 1 / 60));
    expect(pelvisY(a.group)).toBeCloseTo(0.45, 1);
  });
  it("a walk from a seat waits until the actor has stood up, then leaves with straight legs", async () => {
    const a = await createActor("Kid", "kid.glb", 1.7, [5, 5], 0, 0);
    a.teleport([5, 5], 0, "sit", 0, 0.45);
    a.update(1 / 60, 1);
    expect(pelvisY(a.group)).toBeCloseTo(0.45, 1);
    a.go([[7, 5]], 90, "idle");
    let t = 1;
    for (let i = 0; i < 15; i++) a.update(1 / 60, (t += 1 / 60));
    expect(a.pos()[0], "still at the seat while rising").toBeCloseTo(5, 6);
    for (let i = 0; i < 120; i++) a.update(1 / 60, (t += 1 / 60));
    expect(a.pos()[0]).toBeGreaterThan(5.5);
    expect(pelvisY(a.group)).toBeGreaterThan(0.8);
  });
});
