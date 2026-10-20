import { describe, it, expect } from "vitest";
import { coreTestSteps } from "../../tooling/core-test-plan.mjs";

describe("preserved public core command chain", () => {
  it("preserves every original core command, flag, order, protocol file and nested-module context", () => {
    expect(
      coreTestSteps({ nested: true, node: "node", go: "go" }).map(
        ({ executable, args, cwd }) => [executable, args, cwd ?? "."],
      ),
    ).toEqual([
      ["node", ["tooling/generate-desktop-wire.mjs", "--check"], "."],
      ["node", ["tooling/check-go-architecture.mjs"], "."],
      ["go", ["test", "-race", "./..."], "."],
      ["go", ["vet", "./..."], "."],
      ["go", ["test", "-race", "./..."], "resources/native/go"],
      ["go", ["vet", "./..."], "resources/native/go"],
      [
        "node",
        [
          "node_modules/vitest/vitest.mjs",
          "run",
          "tests/contract/desktop-wire.test.ts",
          "tests/architecture/go-architecture.test.ts",
        ],
        ".",
      ],
      [
        "node",
        [
          "node_modules/typescript/bin/tsc",
          "--noEmit",
          "--project",
          "tooling/tsconfig.desktop-core.json",
        ],
        ".",
      ],
      ["node", ["node_modules/typescript/bin/tsc", "--noEmit"], "."],
    ]);
    const absent = coreTestSteps({ nested: false, node: "node", go: "go" });
    expect(absent.filter((step) => step.id.startsWith("nested-"))).toEqual([
      {
        id: "nested-go-absent",
        message: "Nested release Go module absent from this accepted base.",
      },
    ]);
    expect(absent.filter((step) => step.args?.[0] === "test")).toHaveLength(1);
  });
});
