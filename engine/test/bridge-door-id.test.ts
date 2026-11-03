import { describe, expect, it } from "vitest";
import { createBridge } from "../src/runtime/bridge.js";

// the sim names a door by its place ("bedroom door"), the engine keys doors by the built id ("door1"):
// a door event with only the place name never swung (Nov 3 debt sweep)
describe("sim door events reach the engine door by id", () => {
  const mk = () => {
    const calls: string[] = [];
    const warns: string[] = [];
    const door1 = { open: () => calls.push("open"), close: () => calls.push("close"), lock: () => calls.push("lock") };
    const b = createBridge({ door: (id) => (id === "door1" ? door1 : null) }, { post: () => undefined, warn: (m) => warns.push(m) });
    return { b, calls, warns };
  };
  it("uses `id` when the object is a place name", () => {
    const { b, calls, warns } = mk();
    b.handle({ type: "door", object: "bedroom door", id: "door1", state: "open" });
    b.handle({ type: "door", object: "bedroom door", id: "door1", state: "locked" });
    expect(calls).toEqual(["open", "lock"]);
    expect(warns).toEqual([]);
  });
  it("an object that is the id itself still works; an unknown one warns with both names", () => {
    const { b, calls, warns } = mk();
    b.handle({ type: "door", object: "door1", state: "closed" });
    b.handle({ type: "door", object: "attic door", id: "door9", state: "open" });
    expect(calls).toEqual(["close"]);
    expect(warns[0]).toContain('"attic door" (id "door9")');
  });
});
