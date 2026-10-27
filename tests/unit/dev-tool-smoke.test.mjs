import { expect, it } from "vitest";
import {
  devToolSmokeNode,
  devToolSmokePlan,
} from "../../tooling/dev-tool-smoke.mjs";
import { resolveToolchain } from "../../tooling/dev.mjs";

it("uses the declared Node found by the actual toolchain resolver", () => {
  const toolchain = resolveToolchain({
    currentNode: "22.19.0",
    currentNpm: "10.9.3",
    candidates: ["/fixture/node/bin"],
    probe: () => ({
      nodeBin: "/fixture/node/bin/node",
      npmBin: "/fixture/node/bin/npm",
      nodeVersion: "24.20.0",
      npmVersion: "11.19.0",
    }),
  });
  expect(devToolSmokeNode(toolchain, "/old/node")).toBe(
    "/fixture/node/bin/node",
  );
  expect(devToolSmokeNode({ status: "current" }, "/current/node")).toBe(
    "/current/node",
  );
  expect(() => devToolSmokeNode({ status: "missing" }, "/old/node")).toThrow(
    "DEV_TOOL_SMOKE_TOOLCHAIN_REQUIRED",
  );
});
it("runs the existing exact-Dev witness with explicit source/build pins, never owner or live flags", () => {
  const plan = devToolSmokePlan("/fixture/repo", {
    sourceCommit: "a".repeat(40),
    buildId: "b".repeat(64),
  });
  expect(plan.map((args) => args[1])).toEqual(["--check", "--run-native"]);
  for (const args of plan) {
    expect(args).toContain("--dev-shell");
    expect(args).toContain(
      "/fixture/repo/_output/dev-core/Contents/Resources/app",
    );
    expect(args).toContain("a".repeat(40));
    expect(args).toContain("b".repeat(64));
    expect(args.join(" ")).not.toMatch(
      /tunnel|user-data|Send|acceptance-profile/,
    );
  }
});
