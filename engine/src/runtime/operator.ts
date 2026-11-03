/**
 * D2 (specs/2026-11-02-director-prompt.md): the operator panel, layout A, on the runtime page.
 * `?operator=1` mounts it: the world stays the big mirror, the prompt line sits at the bottom,
 * the idea queue (each row with a delete button) and the director's answers on the right.
 * The player's one-line field (Tab, `source: headset`) goes down the same `POST /event`.
 * Ideas come back by SSE (`idea`, `director_ack` through bridge.ts); `GET /ideas` reloads the queue.
 */
import type { StageEvent } from "./bridge.js";

export type Source = "operator" | "headset";
export interface IdeaRow {
  id: string;
  status: string;
  clean?: string;
  source?: string;
  intent?: string;
  reason?: string;
  wait?: string;
}
export type Post = (body: Record<string, unknown>) => Promise<any>;

/** Queue + answer feed, fed by the GET /ideas snapshot and the SSE events. */
export function createOperatorModel() {
  const byId = new Map<string, IdeaRow>();
  const answers: { id: string; text: string }[] = [];
  const touched = new Set<string>(); // ids an SSE event already updated: a (possibly older) snapshot must not overwrite them
  return {
    load(snap: { ideas?: IdeaRow[] }): void {
      for (const id of [...byId.keys()]) if (!touched.has(id)) byId.delete(id);
      for (const it of snap.ideas ?? []) if (!touched.has(String(it.id))) byId.set(String(it.id), { ...it, id: String(it.id) });
    },
    idea(e: StageEvent): void {
      const id = String(e.id ?? "");
      if (!id || e.op === "reject" || e.op === "clean_failed") return; // a rejected idea never joins the queue
      const row = byId.get(id) ?? { id, status: "pending" };
      touched.add(id);
      if ("wait" in e && e.wait == null) delete row.wait; // the blocker passed
      for (const k of ["status", "clean", "source", "intent", "reason", "wait"] as const) {
        if (e[k] !== undefined && e[k] !== null) (row as any)[k] = String(e[k]);
      }
      byId.set(id, row);
    },
    ack(e: StageEvent): void {
      answers.push({ id: String(e.id ?? ""), text: String(e.text ?? "") });
    },
    rows: (): IdeaRow[] => [...byId.values()],
    feed: () => [...answers],
  };
}

