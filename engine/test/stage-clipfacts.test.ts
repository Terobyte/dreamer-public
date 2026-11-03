import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AnimationClip, Bone, BoxGeometry, Float32BufferAttribute, Group, MeshStandardMaterial, PerspectiveCamera, Quaternion,
  QuaternionKeyframeTrack, Scene, Skeleton, SkinnedMesh, Uint16BufferAttribute, Vector3, VectorKeyframeTrack, type Object3D,
} from "three";
import { Document, NodeIO } from "@gltf-transform/core";

const store = vi.hoisted(() => ({ bodies: new Map<string, () => any>(), clips: new Map<string, any>() }));

vi.mock("../src/runtime/assets.js", async (orig) => {
  const m: any = await orig();
  return {
    ...m,
    loadGlb: async (src: any, box: any) => {
      const make = store.bodies.get(src.glb);
      return make ? make() : m.loadGlb(src, box);
    },
  };
});
vi.mock("three/examples/jsm/loaders/GLTFLoader.js", async (orig) => {
  const m: any = await orig();
  class L extends m.GLTFLoader {
    loadAsync(url: string, ...rest: any[]): Promise<any> {
      const c = store.clips.get(url);
      if (c) return Promise.resolve({ animations: [c], scene: new Group() });
      return super.loadAsync(url, ...rest);
    }
  }
  return { ...m, GLTFLoader: L };
});

import { clipFacts, lowestSkinY, writeClipfacts } from "../src/runtime/stage/clipfacts.js";
import { createActor, prepareActorBody } from "../src/runtime/stage/actors.js";
import { createAnimator } from "../src/runtime/stage/anim.js";
import { startStage } from "../src/runtime/stage/index.js";

afterEach(() => {
  vi.restoreAllMocks();
  store.bodies.clear();
  store.clips.clear();
});

type V3 = [number, number, number];
const Y = new Vector3(0, 1, 0);
const X = new Vector3(1, 0, 0);
const Z = new Vector3(0, 0, 1);
const qa = (axis: Vector3, deg: number): number[] => new Quaternion().setFromAxisAngle(axis, (deg * Math.PI) / 180).toArray() as number[];

/** root (0,0,0) -> hips (0, hipsY, 0) -> head; a skinned box (0.2 wide, boxH tall) centred on hips, weight 1 on hips */
function makeBody(o: { boxH?: number; hipsY?: number; meshY?: number; arms?: boolean } = {}): Group {
  const boxH = o.boxH ?? 0.2;
  const hipsY = o.hipsY ?? 0.2;
  const body = new Group();
  body.name = "body";
  const rootBone = new Bone();
  rootBone.name = "root";
  const hips = new Bone();
  hips.name = "hips";
  hips.position.set(0, hipsY, 0);
  const head = new Bone();
  head.name = "head";
  rootBone.add(hips);
  hips.add(head);
  const bones = [rootBone, hips, head];
  if (o.arms) {
    for (const s of ["l", "r"]) {
      const a = new Bone();
      a.name = `upperarm_${s}`;
      hips.add(a);
      bones.push(a);
    }
  }
  const geo = new BoxGeometry(0.2, boxH, 0.2);
  geo.translate(0, hipsY, 0);
  const n = geo.attributes.position.count;
  const idx: number[] = [];
  const w: number[] = [];
  for (let i = 0; i < n; i++) {
    idx.push(1, 0, 0, 0);
    w.push(1, 0, 0, 0);
  }
  geo.setAttribute("skinIndex", new Uint16BufferAttribute(idx, 4));
  geo.setAttribute("skinWeight", new Float32BufferAttribute(w, 4));
  const mesh = new SkinnedMesh(geo, new MeshStandardMaterial());
  mesh.position.y = o.meshY ?? 0;
  body.add(rootBone);
  body.add(mesh);
  body.updateMatrixWorld(true);
  mesh.bind(new Skeleton(bones));
  return body;
}

