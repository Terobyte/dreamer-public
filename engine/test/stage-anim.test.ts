import { describe, it, expect, vi, afterEach } from "vitest";
import { AnimationClip, Bone, Group, InterpolateDiscrete, Quaternion, QuaternionKeyframeTrack, Vector3, VectorKeyframeTrack } from "three";
import { createAnimator } from "../src/runtime/stage/anim.js";

const Z = new Vector3(0, 0, 1);
const qs = (degs: number[]): number[] =>
  degs.flatMap((d) => new Quaternion().setFromAxisAngle(Z, (d * Math.PI) / 180).toArray());
const qtrack = (bone: string, times: number[], degs: number[]) => new QuaternionKeyframeTrack(`${bone}.quaternion`, times, qs(degs));
const angleOf = (q: Quaternion): number => (2 * Math.acos(Math.min(1, Math.abs(q.w))) * 180) / Math.PI;

function body(extra: string[] = []): { root: Group; bone: (n: string) => Bone } {
  const root = new Group();
  const pelvis = new Bone();
  pelvis.name = "pelvis";
  for (const n of ["upperarm_l", "upperarm_r", ...extra]) {
    const b = new Bone();
    b.name = n;
    pelvis.add(b);
  }
  root.add(pelvis);
  return { root, bone: (n) => root.getObjectByName(n) as Bone };
}
const arms = (times: number[], degs: number[]) => [qtrack("upperarm_l", times, degs), qtrack("upperarm_r", times, degs)];
const spyWarn = () => vi.spyOn(console, "warn").mockImplementation(() => {});

afterEach(() => vi.restoreAllMocks());

describe("animator: retarget by bone name", () => {
  it("drops tracks whose bone is missing (one log per clip) and skips clips with no tracks", () => {
    const warn = spyWarn();
    const { root } = body();
    const a = createAnimator(root, {
      ok: new AnimationClip("ok", -1, [...arms([0, 1], [40, 60]), qtrack("tail", [0, 1], [0, 10]), qtrack("ear", [0, 1], [0, 10])]),
      ghost: new AnimationClip("ghost", -1, [qtrack("nobody", [0, 1], [0, 10])]),
    }, {});
    expect(a.has("ok")).toBe(true);
    expect(a.has("ghost")).toBe(false);
    expect(a.trackNames("ok").sort()).toEqual(["upperarm_l.quaternion", "upperarm_r.quaternion"]);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("ok")).length).toBe(1);
  });
});

describe("animator: walk in place", () => {
  it("freezes root X/Z on frame one, keeps Y", () => {
    spyWarn();
    const { root, bone } = body();
    const clip = new AnimationClip("walk", -1, [new VectorKeyframeTrack("pelvis.position", [0, 1, 2], [1, 1, 1, 2, 2, 3, 3, 1.5, 5])]);
    const a = createAnimator(root, { walk: clip }, { idle: "walk" });
    a.update(1);
    const p = bone("pelvis").position;
    expect(p.x).toBeCloseTo(1);
    expect(p.z).toBeCloseTo(1);
    expect(p.y).toBeCloseTo(2);
  });
});

