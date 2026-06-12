import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Tests are deterministic (TestClock, fake transports); the generous
    // timeout only absorbs machine load when turbo runs packages in
    // parallel (crypto-heavy suites flaked at the 5s default).
    testTimeout: 60_000,
  },
});