/** head held at `pos` with rotation `rot` for the whole clip */
function headClip(name: string, pos: V3, rot: number[], d = 1): AnimationClip {
  return new AnimationClip(name, -1, [
    new VectorKeyframeTrack("head.position", [0, d], [...pos, ...pos]),
    new QuaternionKeyframeTrack("head.quaternion", [0, d], [...rot, ...rot]),
  ]);
}
const LIE = (): AnimationClip => headClip("lie", [0.6, 0, 0], qa(Y, 90));
const STAND = (): AnimationClip => headClip("stand", [0, 0.7, 0], qa(Y, 0));

describe("clipFacts (Г4)", () => {
  it("lying: contact_y, face_yaw 90, head_y, lying", () => {
    const f = clipFacts(makeBody(), LIE(), 1.0)!;
    expect(f.contact_y).toBeCloseTo(0.1, 2);
    expect(Math.abs(f.contact_y - 0.1)).toBeLessThanOrEqual(0.005);
    expect(Math.abs(f.face_yaw! - 90)).toBeLessThanOrEqual(1);
    expect(Math.abs(f.head_y - 0.1)).toBeLessThanOrEqual(0.005);
    expect(f.lying).toBe(true);
  });

  it("a calibration head (0.5 s bind pose) is cut like the runtime does: still lying", () => {
    const arm = (s: string) => new QuaternionKeyframeTrack(`upperarm_${s}.quaternion`, [0, 0.5, 0.52, 0.6],
      [...qa(Z, 0), ...qa(Z, 0), ...qa(Z, 90), ...qa(Z, 90)]);
    const lieRot = qa(Y, 90);
    const clip = new AnimationClip("lie", -1, [
      new VectorKeyframeTrack("head.position", [0, 0.5, 0.52, 0.6], [0, 0.7, 0, 0, 0.7, 0, 0.6, 0, 0, 0.6, 0, 0]),
      new QuaternionKeyframeTrack("head.quaternion", [0, 0.5, 0.52, 0.6], [...qa(Y, 0), ...qa(Y, 0), ...lieRot, ...lieRot]),
      arm("l"), arm("r"),
    ]);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const plain = clipFacts(makeBody({ arms: true }), LIE(), 1.0)!;
    const cut = clipFacts(makeBody({ arms: true }), clip, 1.0)!;
    expect(plain.lying).toBe(true);
    expect(cut.lying).toBe(true);
  });

  it("face up -> face_yaw null", () => {
    const f = clipFacts(makeBody(), headClip("up", [0.6, 0, 0], qa(X, -90)), 1.0)!;
    expect(f.face_yaw).toBeNull();
    expect(f.face_dir[1]).toBeGreaterThan(0.8);
  });

  it("head 350° -> 10° averages across 0°, not near 180", () => {
    const clip = new AnimationClip("turn", -1, [new QuaternionKeyframeTrack("head.quaternion", [0, 1], [...qa(Y, 350), ...qa(Y, 10)])]);
    const y = clipFacts(makeBody(), clip, 1.0)!.face_yaw!;
    expect(y >= 355 || y <= 5).toBe(true);
  });

  it("opposite directions cancel -> face_dir of frame 0", () => {
    const keys = [0, 180, 0, 180, 0].flatMap((d) => qa(Y, d));
    const clip = new AnimationClip("flip", -1, [new QuaternionKeyframeTrack("head.quaternion", [0, 0.25, 0.5, 0.75, 1], keys)]);
    const f = clipFacts(makeBody(), clip, 1.0)!;
    expect(f.face_dir[0]).toBeCloseTo(0, 3);
    expect(f.face_dir[1]).toBeCloseTo(0, 3);
    expect(f.face_dir[2]).toBeCloseTo(1, 3);
  });

  it("lowestSkinY uses world skin points (mesh offset inside the body)", () => {
    const a = makeBody();
    const b = makeBody({ meshY: 0.5 });
    expect(lowestSkinY(b) - lowestSkinY(a)).toBeCloseTo(0.5, 3);
  });

  it("face_yaw is in the actor's axes (root turned 90°)", () => {
    const body = makeBody();
    body.rotation.y = Math.PI / 2;
    body.updateMatrixWorld(true);
    const f = clipFacts(body, LIE(), 1.0)!;
    expect(Math.abs(f.face_yaw! - 90)).toBeLessThanOrEqual(1);
  });

  it("standing: head_y 0.8, not lying", () => {
    const f = clipFacts(makeBody(), STAND(), 1.0)!;
    expect(Math.abs(f.head_y - 0.8)).toBeLessThanOrEqual(0.005);
    expect(f.lying).toBe(false);
  });

  it("end_lying: the pose of the clip's last frame (k24_true: wake_up lies, then ends sitting)", () => {
    const rise = new AnimationClip("rise", -1, [
      new VectorKeyframeTrack("head.position", [0, 0.5, 1], [0.6, 0, 0, 0.6, 0, 0, 0, 0.7, 0]),
      new QuaternionKeyframeTrack("head.quaternion", [0, 1], [...qa(Y, 0), ...qa(Y, 0)]),
    ]);
    expect(clipFacts(makeBody(), rise, 1.0)!.end_lying).toBe(false);
    expect(clipFacts(makeBody(), LIE(), 1.0)!.end_lying).toBe(true);
  });

  it("no head bone -> null", () => {
    const g = new Group();
    expect(clipFacts(g, LIE(), 1.0)).toBeNull();
  });

  it("contact is where the body rests, not the tip of a thin dangling ear (Koshakan: Mirai slept 7 cm over the bed)", () => {
    // torso: a dense box 0.2 tall on the hips, bottom at 0.1; ear: a thin strip on the head hanging to 0.02
    const body = makeBody();
    const torso = body.children.find((o) => (o as any).isSkinnedMesh) as SkinnedMesh;
    const dense = new BoxGeometry(0.2, 0.2, 0.2, 20, 20, 20);
    dense.translate(0, 0.2, 0);
    const n = dense.attributes.position.count;
    dense.setAttribute("skinIndex", new Uint16BufferAttribute(new Array(n).fill(0).flatMap(() => [1, 0, 0, 0]), 4));
    dense.setAttribute("skinWeight", new Float32BufferAttribute(new Array(n).fill(0).flatMap(() => [1, 0, 0, 0]), 4));
    torso.geometry = dense;
    const earGeo = new BoxGeometry(0.02, 0.1, 0.02);
    earGeo.translate(0.05, 0.07, 0);
    const m = earGeo.attributes.position.count;
    earGeo.setAttribute("skinIndex", new Uint16BufferAttribute(new Array(m).fill(0).flatMap(() => [2, 0, 0, 0]), 4));
    earGeo.setAttribute("skinWeight", new Float32BufferAttribute(new Array(m).fill(0).flatMap(() => [1, 0, 0, 0]), 4));
    const ear = new SkinnedMesh(earGeo, new MeshStandardMaterial());
    body.add(ear);
    body.updateMatrixWorld(true);
    ear.bind(torso.skeleton);
    expect(lowestSkinY(body)).toBeCloseTo(0.02, 3);
    const f = clipFacts(body, headClip("still", [0, 0, 0], qa(Y, 0)), 1.0)!;
    expect(Math.abs(f.contact_y - 0.1)).toBeLessThanOrEqual(0.01);
  });

  it("seat_y: the skin under the pelvis, not the dangling feet (k23_true 46 s: sit_idle stood her feet on the blanket, the seat 14 cm in the air)", () => {
    // seat: a dense box under the hips, bottom at 0.1; shins: a dense box 0.3 in front, bottom at 0 (the support)
    const body = makeBody();
    const torso = body.children.find((o) => (o as any).isSkinnedMesh) as SkinnedMesh;
    const dense = (w: number, h: number, x: number, y: number): BoxGeometry => {
      const g = new BoxGeometry(w, h, w, 10, 10, 10);
      g.translate(x, y, 0);
      const n = g.attributes.position.count;
      g.setAttribute("skinIndex", new Uint16BufferAttribute(new Array(n).fill(0).flatMap(() => [1, 0, 0, 0]), 4));
      g.setAttribute("skinWeight", new Float32BufferAttribute(new Array(n).fill(0).flatMap(() => [1, 0, 0, 0]), 4));
      return g;
    };
    torso.geometry = dense(0.2, 0.2, 0, 0.2);
    const shin = new SkinnedMesh(dense(0.1, 0.2, 0.3, 0.1), new MeshStandardMaterial());
    body.add(shin);
    body.updateMatrixWorld(true);
    shin.bind(torso.skeleton);
    const f = clipFacts(body, headClip("still", [0, 0.2, 0], qa(Y, 0)), 1.0)!;
    expect(Math.abs(f.contact_y - 0)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(f.seat_y! - 0.1)).toBeLessThanOrEqual(0.01);
  });
});

