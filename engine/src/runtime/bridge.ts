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

export function createBridge(engine: BridgeEngine, io: BridgeIO): Bridge {
  return {
    handle(ev: unknown): void {
      const e = ev as { type?: unknown; object?: unknown; state?: unknown } | null;
      if (!e || typeof e !== "object" || typeof e.type !== "string") {
        io.warn(`sim event without a type: ${JSON.stringify(ev)}`);
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
