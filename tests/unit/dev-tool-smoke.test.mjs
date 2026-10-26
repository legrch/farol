import { expect, it } from "vitest";
import { devToolSmokePlan } from "../../tooling/dev-tool-smoke.mjs";
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
