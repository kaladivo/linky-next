import { defineConfig } from "vitest/config";

// Only the pure amount/display-unit logic is unit-tested here (no React
// Native imports). Components are covered by agent-device runs in the app.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