/** 2 m GLB (box 2 tall, hips at 1) whose clip lifts the hips to 1.2: at heightM 1 the skin is 0.1 above the root */
const BIG = () => makeBody({ boxH: 2, hipsY: 1 });
const RAISE = (name = "lie"): AnimationClip => new AnimationClip(name, -1, [new VectorKeyframeTrack("hips.position", [0, 1], [0, 1.2, 0, 0, 1.2, 0])]);
let seq = 0;
async function actorWith(clips: Record<string, AnimationClip>, idle: string, y: number, facts?: Record<string, any>, body = BIG) {
  const k = `mem://${++seq}`;
  store.bodies.set(`${k}/body.glb`, body);
  const urls: Record<string, string> = {};
  for (const [n, c] of Object.entries(clips)) {
    urls[n] = `${k}/${n}.glb`;
    store.clips.set(urls[n], c);
  }
  return createActor("Mira", `${k}/body.glb`, 1.0, [0, 0], y, 0, urls, idle, facts);
}
const holderOf = (g: Group): Object3D => g.children[0]!;

describe("runtime: holder offset by contact_y (Г4)", () => {
  /** facts as the CLI measures them: animator idle frame first, then prepareActorBody (same order as createActor) */
  const cliFacts = (clips: Record<string, AnimationClip>, idle: string, clip: string) => {
    const body = BIG();
    createAnimator(body, clips, { idle, life: false });
    const { holder } = prepareActorBody(body, 1.0);
    expect(holder.scale.x).not.toBeCloseTo(1, 3);
    return clipFacts(holder, clips[clip]!, 1.0)!;
  };
  const STILL = (name = "stand"): AnimationClip => new AnimationClip(name, -1, [new VectorKeyframeTrack("hips.position", [0, 1], [0, 1, 0, 0, 1, 0])]);

  it("measured on the prepared body: contact_y 0.1 with holder.scale != 1, skin lands on the support", async () => {
    const f = cliFacts({ stand: STILL(), lie: RAISE() }, "stand", "lie");
    expect(Math.abs(f.contact_y - 0.1)).toBeLessThanOrEqual(0.005);
    const a = await actorWith({ stand: STILL(), lie: RAISE() }, "stand", 0, { lie: f });
    a.update(1 / 60, 0.1);
    a.play("lie");
    for (let t = 0.2; t < 0.6; t += 0.1) a.update(0.1, t);
    a.group.updateMatrixWorld(true);
    expect(holderOf(a.group).position.y).toBeCloseTo(-0.1, 2);
    expect(Math.abs(lowestSkinY(a.group) - 0)).toBeLessThanOrEqual(0.005);
  });

  it("actor with lying facts in a group at y = 0.45: skin at 0.45", async () => {
    const f = cliFacts({ stand: STILL(), lie: RAISE() }, "stand", "lie");
    const a = await actorWith({ stand: STILL(), lie: RAISE() }, "stand", 0.45, { lie: f });
    a.update(1 / 60, 0.1);
    a.play("lie");
    for (let t = 0.2; t < 0.6; t += 0.1) a.update(0.1, t);
    a.group.updateMatrixWorld(true);
    expect(a.group.position.y).toBeCloseTo(0.45, 3);
    expect(Math.abs(lowestSkinY(a.group) - 0.45)).toBeLessThanOrEqual(0.02);
  });

  it("no facts -> holder at 0", async () => {
    const a = await actorWith({ lie: RAISE() }, "lie", 0);
    a.update(1 / 60, 0.1);
    expect(holderOf(a.group).position.y).toBe(0);
  });

  it("small contact_y (<= 0.02) -> no offset", async () => {
    const a = await actorWith({ lie: RAISE() }, "lie", 0, { lie: { contact_y: 0.015 } });
    a.update(1 / 60, 0.1);
    expect(holderOf(a.group).position.y).toBe(0);
  });

  it("clip change: offset goes linearly old -> new over the 0.15 s fade", async () => {
    const a = await actorWith({ a: RAISE("a"), b: RAISE("b") }, "a", 0, { a: { contact_y: 0.1 }, b: { contact_y: 0.3 } });
    a.update(0, 0);
    expect(holderOf(a.group).position.y).toBeCloseTo(-0.1, 4);
    a.play("b");
    a.update(0, 1);
    expect(Math.abs(holderOf(a.group).position.y - -0.1)).toBeLessThanOrEqual(0.005);
    a.update(0.075, 1.075);
    expect(Math.abs(holderOf(a.group).position.y - -0.2)).toBeLessThanOrEqual(0.005);
    a.update(0.075, 1.15);
    expect(Math.abs(holderOf(a.group).position.y - -0.3)).toBeLessThanOrEqual(0.005);
  });

  // k22_true 44–46 s: wake_up sits Mirai up, then lays her back; one mean contact_y (-0.104, from the sitting part)
  // lifted the lying part 17 cm over the bed. The contact follows the clip in time.
  /** hips at 1.2 for the first half (lowered skin at 0.2), then down to 1.0 (skin at 0) */
  const SINK = (): AnimationClip => new AnimationClip("wake", -1, [new VectorKeyframeTrack("hips.position", [0, 0.5, 0.55, 1], [0, 1.2, 0, 0, 1.2, 0, 0, 1, 0, 0, 1, 0])]);
  it("clipFacts records the contact along the clip, not one mean", () => {
    const f = cliFacts({ stand: STILL(), wake: SINK() }, "stand", "wake");
    expect(f.contact_curve?.length).toBe(16);
    // the body is fitted to 1 m (scale 0.5): the 0.2 m lift reads 0.1
    expect(f.contact_curve![2]! - f.contact_curve![12]!).toBeGreaterThan(0.08);
  });
  it("the holder follows the contact curve at the clip's time", async () => {
    const curve = Array.from({ length: 16 }, (_, k) => (k < 8 ? 0.2 : 0));
    const a = await actorWith({ stand: STILL(), wake: SINK() }, "stand", 0, { wake: { contact_y: 0.1, contact_curve: curve } });
    a.update(1 / 60, 0.1);
    a.play("wake", { once: true });
    for (let t = 0.2; t <= 0.4; t += 0.05) a.update(0.05, t);
    expect(holderOf(a.group).position.y).toBeCloseTo(-0.2, 2);
    for (let t = 0.45; t <= 0.85; t += 0.05) a.update(0.05, t);
    expect(holderOf(a.group).position.y).toBeCloseTo(0, 2);
  });

  it("startStage without clipfacts.json: holder at 0, no clipfacts warning", async () => {
    const warns: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...a: any[]) => { warns.push(a.join(" ")); });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("nope", { status: 404 }));
    const scene = new Scene();
    const bits = new Uint8Array(Math.ceil((250 * 250) / 8)).fill(255);
    const outline: Array<[number, number]> = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const places: any[] = [{ name: "bed", id: "bed", kind: "sit", room: "room", level: null, at: [5, 5], yaw: 0, look: null, obstacle: null, poses: ["stand"] }];
    await startStage({
      scene, camera: new PerspectiveCamera(50, 1, 0.1, 100), stageUrl: "stage/stage.json", sim: null,
      stage: { mode: "book", places: "stage/places.json", cast: "cast/cast.json", start: { Mira: "bed" } },
      places, cast: { Mira: { glb: "missing.glb", height_m: 1.7 } },
      geo: { spawn: { at: [3, 5] }, floors: [{ room: "room", level: null, outline }], meshes: [] },
      layers: [{ layer: { level: null, y: 0, origin: [0, 0], w: 250, h: 250 }, bits }], nav: { ramps: [], doors: {} }, doorOpen: () => false,
    } as any);
    const g = scene.getObjectByName("actor:Mira") as Group;
    expect(holderOf(g).position.y).toBe(0);
    expect(warns.filter((w) => /clipfact/i.test(w))).toEqual([]);
  });

  it("startStage passes facts[who] from clipfacts.json next to cast.json", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    store.bodies.set("http://localhost/cast/body.glb", BIG);
    store.clips.set("http://localhost/cast/lie.glb", RAISE());
    const asked: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (u: any) => {
      asked.push(String(u));
      if (String(u).endsWith("/cast/clipfacts.json")) return new Response(JSON.stringify({ Mira: { lie: { contact_y: 0.1 } } }));
      return new Response("nope", { status: 404 });
    });
    const scene = new Scene();
    const bits = new Uint8Array(Math.ceil((250 * 250) / 8)).fill(255);
    const outline: Array<[number, number]> = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const places: any[] = [{ name: "bed", id: "bed", kind: "sit", room: "room", level: null, at: [5, 5], yaw: 0, look: null, obstacle: null, poses: ["stand"] }];
    await startStage({
      scene, camera: new PerspectiveCamera(50, 1, 0.1, 100), stageUrl: "http://localhost/stage/stage.json", sim: null,
      stage: { mode: "book", places: "stage/places.json", cast: "cast/cast.json", start: { Mira: "bed" } },
      places, cast: { Mira: { glb: "body.glb", height_m: 1.0, clips: { lie: "lie.glb" }, idle: "lie" } },
      geo: { spawn: { at: [3, 5] }, floors: [{ room: "room", level: null, outline }], meshes: [] },
      layers: [{ layer: { level: null, y: 0, origin: [0, 0], w: 250, h: 250 }, bits }], nav: { ramps: [], doors: {} }, doorOpen: () => false,
    } as any);
    expect(asked.filter((u) => u.endsWith("clipfacts.json")).length).toBe(1);
    const g = scene.getObjectByName("actor:Mira") as Group;
    expect(holderOf(g).position.y).toBeCloseTo(-0.1, 3);
  });
});

