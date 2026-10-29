import { existsSync, readFileSync } from "node:fs";

/** The marks a CLI run wrote to `DREAMER_TIMING_FILE` (src/report/timing.ts), in order. */
export function readMarks(file: string): Array<{ mark: string; t: number }> {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as { mark: string; t: number });
}