describe("animator: playback", () => {
  const mk = () => {
    spyWarn();
    const { root, bone } = body();
    const clips = {
      idle: new AnimationClip("idle", 1, arms([0, 1], [40, 40])),
      walk: new AnimationClip("walk", 1, arms([0, 1], [40, 80])),
      flick: new AnimationClip("flick", 1, arms([0, 1], [40, 90])),
    };
    return { a: createAnimator(root, clips, { idle: "idle" }), bone };
  };

  it("crossfades 0.15 s: weights are 0.5/0.5 half-way", () => {
    const { a } = mk();
    a.play("walk");
    a.update(0.075);
    expect(a.weight("walk")).toBeCloseTo(0.5, 1);
    expect(a.weight("idle")).toBeCloseTo(0.5, 1);
    a.update(0.2);
    expect(a.weight("walk")).toBeCloseTo(1, 2);
    expect(a.weight("idle")).toBeCloseTo(0, 2);
  });

  it("once plays once and fades back to idle", () => {
    const { a } = mk();
    a.play("flick", { once: true });
    expect(a.current()).toBe("flick");
    a.update(0.5);
    expect(a.current()).toBe("flick");
    a.update(0.6);
    expect(a.current()).toBe("idle");
    a.update(0.3);
    expect(a.weight("idle")).toBeCloseTo(1, 2);
    expect(a.weight("flick")).toBeCloseTo(0, 2);
  });

  it("repeat play of the same clip does not restart it", () => {
    const { a } = mk();
    a.play("walk");
    a.update(0.5);
    const t = a.time("walk");
    a.play("walk");
    expect(a.time("walk")).toBeCloseTo(t, 6);
    a.update(0.1);
    expect(a.time("walk")).toBeCloseTo(t + 0.1, 6);
  });

  it("repeat play of the idle loop does not restart it", () => {
    const { a } = mk();
    a.update(0.5);
    const t = a.time("idle");
    a.play("idle");
    expect(a.time("idle")).toBeCloseTo(t, 6);
  });

  it("unknown clip -> idle and one warning per name", () => {
    const warn = spyWarn();
    const { root } = body();
    const a = createAnimator(root, { idle: new AnimationClip("idle", 1, arms([0, 1], [40, 40])) }, { idle: "idle" });
    warn.mockClear();
    a.play("nope");
    a.play("nope");
    a.update(0.1);
    expect(a.current()).toBe("idle");
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("nope")).length).toBe(1);
  });
});

