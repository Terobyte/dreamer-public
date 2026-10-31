import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { controls } from "../src/runtime/walk.js";

// controls() listens on the global addEventListener (and window, same registry here)
// and on a DOM element; stub them so the keyboard path runs under node.
type Handler = (e: { code?: string }) => void;
const handlers = new Map<string, Handler[]>();
const fire = (type: string, e: { code?: string } = {}) => {
  for (const h of handlers.get(type) ?? []) h(e);
};
const fakeAdd = (type: string, h: Handler) => {
  handlers.set(type, [...(handlers.get(type) ?? []), h]);
};

const fakeDom = {
  addEventListener: () => {},
  requestPointerLock: () => {},
} as unknown as HTMLElement;

const g = globalThis as unknown as Record<string, unknown>;

beforeEach(() => {
  handlers.clear();
  g.addEventListener = fakeAdd;
  g.window = globalThis;
  g.document = { pointerLockElement: null };
});

afterEach(() => {
  delete g.addEventListener;
  delete g.window;
  delete g.document;
});

describe("walk controls (bugs B16, B38)", () => {
  it("B16 KeyD alone at yaw 0 strafes right, which is -X (three.js, yaw 0 faces +Z)", () => {
    const keys = controls(fakeDom, 0);
    fire("keydown", { code: "KeyD" });
    const [dx, dz] = keys.dir(0, 1);
    // camera-right at yaw 0 is (-cos 0, sin 0) = (-1, 0); speed 1.4 * dt 1
    expect(dx).toBeCloseTo(-1.4, 5);
    expect(dz).toBeCloseTo(0, 5);
  });

  it("B38 keys are released on window blur, so dir() returns [0, 0] after blur", () => {
    const keys = controls(fakeDom, 0);
    fire("keydown", { code: "KeyW" });
    expect(keys.dir(0, 1)[1]).toBeGreaterThan(0); // walking forward before blur
    fire("blur");
    expect(keys.dir(0, 1)).toEqual([0, 0]);
  });
});