// ---- writeClipfacts on a temp cast (GLBs built with @gltf-transform/core, no network) ----

// a 1x1 PNG: a body with a texture, like every real cast GLB
const PNG_1PX = Uint8Array.from(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));

function bodyGlb(o: { texture?: boolean } = {}): Promise<Uint8Array> {
  const doc = new Document();
  const buf = doc.createBuffer();
  const root = doc.createNode("root");
  const hips = doc.createNode("hips").setTranslation([0, 0.2, 0]);
  const head = doc.createNode("head");
  root.addChild(hips);
  hips.addChild(head);
  const p: number[] = [];
  for (const x of [-0.1, 0.1]) for (const y of [0.1, 0.3]) for (const z of [-0.1, 0.1]) p.push(x, y, z);
  const tri = [0, 1, 3, 0, 3, 2, 4, 6, 7, 4, 7, 5, 0, 4, 5, 0, 5, 1, 2, 3, 7, 2, 7, 6, 0, 2, 6, 0, 6, 4, 1, 5, 7, 1, 7, 3];
  const j: number[] = [];
  const w: number[] = [];
  for (let i = 0; i < 8; i++) {
    j.push(1, 0, 0, 0);
    w.push(1, 0, 0, 0);
  }
  const acc = (type: any, arr: any) => doc.createAccessor().setType(type).setArray(arr).setBuffer(buf);
  const prim = doc.createPrimitive()
    .setAttribute("POSITION", acc("VEC3", new Float32Array(p)))
    .setAttribute("JOINTS_0", acc("VEC4", new Uint16Array(j)))
    .setAttribute("WEIGHTS_0", acc("VEC4", new Float32Array(w)))
    .setIndices(acc("SCALAR", new Uint16Array(tri)));
  if (o.texture) {
    prim.setAttribute("TEXCOORD_0", acc("VEC2", new Float32Array(16)));
    const tex = doc.createTexture("skin").setImage(PNG_1PX).setMimeType("image/png");
    prim.setMaterial(doc.createMaterial("skin").setBaseColorTexture(tex));
  }
  const mesh = doc.createMesh("skin").addPrimitive(prim);
  const ident = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const down = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -0.2, 0, 1];
  const skin = doc.createSkin().addJoint(root).addJoint(hips).addJoint(head)
    .setInverseBindMatrices(acc("MAT4", new Float32Array([...ident, ...down, ...down])));
  const mn = doc.createNode("mesh").setMesh(mesh).setSkin(skin);
  doc.createScene().addChild(root).addChild(mn);
  return writeGlb(doc);
}

