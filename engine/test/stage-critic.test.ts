import { describe, it, expect } from "vitest";
import { Bone, Group } from "three";
import { computeFact, boneSig, createCritic, headPose } from "../src/runtime/stage/critic.js";

const base = (yawB: number) => ({
  t: 1.5,
  plan: "two",
  cam: [0, 1.5, 4] as [number, number, number],
  look: [0, 1.0, 0] as [number, number, number],
  speaker: "ann",
  fov: 50,
  aspect: 16 / 9,
  actors: [
    // ann stands at the origin facing the camera (+z); bob stands to the side, yawB
    { who: "ann", pos: [0, 0] as [number, number], y: 0, yaw: 0, height: 1.7, clear: true, boneSig: 1.23 },
    { who: "bob", pos: [0.5, 0] as [number, number], y: 0, yaw: yawB, height: 1.7, clear: false, boneSig: 0 },
  ],
});

describe("critic: per-frame fact", () => {
  it("face_deg ~0 for a face to the camera, ~180 for a back", () => {
    const f = computeFact(base(180));
    const ann = f.actors.find((a) => a.who === "ann")!;
    const bob = f.actors.find((a) => a.who === "bob")!;
    expect(ann.face_deg).toBeLessThan(10);
    expect(bob.face_deg).toBeGreaterThan(170);
    expect(ann.clear).toBe(true);
    expect(bob.clear).toBe(false);
    expect(ann.bone_sig).toBe(1.23);
  });
  it("head_ndc in frame and height_frac by projection of feet and crown", () => {
    const f = computeFact(base(0));
    const ann = f.actors[0];
    expect(Math.abs(ann.head_ndc[0])).toBeLessThan(1);
    expect(Math.abs(ann.head_ndc[1])).toBeLessThan(1);
    // 1.7 m at 4 m, vfov 50: 1.7 / (2*4*tan(25deg)) ~ 0.456
    expect(ann.height_frac).toBeGreaterThan(0.4);
    expect(ann.height_frac).toBeLessThan(0.52);
    expect(f).toMatchObject({ t: 1.5, plan: "two", speaker: "ann" });
  });
  it("boneSig sums bone angles rounded to 0.01; createCritic fills window.__critic every 0.5 s", () => {    const g = new Group();
    const b = new Bone();
    b.rotation.set(0.1234, 0, 0.2);
    g.add(b);
    expect(boneSig(g)).toBe(0.32);
    const sink: any[] = [];
    const c = createCritic(sink, () => base(0));
    c.tick(0.2, 0.2);
    expect(sink.length).toBe(0);
    c.tick(0.4, 0.6);
    expect(sink.length).toBe(1);
    c.tick(0.5, 1.1);
    expect(sink.length).toBe(2);
  });
  it("faceYaw overrides body yaw for face_deg (head turned to camera)", () => {
    const i: any = base(180);
    i.actors[1] = { ...i.actors[1], faceYaw: 0 };
    const f = computeFact(i);
    expect(f.actors[1].face_deg).toBeLessThan(10);
  });
  it("overlap is true when bodies are close even with heads apart in NDC", () => {
    const i: any = { ...base(0), actors: [
      { who: "ann", pos: [0, 0], y: 0, yaw: 0, height: 1.7, clear: true, boneSig: 1 },
      { who: "bob", pos: [0.2, 0], y: 0, yaw: 0, height: 1.7, clear: true, boneSig: 1 },
    ] };
    const f: any = computeFact(i);
    expect(Math.abs(f.actors[0].head_ndc[0] - f.actors[1].head_ndc[0])).toBeGreaterThan(0.02);
    expect(f.overlap).toBe(true);
  });
  it("an actor behind the camera is out of frame (no mirrored projection)", () => {
    const i: any = { ...base(0), actors: [{ who: "ann", pos: [0, 8], y: 0, yaw: 180, height: 1.7, clear: true, boneSig: 1 }] };
    const f: any = computeFact(i);
    expect(Math.abs(f.actors[0].head_ndc[0]) > 1 || Math.abs(f.actors[0].head_ndc[1]) > 1).toBe(true);
  });
  it("headY (rendered feet, sit drop) moves head_ndc down", () => {
    const hi: any = computeFact(base(0));
    const lo: any = computeFact({ ...base(0), actors: [{ who: "ann", pos: [0, 0], y: -0.45, yaw: 0, height: 1.7, clear: true, boneSig: 1 }] } as any);
    expect(lo.actors[0].head_ndc[1]).toBeLessThan(hi.actors[0].head_ndc[1] - 0.05);
  });
  it("headY (rendered head, e.g. eye level in sit) overrides the artificial point", () => {
    const hi: any = computeFact(base(0));
    const withHead: any = computeFact({ ...base(0), actors: [{ who: "ann", pos: [0, 0], y: 0, yaw: 0, headY: 1.1, height: 1.7, clear: true, boneSig: 1 }] } as any);
    // artificial point would be y + 0.93*1.7 = 1.58; rendered head at 1.1 projects lower
    expect(withHead.actors[0].head_ndc[1]).toBeLessThan(hi.actors[0].head_ndc[1] - 0.05);
  });
  it("overlap ignores bodies on different floors", () => {
    const i: any = { ...base(0), actors: [
      { who: "ann", pos: [0, 0], y: 0, yaw: 0, height: 1.7, clear: true, boneSig: 1 },
      { who: "bob", pos: [0.2, 0], y: 3, yaw: 0, height: 1.7, clear: true, boneSig: 1 },
    ] };
    expect(computeFact(i).overlap).toBe(false);
  });
  it("headPose measures the head bone's world aim, not the body's yaw (F10)", () => {
    const g = new Group();
    g.rotation.y = Math.PI; // body faces away from the camera
    const head = new Bone();
    head.name = "head";
    head.position.set(0, 1.6, 0);
    head.rotation.y = Math.PI; // ...but the head turned back to the camera, no gaze target involved
    g.add(head);
    g.position.set(1, -0.45, 2); // SIT_DROP-like offset rides along
    g.updateMatrixWorld(true);
    const p = headPose(g)!;
    expect(p).not.toBeNull();
    expect(p.pos[0]).toBeCloseTo(1, 5);
    expect(p.pos[1]).toBeCloseTo(1.15, 5);
    expect(p.pos[2]).toBeCloseTo(2, 5);
    expect(p.faceYaw).toBeLessThan(5);
    expect(headPose(new Group())).toBeNull(); // a box stand-in has no bones
  });
  it("computeFact prefers the measured headPos over the artificial point (F11)", () => {
    const hi: any = computeFact(base(0));
    const measured: any = computeFact({ ...base(0), actors: [
      { who: "ann", pos: [0, 0], y: 0, yaw: 0, headPos: [0, 1.1, 0] as [number, number, number], height: 1.7, clear: true, boneSig: 1 },
      { who: "bob", pos: [5, 0], y: 0, yaw: 0, height: 1.7, clear: true, boneSig: 1 },
    ] } as any);
    expect(measured.actors[0].head_ndc[1]).toBeLessThan(hi.actors[0].head_ndc[1] - 0.05);
  });
  it("headPose prefers the head bone over the neck (F14)", () => {
    const g = new Group();
    const neck = new Bone();
    neck.name = "neck";
    neck.position.set(0, 1.5, 0);
    neck.rotation.y = Math.PI; // the neck aims away from the camera
    const head = new Bone();
    head.name = "head";
    head.position.set(0, 0.15, 0);
    head.rotation.y = Math.PI; // ...but the head turned back to it (world yaw 0)
    neck.add(head);
    g.add(neck);
    g.updateMatrixWorld(true);
    const p = headPose(g)!;
    expect(p).not.toBeNull();
    expect(p.pos[1]).toBeCloseTo(1.65, 5);
    expect(p.faceYaw).toBeLessThan(5);
  });
  it("face_deg is the full 3D angle to the camera, not yaw-only (F15)", () => {
    const i: any = {
      t: 0, plan: "two", cam: [0, 10, -1], look: [0, 1, 0], speaker: "ann", fov: 50, aspect: 16 / 9,
      actors: [{ who: "ann", pos: [0, 0], y: 0, yaw: 0, height: 1.7, clear: true, boneSig: 1 }],
    };
    const f: any = computeFact(i);
    // face along +Z, camera high behind: the spatial angle is ~97, not 180
    expect(f.actors[0].face_deg).toBeGreaterThan(90);
    expect(f.actors[0].face_deg).toBeLessThan(100);
  });
  it("overlap uses body intervals, not feet distance (F9)", () => {
    const stairs: any = { ...base(0), actors: [
      { who: "ann", pos: [0, 0], y: 0, yaw: 0, height: 1.7, clear: true, boneSig: 1 },
      { who: "bob", pos: [0.2, 0], y: 1.0, yaw: 0, height: 1.7, clear: true, boneSig: 1 },
    ] };
    // bodies [0,1.7] and [1.0,2.7] intersect even with feet 1 m apart
    expect(computeFact(stairs).overlap).toBe(true);
  });
  it("K2: computeFact carries move and dcut into the fact", () => {
    const f: any = computeFact({ ...base(0), move: "push_in", dcut: 3 } as any);
    expect(f.move).toBe("push_in");
    expect(f.dcut).toBe(3);
  });
});
