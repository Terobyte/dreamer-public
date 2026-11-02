import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("B01: move/touch cancels exiting state", () => {
  const src = readFileSync(join(__dirname, "../src/runtime/stage/index.ts"), "utf-8");

  function handlerBlock(action: string): string {
    // грубо вырезаем ветку if (action === "<action>") { ... } до следующего if (action ===
    const marker = `action === "${action}"`;
    const start = src.indexOf(marker);
    expect(start, `branch ${action} must exist`).toBeGreaterThan(-1);
    // берём окно 1200 символов после маркера (ветка короткая)
    return src.slice(start, start + 1200);
  }

  it("goto/come сбрасывает exiting/exitThrough/exitPending/exitSettled", () => {
    const block = handlerBlock("goto") + handlerBlock("come");
    // Прерванный exit обязан отменяться: иначе update() выкинет актёра со сцены.
    // На текущем коде ветка goto/come только делает touch() и не чистит состояние выхода.
    expect(block.includes("exiting.delete")).toBe(true);
    expect(block.includes("exitThrough.delete")).toBe(true);
    expect(block.includes("exitPending.delete")).toBe(true);
    expect(block.includes("exitSettled.delete")).toBe(true);
  });
});