describe("animator: idle pose", () => {
  it('"wake@0.5" holds a still pose', () => {
    spyWarn();
    const { root, bone } = body();
    const times = [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
    const wake = new AnimationClip("wake", -1, arms(times, times.map((t) => t * 45)));
    const a = createAnimator(root, { wake }, { idle: "wake@0.5" });
    a.update(0.3);
    const q1 = bone("upperarm_l").quaternion.clone();
    a.update(0.7);
    const q2 = bone("upperarm_l").quaternion.clone();
    expect(q1.angleTo(q2)).toBeLessThan(1e-4);
    expect(angleOf(q1)).toBeGreaterThan(30);
  });

  it("no idle -> frame 0 of the first clip, never bind", () => {
    spyWarn();
    const { root, bone } = body();
    const a = createAnimator(root, { a: new AnimationClip("a", 1, [qtrack("upperarm_l", [0, 1], [40, 80])]) }, {});
    a.update(0.5);
    expect(angleOf(bone("upperarm_l").quaternion)).toBeCloseTo(40, 0);
  });
});

describe("animator: calibration head", () => {
  const times = [0, 0.5, 1, 1.05, 2];
  const degs = [5, 5, 5, 60, 90];
  it("cuts the T-pose head; frame 0 and the loop seam are not T", () => {
    spyWarn();
    const { root, bone } = body();
    const wake = new AnimationClip("wake", -1, arms(times, degs));
    const a = createAnimator(root, { wake }, { idle: "wake" });
    expect(a.duration("wake")).toBeLessThan(2 - 0.9);
    const both = () => [angleOf(bone("upperarm_l").quaternion), angleOf(bone("upperarm_r").quaternion)];
    expect(both().every((d) => d >= 30)).toBe(true);
    a.update(a.duration("wake") + 0.02);
    expect(both().every((d) => d >= 30)).toBe(true);
  });

  it("no upperarm tracks -> no cut, one warning", () => {
    const warn = spyWarn();
    const { root } = body();
    const clip = new AnimationClip("w", -1, [new VectorKeyframeTrack("pelvis.position", [0, 1, 2], [0, 0, 0, 1, 0, 0, 2, 0, 0])]);
    const a = createAnimator(root, { w: clip }, {});
    expect(a.duration("w")).toBeCloseTo(2, 5);
    expect(warn.mock.calls.length).toBe(1);
  });
});

describe("animator: calibration head on sparse keys (F1)", () => {
  it("cuts at the interpolated 30° moment, not at the next key", () => {
    spyWarn();
    const { root, bone } = body();
    const wake = new AnimationClip("wake", -1, arms([0, 2], [0, 90]));
    const a = createAnimator(root, { wake }, { idle: "wake" });
    // both arms go 0° -> 90° linearly: 30° is reached at t ≈ 0.67, duration ≈ 1.33
    expect(a.duration("wake")).toBeCloseTo(2 - 2 / 3, 1);
    const both = () => [angleOf(bone("upperarm_l").quaternion), angleOf(bone("upperarm_r").quaternion)];
    expect(both().every((d) => d >= 29)).toBe(true);
  });
});

describe("animator: interpolation survives cut+freeze (F2)", () => {
  it("keeps STEP interpolation and a custom interpolant factory", () => {
    spyWarn();
    const { root } = body(["hand"]);
    const l = qtrack("upperarm_l", [0, 1, 2], [5, 60, 90]);
    const r = qtrack("upperarm_r", [0, 1, 2], [5, 60, 90]);
    const pos = new VectorKeyframeTrack("hand.position", [0, 1, 2], [0, 0, 0, 10, 1, 0, 20, 2, 0]);
    pos.setInterpolation(InterpolateDiscrete);
    const factory = pos.createInterpolant;
    (pos as any).createInterpolant = factory;
    const rootPos = new VectorKeyframeTrack("pelvis.position", [0, 1, 2], [1, 0, 1, 5, 1, 5, 9, 2, 9]);
    rootPos.setInterpolation(InterpolateDiscrete);
    const a = createAnimator(root, { c: new AnimationClip("c", -1, [l, r, pos, rootPos]) }, { idle: "c" });
    const tr = new Map(a.tracks("c").map((t) => [t.name, t]));
    expect(tr.get("hand.position")!.getInterpolation()).toBe(InterpolateDiscrete);
    expect(tr.get("pelvis.position")!.getInterpolation()).toBe(InterpolateDiscrete);
    expect((tr.get("hand.position")! as any).createInterpolant).toBe(factory);
  });
});

describe("animator: CUBICSPLINE survives cut+freeze (F2)", () => {
  it("keeps the cubic factory, value layout and freezes XZ vertices", () => {
    spyWarn();
    const { root } = body();
    const l = qtrack("upperarm_l", [0, 1, 2], [5, 60, 90]);
    const r = qtrack("upperarm_r", [0, 1, 2], [5, 60, 90]);
    const times = [0, 1, 2];
    const verts = [[1, 0, 1], [5, 1, 5], [9, 2, 9]];
    const values = verts.flatMap((v) => [0, 0, 0, ...v, 0, 0, 0]);
    const rootPos = new VectorKeyframeTrack("pelvis.position", times, values);
    (rootPos as any).createInterpolant = function (this: VectorKeyframeTrack, _result?: Float32Array) {
      const vs = 9, st = 3;
      return { evaluate: (t: number) => {
        const tt = Array.from(this.times as unknown as number[]);
        const vv = Array.from(this.values as unknown as number[]);
        let k = 0;
        while (k < tt.length - 2 && t > tt[k + 1]) k++;
        const t0 = tt[k], t1 = tt[k + 1];
        const a = vv.slice(k * vs + st, k * vs + st + 3);
        const b = vv.slice((k + 1) * vs + st, (k + 1) * vs + st + 3);
        const f = t1 > t0 ? Math.min(1, Math.max(0, (t - t0) / (t1 - t0))) : 0;
        return new Float32Array(a.map((x, i) => x + (b[i] - x) * f));
      } };
    };
    (rootPos as any).createInterpolant.isInterpolantFactoryMethodGLTFCubicSpline = true;
    const a = createAnimator(root, { c: new AnimationClip("c", -1, [l, r, rootPos]) }, { idle: "c" });
    const tr = new Map(a.tracks("c").map((t) => [t.name, t]));
    const rp = tr.get("pelvis.position")!;
    expect((rp as any).createInterpolant.isInterpolantFactoryMethodGLTFCubicSpline).toBe(true);
    expect(rp.values.length).toBe(rp.times.length * rp.getValueSize());
    expect(rp.getValueSize()).toBe(9);
    const vs = rp.getValueSize(), st = vs / 3;
    const v = Array.from(rp.values as unknown as number[]);
    // frozen to the first frame AFTER the cut (head vertex), Y kept per key
    const hx = v[st], hz = v[st + 2];
    for (let k = 0; k < rp.times.length; k++) {
      expect(v[k * vs + st]).toBeCloseTo(hx, 5);
      expect(v[k * vs + st + 2]).toBeCloseTo(hz, 5);
    }
    expect(v[st + 1]).toBeGreaterThanOrEqual(0);
    expect(v[(rp.times.length - 1) * vs + st + 1]).toBeCloseTo(2, 5);
  });
});

describe("animator: cubic cut keeps the curve (F3)", () => {
  // hermite mock with the GLTF layout ([inTangent, vertex, outTangent]) and td-scaled tangents
  const hermite = function (this: VectorKeyframeTrack, _result?: Float32Array) {
    const vs = 9, st = 3;
    const at = (t: number): Float32Array => {
      const tt = Array.from(this.times as unknown as number[]);
      const vv = Array.from(this.values as unknown as number[]);
      let k = 0;
      while (k < tt.length - 2 && t > tt[k + 1]) k++;
      const t0 = tt[k], t1 = tt[k + 1], td = t1 - t0 || 1;
      const p = Math.min(1, Math.max(0, (t - t0) / td));
      const pp = p * p, ppp = pp * p;
      const s2 = -2 * ppp + 3 * pp, s3 = ppp - pp, s0 = 1 - s2, s1 = s3 - pp + p;
      const o0 = k * vs, o1 = (k + 1) * vs;
      const out = new Float32Array(st);
      for (let i = 0; i < st; i++) {
        const p0 = vv[o0 + st + i], m0 = vv[o0 + 2 * st + i] * td;
        const p1 = vv[o1 + st + i], m1 = vv[o1 + i] * td;
        out[i] = s0 * p0 + s1 * m0 + s2 * p1 + s3 * m1;
      }
      return out;
    };
    return { evaluate: at };
  };
  (hermite as any).isInterpolantFactoryMethodGLTFCubicSpline = true;

  it("values after the cut match the original curve, Y included; X/Z frozen", () => {
    spyWarn();
    const { root } = body();
    const l = qtrack("upperarm_l", [0, 2], [0, 90]);
    const r = qtrack("upperarm_r", [0, 2], [0, 90]);
    const times = [0, 1, 2];
    const verts = [[1, 0, 3], [5, 8, 3], [9, 2, 3]];
    const outTan = [[0, 12, 0], [0, 0, 0], [0, 0, 0]];
    const inTan = [[0, 0, 0], [0, 12, 0], [0, 0, 0]];
    const origValues = times.flatMap((_, k) => [...inTan[k], ...verts[k], ...outTan[k]]);
    const orig = new VectorKeyframeTrack("pelvis.position", times, origValues);
    (orig as any).createInterpolant = hermite;
    const a = createAnimator(root, { c: new AnimationClip("c", -1, [l, r, orig]) }, { idle: "c" });
    const reg = a.tracks("c").find((t) => t.name === "pelvis.position")!;
    const t0 = 2 - a.duration("c");
    expect(t0).toBeGreaterThan(0.2);
    const itp = (reg as any).createInterpolant();
    const expectedY = (t: number): number => {
      const vv = origValues, vs = 9;
      let k = 0;
      while (k < times.length - 2 && t > times[k + 1]) k++;
      const tA = times[k], tB = times[k + 1], td = tB - tA;
      const p = (t - tA) / td, pp = p * p, ppp = pp * p;
      const s2 = -2 * ppp + 3 * pp, s3 = ppp - pp, s0 = 1 - s2, s1 = s3 - pp + p;
      const i = 1;
      return s0 * vv[k * vs + 3 + i] + s1 * vv[k * vs + 6 + i] * td + s2 * vv[(k + 1) * vs + 3 + i] + s3 * vv[(k + 1) * vs + i] * td;
    };
    for (const s of [0.05, 0.15, 0.3, 0.5]) {
      const got = Array.from(itp.evaluate(s) as ArrayLike<number>);
      expect(got[1]).toBeCloseTo(expectedY(s + t0), 2);
    }
    const v = Array.from(reg.values as unknown as number[]);
    for (let k = 0; k < reg.times.length; k++) {
      expect(v[k * 9 + 3]).toBeCloseTo(v[3], 5);
      expect(v[k * 9 + 5]).toBeCloseTo(v[5], 5);
    }
  });
});

describe("animator: cubic registration is quiet (F4)", () => {
  it("no unsupported-interpolation warning and the factory survives", () => {
    const warn = spyWarn();
    const { root } = body();
    const l = qtrack("upperarm_l", [0, 1, 2], [5, 60, 90]);
    const r = qtrack("upperarm_r", [0, 1, 2], [5, 60, 90]);
    const rootPos = new VectorKeyframeTrack("pelvis.position", [0, 1, 2], [0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 5, 1, 5, 0, 0, 0, 0, 0, 0, 9, 2, 9, 0, 0, 0]);
    (rootPos as any).createInterpolant = function (this: VectorKeyframeTrack, _result?: Float32Array) {
      const vs = 9, st = 3;
      return { evaluate: (t: number) => {
        const tt = Array.from(this.times as unknown as number[]);
        const vv = Array.from(this.values as unknown as number[]);
        let k = 0;
        while (k < tt.length - 2 && t > tt[k + 1]) k++;
        const t0 = tt[k], t1 = tt[k + 1];
        const a = vv.slice(k * vs + st, k * vs + st + 3);
        const b = vv.slice((k + 1) * vs + st, (k + 1) * vs + st + 3);
        const f = t1 > t0 ? Math.min(1, Math.max(0, (t - t0) / (t1 - t0))) : 0;
        return new Float32Array(a.map((x, i) => x + (b[i] - x) * f));
      } };
    };
    (rootPos as any).createInterpolant.isInterpolantFactoryMethodGLTFCubicSpline = true;
    const a = createAnimator(root, { c: new AnimationClip("c", -1, [l, r, rootPos]) }, { idle: "c" });
    expect(warn.mock.calls.map((c) => c.map(String).join(" ")).filter((m) => m.includes("unsupported interpolation"))).toEqual([]);
    const rp = a.tracks("c").find((t) => t.name === "pelvis.position")!;
    expect((rp as any).createInterpolant.isInterpolantFactoryMethodGLTFCubicSpline).toBe(true);
  });
});

describe("animator: budget", () => {
  it("2 characters x 66 tracks, 1000 updates < 2000 ms", () => {
    spyWarn();
    const names = Array.from({ length: 66 }, (_, i) => `b${i}`);
    const mk = () => {
      const { root } = body(names);
      const clip = new AnimationClip("c", -1, names.map((n) => qtrack(n, [0, 0.5, 1], [0, 30, 0])));
      return createAnimator(root, { c: clip }, { idle: "c" });
    };
    const list = [mk(), mk()];
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) for (const a of list) a.update(1 / 30);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});
