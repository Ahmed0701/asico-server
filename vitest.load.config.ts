import { defineConfig } from "vitest/config";

// The load check (tests/load, run by `npm run load:check`). Apart from the suite: its own include, one file at a time, and no
// time limit short of an hour.
export default defineConfig({
  test: {
    environment: "node",
    // The limiters guard people, not a measurement: the check sends the imports (and the rest) as fast as it can. The setup file
    // lifts the others; this lifts the import one, which the suite leaves at its default so its own tests can reach it.
    env: { IMPORT_RATE_LIMIT_MAX: "1000000" },
    testTimeout: 3_600_000,
    hookTimeout: 3_600_000,
    setupFiles: ["./tests/setup/global.ts"],
    include: ["tests/load/**/*.load.ts"],
    fileParallelism: false,
  },
});