function clipGlb(anims: Array<{ name: string; pos: V3; rot: number[] }>): Promise<Uint8Array> {
  const doc = new Document();
  const buf = doc.createBuffer();
  const root = doc.createNode("root");
  const hips = doc.createNode("hips").setTranslation([0, 0.2, 0]);
  const head = doc.createNode("head");
  root.addChild(hips);
  hips.addChild(head);
  doc.createScene().addChild(root);
  const acc = (type: any, arr: any) => doc.createAccessor().setType(type).setArray(arr).setBuffer(buf);
  for (const a of anims) {
    const t = acc("SCALAR", new Float32Array([0, 1]));
    const sp = doc.createAnimationSampler().setInput(t).setOutput(acc("VEC3", new Float32Array([...a.pos, ...a.pos])));
    const sr = doc.createAnimationSampler().setInput(t).setOutput(acc("VEC4", new Float32Array([...a.rot, ...a.rot])));
    doc.createAnimation(a.name).addSampler(sp).addSampler(sr)
      .addChannel(doc.createAnimationChannel().setTargetNode(head).setTargetPath("translation").setSampler(sp))
      .addChannel(doc.createAnimationChannel().setTargetNode(head).setTargetPath("rotation").setSampler(sr));
  }
  return writeGlb(doc);
}

