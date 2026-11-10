import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // bcrypt at cost 12 is deliberately slow; several auth tests hash more than once.
    testTimeout: 20_000,
    setupFiles: ["./tests/setup/global.ts", "./tests/setup/shifted-clock.ts"],
    include: ["tests/**/*.test.ts"],
  },
});
