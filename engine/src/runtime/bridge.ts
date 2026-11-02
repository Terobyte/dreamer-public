/** Sim <-> engine: events `{type, ...}` in, touches out. */
export interface DoorHandle {
  open(): void;
  close(): void;
  lock(): void;
  unlock?(): void;
}

export interface BridgeEngine {
  door(id: string): DoorHandle | null | undefined;
}

export interface BridgeIO {
  post(path: string, body: unknown): void;
  warn(msg: string): void;
}

export interface Bridge {
  handle(ev: unknown): void;
  touch(id: string): void;
}

/** Stage mode (`?stage=`): the sim's lines, remarks, touches, mode switch and story pieces. */
export type StageEvent = { type: string; [k: string]: unknown };
export interface StageHandlers {
  line?(e: StageEvent): void;
  narrator?(e: StageEvent): void;
  touch?(e: StageEvent): void;
  mode?(e: StageEvent): void;
  story?(e: StageEvent): void;
  start?(e: StageEvent): void;
  stage?(e: StageEvent): void;
  /** the last scene of the book is over (sim `book_end`) */
  book_end?(e: StageEvent): void;
  /** the book went on to its next scene: sim `transition` with `cause: "book"` only */
  scene_end?(e: StageEvent): void;
}
const STAGE_TYPES = ["line", "narrator", "touch", "mode", "story", "start", "stage", "book_end"] as const;
/** the sim's own names for what the stage calls `mode` / `story` (snapshot carries the mode; schedule and story events the pieces) */
const ALIAS: Record<string, (typeof STAGE_TYPES)[number]> = { snapshot: "mode", schedule: "story", event: "story" };

export function createBridge(engine: BridgeEngine, io: BridgeIO, stage: StageHandlers = {}): Bridge {
  return {
    handle(ev: unknown): void {
      const e = ev as { type?: unknown; object?: unknown; state?: unknown } | null;
      if (!e || typeof e !== "object" || typeof e.type !== "string") {
        io.warn(`sim event without a type: ${JSON.stringify(ev)}`);
        return;
      }
      if (e.type === "transition" && (e as { cause?: unknown }).cause === "book" && stage.scene_end) {
        stage.scene_end(e as StageEvent);
        return;
      }
      const key = ALIAS[e.type] ?? e.type;
      const h = (STAGE_TYPES as readonly string[]).includes(key) ? stage[key as (typeof STAGE_TYPES)[number]] : undefined;
      if (h) {
        h(e as StageEvent);
        return;
      }
      if (e.type !== "door") {
        io.warn(`sim event of unknown type "${e.type}" skipped`);
        return;
      }
      const door = engine.door(String(e.object));
      if (!door) {
        io.warn(`sim door "${String(e.object)}" is not in the engine scene`);
        return;
      }
      if (e.state === "locked") door.lock();
      else if (e.state === "open") {
        door.unlock?.();
        door.open();
      } else if (e.state === "closed") {
        door.unlock?.();
        door.close();
      } else io.warn(`sim door "${String(e.object)}": unknown state "${String(e.state)}"`);
    },
    touch(id: string): void {
      io.post("/event", { type: "touch", object: id });
    },
  };
}

/** Listen to the sandbox server's event stream at `base` and feed the bridge. */
export function connectSim(base: string, bridge: Bridge, warn: (m: string) => void): void {
  const src = new EventSource(`${base.replace(/\/$/, "")}/events`);
  src.onmessage = (m: MessageEvent): void => {
    try {
      bridge.handle(JSON.parse(String(m.data)));
    } catch (e) {
      warn(`sim event is not JSON: ${String(e)}`);
    }
  };
}

export function simPost(base: string): BridgeIO["post"] {
  return (path, body) => {
    void fetch(`${base.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => undefined);
  };
}
