import { describe, it, expect } from "vitest";
import { createBridge } from "../src/runtime/bridge.js";
import { cleanDraft, createOperatorModel, sendIdea } from "../src/runtime/operator.js";

describe("D2 operator panel", () => {
  it("bridge routes idea and director_ack to the stage handlers", () => {
    const got: string[] = [];
    const warns: string[] = [];
    const b = createBridge({ door: () => null }, { post: () => undefined, warn: (m) => warns.push(m) }, {
      idea: (e) => got.push(`idea:${String(e.op)}`),
      director_ack: (e) => got.push(`ack:${String(e.text)}`),
    });
    b.handle({ type: "idea", op: "add", id: "a" });
    b.handle({ type: "director_ack", id: "a", text: "понял" });
    expect(got).toEqual(["idea:add", "ack:понял"]);
    expect(warns).toEqual([]);
  });

  it("model: GET /ideas snapshot, then idea events update rows, acks fill the feed", () => {
    const m = createOperatorModel();
    m.load({ ideas: [{ id: "a", status: "pending", clean: "x", source: "operator" }] });
    m.idea({ type: "idea", op: "add", id: "b", status: "pending", clean: "y", source: "headset" });
    m.idea({ type: "idea", op: "drop", id: "a", status: "dropped", reason: "deleted" });
    m.ack({ type: "director_ack", id: "b", text: "сделаю" });
    expect(m.rows().map((r) => [r.id, r.status])).toEqual([
      ["a", "dropped"],
      ["b", "pending"],
    ]);
    expect(m.rows()[0].reason).toBe("deleted");
    expect(m.feed()).toEqual([{ id: "b", text: "сделаю" }]);
    m.idea({ type: "idea", op: "reject", id: "u", status: "rejected", reason: "unclear" });
    expect(m.rows().find((r) => r.id === "u")).toBeUndefined();
  });

  it("clean: the cleaned text is returned for the prompt line; no idea is posted", async () => {
    const sent: any[] = [];
    const post = async (body: any): Promise<any> => {
      sent.push(body);
      return { draft_revision: body.draft_revision, clean: "поговорите о сестре", intent: "steer", confidence: 0.9 };
    };
    const r = await cleanDraft(post, "headset", () => "э-э поговорите о сестре", () => 1);
    expect(r.ok && r.draft.clean).toBe("поговорите о сестре");
    expect(sent.map((b) => b.kind)).toEqual(["draft"]);
    expect(sent[0]).toMatchObject({ source: "headset", draft_revision: 1 });
  });

  it("send: separate step, carries the widget's source and the cleaned value", async () => {
    const sent: any[] = [];
    const post = async (body: any): Promise<any> => (sent.push(body), { ok: true, id: body.id });
    const r = await sendIdea(post, "headset", "поговорите о сестре", "э-э поговорите о сестре", { clean: "x", intent: "steer", confidence: 0.9 }, 1, () => 1, () => "id1");
    expect(r.ok).toBe(true);
    expect(sent[0]).toMatchObject({ kind: "idea", id: "id1", source: "headset", value: "поговорите о сестре", intent: "steer" });
  });

  it("clean: clean_failed creates no idea", async () => {
    const sent: any[] = [];
    const post = async (body: any): Promise<any> => (sent.push(body), { draft_revision: 1, error: "clean_failed" });
    const r = await cleanDraft(post, "operator", () => "x", () => 1);
    expect(r).toEqual({ ok: false, error: "clean_failed" });
    expect(sent.length).toBe(1);
  });

  it("clean: an answer for an old revision is dropped and the current text is cleaned again by itself", async () => {
    let rev = 1;
    let text = "старый";
    const sent: any[] = [];
    const post = async (body: any): Promise<any> => {
      sent.push(body);
      if (sent.length === 1) {
        rev = 2; // the human typed while the cleaner ran
        text = "новый";
      }
      return { draft_revision: body.draft_revision, clean: body.value, intent: "steer", confidence: 1 };
    };
    const r = await cleanDraft(post, "operator", () => text, () => rev);
    expect(sent.map((b) => [b.draft_revision, b.value])).toEqual([[1, "старый"], [2, "новый"]]);
    expect(r.ok && r.draft.clean).toBe("новый");
  });

  it("send: the line edited during the idea POST withdraws that idea and keeps the new text", async () => {
    let rev = 1;
    const sent: any[] = [];
    const post = async (body: any): Promise<any> => {
      sent.push(body);
      if (body.kind === "idea") rev = 2;
      return { ok: true, id: body.id };
    };
    const r = await sendIdea(post, "operator", "v", "v", { clean: "v", intent: "steer" }, 1, () => rev, () => "id3");
    expect(r.stale).toBe(true);
    expect(sent.map((b) => b.kind)).toEqual(["idea", "idea_drop"]);
    expect(sent[1].id).toBe("id3");
  });

  it("send: trailing «сейчас» in Cyrillic sets now:true (F10)", async () => {
    const sent: any[] = [];
    const post = async (body: any): Promise<any> => (sent.push(body), { ok: true, id: body.id });
    await sendIdea(post, "operator", "внутри магазина, начни строить сейчас", "внутри магазина, начни строить сейчас", { clean: "x", intent: "scene" }, 1, () => 1, () => "id-now");
    expect(sent[0]).toMatchObject({ kind: "idea", now: true });
  });

  it("model: a snapshot arriving after an SSE idea does not erase it; wait clears on null", () => {
    const m = createOperatorModel();
    m.idea({ type: "idea", op: "add", id: "n", status: "pending", clean: "new" });
    m.load({ ideas: [{ id: "old", status: "pending" }] });
    expect(m.rows().map((r) => r.id).sort()).toEqual(["n", "old"]);
    m.idea({ type: "idea", op: "wait", id: "n", status: "pending", wait: "speaking" });
    expect(m.rows().find((r) => r.id === "n")?.wait).toBe("speaking");
    m.idea({ type: "idea", op: "consult", id: "n", status: "consulting", wait: null });
    expect(m.rows().find((r) => r.id === "n")?.wait).toBeUndefined();
  });

  it("send: a line already edited before the POST sends nothing", async () => {
    const sent: any[] = [];
    const post = async (body: any): Promise<any> => (sent.push(body), { ok: true, id: body.id });
    const r = await sendIdea(post, "operator", "v", "v", { clean: "v", intent: "steer" }, 1, () => 2, () => "id9");
    expect(r.stale).toBe(true);
    expect(sent).toEqual([]);
  });
});

