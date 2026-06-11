import { defineConfig } from "vitest/config";

// Only the runtime-agnostic bridge logic is unit-tested here (pure
// TypeScript + effect, no React Native imports). Anything touching RN or
// Expo is covered by agent-device runs instead.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
