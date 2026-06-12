import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Tests are deterministic (in-memory sqlite, fake relay network, fake
    // push transport); the generous timeout only absorbs machine load when
    // turbo runs packages in parallel (crypto-heavy suites flake at 5s).
    testTimeout: 60_000,
  },
});
