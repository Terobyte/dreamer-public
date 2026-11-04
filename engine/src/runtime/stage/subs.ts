/** Subtitles and voice for the stage: `line` / `narrator` events -> text + `Audio` of `r.audio`. */
export interface Subs {
  line(r: { who?: unknown; text?: unknown; audio?: unknown }): void;
  narrator(r: { text?: unknown; audio?: unknown }): void;
  /** the strings shown so far, newest last: what the browser test reads */
  log(): string[];
}

/** `r.audio` is relative to the run folder; the sim server serves it as /out/<profile>/<run>/<file> (F26). */
export function audioUrl(sim: string, live: string | null, audio: string): string | null {
  if (!live) return null;
  const enc = (s: string): string => s.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return `${sim.replace(/\/$/, "")}/out/${enc(live)}/${enc(audio)}`;
}

/** What the viewer reads: the voice's delivery marks are for TTS only ("[soft whisper]", "<emphasis>x</emphasis>",
 *  "[[TOUCH:bed]]"), so they leave the text; the words inside a tag stay. */
export function cleanSubtitle(text: string): string {
  return text
    .replace(/\[\[[^\]]*\]\]/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/<\/?[a-zA-Z][^>]*>/g, "")
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export function createSubs(sim: string | null, doc: Document | null = typeof document !== "undefined" ? document : null): Subs {
  // which run the sim plays: /api/status -> {"live": "<profile>/<run>"}; asked once, again if it was not live yet
  let live: string | null = null;
  const status = async (): Promise<string | null> => {
    if (live || !sim) return live;
    try {
      const j = await fetch(`${sim.replace(/\/$/, "")}/api/status`).then((r) => r.json());
      live = typeof j?.live === "string" && j.live ? j.live : null;
    } catch {
      live = null;
    }
    return live;
  };
  const box = doc?.createElement("div");
  if (box && doc) {
    box.id = "subs";
    box.style.cssText =
      "position:fixed;left:50%;bottom:36px;transform:translateX(-50%);width:min(820px,92vw);color:#fff;font:18px system-ui,sans-serif;text-align:center;text-shadow:0 1px 4px #000;z-index:2";
    doc.body.appendChild(box);
  }
  const seen: string[] = [];
  const show = (cls: string, text: string, audio: unknown): void => {
    if (box && doc) {
      const d = doc.createElement("div");
      d.className = cls;
      d.textContent = cleanSubtitle(text);
      if (cls === "narrator") d.style.fontStyle = "italic";
      box.replaceChildren(d);
    }
    seen.push(text);
    if (typeof audio === "string" && audio && sim) {
      void status().then((run) => {
        const url = audioUrl(sim, run, audio);
        if (!url) return;
        try {
          void new Audio(url).play().catch(() => undefined);
        } catch {
          /* no audio device: the text is enough */
        }
      });
    }
  };
  return {
    line: (r) => show("line", r.who ? `${String(r.who)}: ${String(r.text ?? "")}` : String(r.text ?? ""), r.audio),
    narrator: (r) => show("narrator", String(r.text ?? ""), r.audio),
    log: () => [...seen],
  };
}