describe("D2 debt: revision races in the panel (Nov 3)", () => {
  it("an error about an older text is stale: the current text is cleaned again", async () => {
    let rev = 1;
    let text = "старый";
    const sent: any[] = [];
    const post = async (body: any): Promise<any> => {
      sent.push(body);
      if (sent.length === 1) {
        rev = 2;
        text = "поговорите о сестре сейчас";
        return { error: "clean_failed" };
      }
      return { clean: "поговорите о сестре", intent: "steer", draft_revision: body.draft_revision };
    };
    const r = await cleanDraft(post, "operator", () => text, () => rev);
    expect(r.ok).toBe(true);
    expect(sent.map((b) => b.value)).toEqual(["старый", "поговорите о сестре сейчас"]);
  });
  it("raw is the text of the cleaned revision, so a trailing «сейчас» the cleaner dropped still sets now", async () => {
    let rev = 1;
    let text = "поговорите о сестре";
    const post = async (body: any): Promise<any> => {
      if (body.kind === "draft" && body.draft_revision === 1) {
        rev = 2;
        text = "поговорите о сестре сейчас";
      }
      return body.kind === "draft" ? { clean: "поговорите о сестре", intent: "steer", draft_revision: body.draft_revision } : { ok: true, id: body.id };
    };
    const r = await cleanDraft(post, "operator", () => text, () => rev);
    expect(r.ok && r.raw).toBe("поговорите о сестре сейчас");
    const sent: any[] = [];
    const post2 = async (body: any): Promise<any> => (sent.push(body), { ok: true, id: body.id });
    if (!r.ok) throw new Error("clean failed");
    await sendIdea(post2, "operator", r.draft.clean, r.raw, r.draft, 2, () => 2, () => "id1");
    expect(sent[0].now).toBe(true);
  });
});