const writeGlb = (doc: Document): Promise<Uint8Array> => new NodeIO().writeBinary(doc);

describe("writeClipfacts (Г4)", () => {
  it("reads cast.json, picks the animation like loadClips (name, else first), paths from the cast dir", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const dir = mkdtempSync(join(tmpdir(), "clipfacts-"));
    mkdirSync(join(dir, "clips"));
    const lieA = { name: "Take 001", pos: [0.6, 0, 0] as V3, rot: qa(Y, 90) };
    const standA = { name: "stand", pos: [0, 0.7, 0] as V3, rot: qa(Y, 0) };
    writeFileSync(join(dir, "body.glb"), await bodyGlb());
    // key "lie" does not match "Take 001" -> first animation; key "stand" matches the second one by name
    writeFileSync(join(dir, "clips", "lie.glb"), await clipGlb([lieA]));
    writeFileSync(join(dir, "stand.glb"), await clipGlb([{ ...lieA, name: "zzz" }, standA]));
    writeFileSync(join(dir, "cast.json"), JSON.stringify({ Mira: { glb: "body.glb", height_m: 1.0, clips: { lie: "clips/lie.glb", stand: "stand.glb" } } }));
    const warns = await writeClipfacts(dir);
    expect(Array.isArray(warns)).toBe(true);
    const out = JSON.parse(readFileSync(join(dir, "clipfacts.json"), "utf-8"));
    expect(Object.keys(out.Mira).sort()).toEqual(["lie", "stand"]);
    expect(out.Mira.lie.lying).toBe(true);
    expect(out.Mira.stand.lying).toBe(false);
    expect(out.Mira.lie.face_dir).toHaveLength(3);
    expect(Math.abs(out.Mira.lie.face_yaw - 90)).toBeLessThanOrEqual(1);
    // rounded to 0.001
    for (const v of [out.Mira.lie.contact_y, out.Mira.lie.head_y, ...out.Mira.lie.face_dir]) expect(Math.round(v * 1000) / 1000).toBe(v);
  });

  it("a body with a texture (every real cast GLB) is measured under node, not skipped with 'self is not defined'", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const dir = mkdtempSync(join(tmpdir(), "clipfacts-tex-"));
    writeFileSync(join(dir, "body.glb"), await bodyGlb({ texture: true }));
    writeFileSync(join(dir, "lie.glb"), await clipGlb([{ name: "lie", pos: [0.6, 0, 0], rot: qa(Y, 90) }]));
    writeFileSync(join(dir, "cast.json"), JSON.stringify({ Mira: { glb: "body.glb", height_m: 1.0, clips: { lie: "lie.glb" } } }));
    const warns = await writeClipfacts(dir);
    expect(warns).toEqual([]);
    const out = JSON.parse(readFileSync(join(dir, "clipfacts.json"), "utf-8"));
    expect(out.Mira.lie.lying).toBe(true);
  });
});
