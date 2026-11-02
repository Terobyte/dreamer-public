import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // each run writes temp files into its own dir and removes it at the end (tmp-leak.test.ts)
    globalSetup: ["test/tmp-setup.ts"],
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
