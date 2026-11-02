// vitest globalSetup: every run gets its own temp dir and removes it at the end.
// Tests call mkdtemp(os.tmpdir()) and almost never clean up; before this a gate run left
// hundreds of MB in $TMPDIR and three parallel runs filled the disk (Nov 1).
// Workers and the processes tests spawn inherit TMPDIR, so their temp files land here too.
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PREFIX = "engine-vitest-";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A run killed before teardown leaves its dir; the next run removes dirs of dead pids. */
function sweep(base: string): void {
  for (const name of readdirSync(base)) {
    const m = name.startsWith(PREFIX) ? /^(\d+)-/.exec(name.slice(PREFIX.length)) : null;
    if (m && !alive(Number(m[1]))) rmSync(join(base, name), { recursive: true, force: true });
  }
}

export default function setup(): () => void {
  const base = tmpdir();
  sweep(base);
  const own = mkdtempSync(join(base, `${PREFIX}${process.pid}-`));
  const saved = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
  process.env.TMPDIR = process.env.TMP = process.env.TEMP = own;
  return () => {
    rmSync(own, { recursive: true, force: true });
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}