let seq = 0;
const newId = (): string => `${Date.now().toString(36)}-${(seq++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export interface Draft {
  clean: string;
  intent: string;
  confidence?: number;
  addressee?: string;
  scene_id?: string;
}

/**
 * Text in → `kind: draft` (the cleaner). An answer for an older revision is thrown away and the
 * *current* text is cleaned again, automatically; a failed clean creates no idea.
 */
export async function cleanDraft(
  post: Post,
  source: Source,
  getText: () => string,
  getRev: () => number,
): Promise<{ ok: true; draft: Draft; raw: string } | { ok: false; error: string }> {
  for (let i = 0; i < 3; i++) {
    const rev = getRev();
    // the raw text of this very revision: the idea's `raw` and its `now` come from it, never an older one
    const raw = getText();
    let d: any;
    try {
      d = await post({ kind: "draft", source, draft_revision: rev, value: raw });
    } catch {
      if (rev !== getRev()) continue; // edited meanwhile: the failure was about the old text
      return { ok: false, error: "clean_failed" };
    }
    // revision first (D2 debt): an error about an older text is stale, the current text is cleaned again
    if (rev !== getRev() || (d && !d.error && d.draft_revision !== getRev())) continue;
    if (!d || d.error) return { ok: false, error: d?.error ?? "clean_failed" };
    return { ok: true, draft: d as Draft, raw };
  }
  return { ok: false, error: "stale" };
}

/**
 * The separate send step: the human has seen (and maybe edited) the cleaned text in the prompt line.
 * If the line changed while the POST was in flight the idea is withdrawn (`idea_drop`) and `stale`
 * comes back, so the caller keeps the newer text.
 */
export async function sendIdea(
  post: Post,
  source: Source,
  value: string,
  raw: string,
  draft: Draft,
  rev: number,
  getRev: () => number,
  makeId: () => string = newId,
): Promise<{ ok: boolean; id?: string; error?: string; text?: string; stale?: boolean }> {
  if (getRev() !== rev) return { ok: false, error: "stale", stale: true }; // edited before the POST left: nothing is queued
  const id = makeId();
  const body: Record<string, unknown> = { kind: "idea", id, source, value, raw, intent: draft.intent, confidence: draft.confidence };
  if (draft.addressee) body.addressee = draft.addressee;
  if (draft.scene_id) body.scene_id = draft.scene_id;
  // F10: \b is ASCII-only ([A-Za-z0-9_]), so it never matches around Cyrillic
  // «сейчас» — use explicit separator classes instead of \b.
  // D2 debt: the raw text of the cleaned revision and the cleaned value each on its own (a «сейчас» at the end
  // of raw that the cleaner dropped used to sit in the middle of the `raw value` join and was missed)
  const lead = /^\s*(?:сейчас|now)(?:$|[\s.,!?;:\-—])/iu;
  const tail = /(?:^|[\s.,!?;:\-—])(?:сейчас|now)[\s.,!?;:\-—]*$/iu;
  if ([raw, value].some((x) => lead.test(x) || tail.test(x))) body.now = true;
  const r = await post(body).catch(() => ({ ok: false, error: "network" }));
  if (getRev() !== rev) {
    if (r?.ok) await post({ kind: "idea_drop", id }).catch(() => undefined);
    return { ok: false, error: "stale", stale: true };
  }
  return r;
}

export function jsonPost(base: string): Post {
  const url = `${base.replace(/\/$/, "")}/event`;
  return async (body) => {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return r.json();
  };
}

const css = (el: HTMLElement, s: Partial<CSSStyleDeclaration>): HTMLElement => Object.assign(el.style, s) && el;

/** One prompt line (operator: always shown at the bottom; headset: Tab toggles it). */
function promptLine(doc: Document, post: Post, source: Source, onNote: (t: string) => void, style: Partial<CSSStyleDeclaration>) {
  const input = doc.createElement("input");
  input.type = "text";
  input.placeholder = source === "operator" ? "команда режиссёру, Enter — отправить" : "режиссёру (Tab), Enter — отправить";
  input.dataset.source = source;
  css(input, { position: "fixed", zIndex: "20", font: "16px system-ui", padding: "10px 12px", background: "rgba(10,12,16,.85)", color: "#eee", border: "1px solid #556", borderRadius: "6px", ...style });
  let rev = 0;
  let busy = false;
  let cleaned: { text: string; raw: string; draft: Draft } | null = null;
  input.addEventListener("input", () => void rev++);
  input.addEventListener("keydown", (e) => {
    e.stopPropagation(); // typing never drives the camera or the walker
    if (e.key !== "Enter" || busy || !input.value.trim()) return;
    busy = true;
    const done = (): void => void (busy = false);
    if (cleaned && cleaned.text === input.value.trim()) {
      // step 2: the human looked at the cleaned line and sends it
      const c = cleaned;
      const mine = rev;
      void sendIdea(post, source, c.text, c.raw, c.draft, mine, () => rev).then((r) => {
        if (r.ok) {
          input.value = "";
          cleaned = null;
          rev++;
        } else if (r.stale) onNote("текст изменился, идея не поставлена");
        else if (r.text) onNote(String(r.text));
        else onNote(`не принято: ${String((r as any).reason ?? r.error ?? "")}`);
      }).finally(done);
      return;
    }
    // step 1: clean the draft and show the result in the line; nothing goes to the queue yet
    void cleanDraft(post, source, () => input.value, () => rev).then((c) => {
      if (c.ok) {
        input.value = c.draft.clean;
        cleaned = { text: c.draft.clean.trim(), raw: c.raw, draft: c.draft };
        onNote("проверь команду, Enter — отправить");
      } else if (c.error === "clean_failed") onNote("не вышло почистить команду, текст остался");
      else onNote(`не принято: ${c.error}`);
    }).finally(done);
  });
  doc.body.appendChild(input);
  return input;
}

export interface OperatorPanel {
  handlers: { idea(e: StageEvent): void; director_ack(e: StageEvent): void };
  reload(): Promise<void>;
}

/** Layout A on the runtime page. `base` is the sim server (`?sim=`). */
export function mountOperator(doc: Document, base: string, post: Post = jsonPost(base)): OperatorPanel {
  const model = createOperatorModel();
  const side = css(doc.createElement("div"), {
    position: "fixed", top: "0", right: "0", bottom: "0", width: "320px", zIndex: "19", overflow: "auto",
    background: "rgba(10,12,16,.82)", color: "#ddd", font: "13px system-ui", padding: "10px", boxSizing: "border-box",
  });
  side.id = "operator-panel";
  const qTitle = doc.createElement("h3");
  qTitle.textContent = "Очередь идей";
  const list = doc.createElement("div");
  list.id = "operator-queue";
  const aTitle = doc.createElement("h3");
  aTitle.textContent = "Режиссёр";
  const feed = doc.createElement("div");
  feed.id = "operator-feed";
  side.append(qTitle, list, aTitle, feed);
  doc.body.appendChild(side);
  const note = (t: string): void => model.ack({ type: "director_ack", id: "", text: t });
  const render = (): void => {
    list.replaceChildren(
      ...model.rows().map((r) => {
        const row = css(doc.createElement("div"), { display: "flex", gap: "6px", alignItems: "center", margin: "4px 0", opacity: ["done", "dropped", "failed"].includes(r.status) ? "0.55" : "1" });
        const txt = doc.createElement("span");
        txt.style.flex = "1";
        txt.textContent = `[${r.source === "headset" ? "шлем" : "оп"}] ${r.clean ?? r.id} — ${r.status}${r.reason ? ` (${r.reason})` : r.wait ? ` (ждёт: ${r.wait})` : ""}`;
        const del = doc.createElement("button");
        del.textContent = "✕";
        del.title = "удалить идею";
        del.dataset.drop = r.id;
        del.onclick = (): void => void post({ kind: "idea_drop", id: r.id }).catch(() => note("удаление не дошло"));
        row.append(txt, del);
        return row;
      }),
    );
    feed.replaceChildren(
      ...model
        .feed()
        .slice(-30)
        .map((a) => {
          const p = doc.createElement("div");
          p.style.margin = "3px 0";
          p.textContent = `› ${a.text}`;
          return p;
        }),
    );
  };
  const wrapNote = (t: string): void => {
    note(t);
    render();
  };
  promptLine(doc, post, "operator", wrapNote, { left: "12px", right: "332px", bottom: "12px" });
  const reload = async (): Promise<void> => {
    try {
      const r = await fetch(`${base.replace(/\/$/, "")}/ideas`);
      if (r.ok) model.load(await r.json());
    } catch {
      /* no live dream yet: the SSE events fill the queue */
    }
    render();
  };
  void reload();
  return {
    handlers: {
      idea: (e) => {
        model.idea(e);
        render();
      },
      director_ack: (e) => {
        model.ack(e);
        render();
      },
    },
    reload,
  };
}

/** The player's one-line field: Tab shows/hides it, `source: headset`. */
export function mountHeadsetField(doc: Document, base: string, post: Post = jsonPost(base)): HTMLInputElement {
  const say = (t: string): void => console.info(`director: ${t}`);
  const input = promptLine(doc, post, "headset", say, { left: "50%", transform: "translateX(-50%)", width: "40%", top: "12px", display: "none" });
  doc.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    e.preventDefault();
    const show = input.style.display === "none";
    input.style.display = show ? "block" : "none";
    if (show) input.focus();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      input.style.display = "none";
      input.blur();
    }
  });
  return input;
}
