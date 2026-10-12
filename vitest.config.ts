import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.{ts,tsx,mjs}"],
    exclude: ["tests/renderer/**"],
    sequence: { concurrent: false },
    // Bound file-level native helper/compiler fan-out on a shared Mac. Keep
    // product deadlines and coverage gates unchanged; each fixture owns its IO.
    maxWorkers: 2,
    // 23 integration files spawn real processes, helpers or volumes, and none
    // of that fits vitest's 5 s default on a loaded machine. A budget, not an
    // assertion; 30 s still catches a hang.
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      reportsDirectory: "_output/coverage",
      include: ["src/modules/**/*.ts", "src/pkg/**/*.ts"],
      exclude: [
        "src/**/*.d.ts",
        "src/**/contract/**/*.ts",
        "src/modules/**/app/port/**/*.ts",
        "src/pkg/ipc/**/*.ts",
        "src/pkg/kernel/app/**/*.ts",
      ],
      thresholds: {
        lines: 88,
        functions: 88,
        statements: 88,
        branches: 82,
        "src/modules/**/domain/*.ts": {
          lines: 92,
          functions: 100,
          statements: 92,
          branches: 85,
        },
        "src/modules/**/app/service/*.ts": {
          lines: 96,
          functions: 100,
          statements: 95,
          branches: 80,
        },
        "src/pkg/{async,sse}/**/*.ts": {
          lines: 85,
          functions: 90,
          statements: 85,
          branches: 75,
        },
        "src/modules/chat/infra/server/preview-runtime.ts": {
          lines: 80,
          functions: 80,
          statements: 80,
          branches: 70,
        },
      },
    },
  },
});
