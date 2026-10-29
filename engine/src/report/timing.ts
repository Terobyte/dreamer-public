import { appendFileSync } from "node:fs";

/**
 * Wall-clock marks for tests that time one part of a CLI run. A loaded machine
 * makes node+tsx startup and the chromium launch take seconds on their own,
 * and those say nothing about whether a deadline was honoured; a test that
 * sets `DREAMER_TIMING_FILE` reads where each phase started instead of timing
 * the whole process. One JSON line per mark: `{"mark": name, "t": epoch ms}`.
 * Unset (the normal case), this does nothing.
 */
export function mark(name: string): void {
  const file = process.env.DREAMER_TIMING_FILE;
  if (!file) return;
  try {
    appendFileSync(file, JSON.stringify({ mark: name, t: Date.now() }) + "\n");
  } catch {
    // a timing file that cannot be written must not change what the CLI does
  }
}
