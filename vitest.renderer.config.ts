import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["tests/renderer/**/*.test.{ts,tsx}"],
    sequence: { concurrent: false },
    coverage: {
      provider: "v8",
      reportsDirectory: "_output/coverage/renderer",
      include: ["src/ui/renderer/**/*.{ts,tsx}"],
      exclude: ["src/ui/renderer/contract.ts", "src/ui/renderer/entry.tsx"],
      thresholds: { lines: 75, statements: 75, functions: 75, branches: 65 },
    },
  },
});
