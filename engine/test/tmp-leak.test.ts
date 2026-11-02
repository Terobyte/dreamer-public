import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const engineDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Node and tsx reuse these per-user tool caches in TMPDIR across runs.
const toolCacheAllowlist = ["node-compile-cache", /^tsx-\d+$/] as const;
let tempRoot: string;

beforeAll(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "tmp-leak-")).toString();
});

afterAll(() => {
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
});

it.skipIf(process.env.TMP_LEAK_CHILD === "1")(
  "leaves no temp entries behind after a vitest run",
  () => {
    const child = spawnSync(
      "npx",
      ["vitest", "run", "test/schema.test.ts", "test/budget.test.ts"],
      {
        cwd: engineDir,
        env: {
          ...process.env,
          TMPDIR: tempRoot,
          TMP: tempRoot,
          TEMP: tempRoot,
          TMP_LEAK_CHILD: "1",
        },
        encoding: "utf8",
        timeout: 120_000,
      },
    );

    expect(
      child.error,
      `child vitest failed to spawn: ${child.error?.message ?? "unknown error"}`,
    ).toBeUndefined();
    expect(
      child.status,
      `child vitest exited with status ${child.status}; stdout:\n${child.stdout}\nstderr:\n${child.stderr}`,
    ).toBe(0);

    const leftovers = readdirSync(tempRoot).filter(
      (entry) =>
        !toolCacheAllowlist.some((allowed) =>
          typeof allowed === "string" ? entry === allowed : allowed.test(entry),
        ),
    );
    expect(leftovers, `leftover temp entries: ${leftovers.join(", ")}`).toEqual([]);
  },
  180_000,
);
