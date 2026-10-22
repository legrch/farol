import { describe, expect, it } from "vitest";
import { installedEmptyQuitScope } from "../../src/apps/desktop/closed-empty-chat-recovery";
import {
  parseInstalledEmptyRecoveryOptions,
  assertInstalledEmptyRecoveryProcesses,
} from "../../tooling/recover-installed-empty-chat.mjs";

// Pure admission and receipt parsing. No real profile, child or provider proof.
const run = {
  schema: 1,
  pid: 2147483647,
  startedAt: "2026-10-10T10:00:00.000Z",
  bootTime: null,
  processStart: null,
};
const quit = {
  schema: 1,
  at: "2026-10-10T10:01:00.000Z",
  drained: false,
  unconfirmed: ["connector", "go-core"],
};
const exact = [
  "--apply",
  "--selection",
  "/private/tmp/selected.json",
  "--selection-sha",
  "a".repeat(64),
  "--expected-source",
  "b".repeat(40),
  "--expected-run",
  "c".repeat(64),
  "--expected-config",
  "d".repeat(64),
  "--expected-quit",
  "e".repeat(64),
];

describe("installed consumed-empty maintenance scope", () => {
  it("accepts both original component orders without changing the receipt", () => {
    for (const order of [
      ["connector", "go-core"],
      ["go-core", "connector"],
    ]) {
      const receipt = { ...quit, unconfirmed: order };
      const before = JSON.stringify(receipt);
      expect(() => installedEmptyQuitScope(run, receipt)).not.toThrow();
      expect(JSON.stringify(receipt)).toBe(before);
    }
  });
  it.each(
    [
      [],
      ["go-core"],
      ["connector"],
      ["connector", "connector"],
      ["go-core", "chat"],
      ["connector", "go-core", "chat"],
    ].map((components) => ({ components })),
  )("rejects unsupported components %#", ({ components }) => {
    expect(() =>
      installedEmptyQuitScope(run, { ...quit, unconfirmed: components }),
    ).toThrow("INSTALLED_EMPTY_RECOVERY_QUIT_CHANGED");
  });
  it("rejects clean, previous, malformed and unknown-field receipts", () => {
    for (const receipt of [
      { ...quit, drained: true },
      { ...quit, at: "2026-10-10T09:59:59.999Z" },
      { ...quit, at: run.startedAt },
      { ...quit, at: "invalid" },
      { ...quit, unknown: true },
    ])
      expect(() => installedEmptyQuitScope(run, receipt)).toThrow(
        "INSTALLED_EMPTY_RECOVERY_QUIT_CHANGED",
      );
  });
  it("admits only exact evidence with a failed Quit hash", () => {
    expect(parseInstalledEmptyRecoveryOptions(exact)["--expected-quit"]).toBe(
      "e".repeat(64),
    );
    for (let n = 0; n < exact.length; n++)
      if (exact[n].startsWith("--"))
        expect(() =>
          parseInstalledEmptyRecoveryOptions([
            ...exact.slice(0, n),
            ...exact.slice(n + (n === 0 ? 1 : 2)),
          ]),
        ).toThrow();
  });
  it.each([
    "--development",
    "--home",
    "--profile",
    "--production",
    "--retry",
    "--resume",
    "--force",
    "--apply",
    "--unacknowledged-dev",
    "--interrupted-retirement",
  ])("refuses %s", (flag) => {
    expect(() =>
      parseInstalledEmptyRecoveryOptions([...exact, flag, "anything"]),
    ).toThrow();
  });
  it("probes both fixed installed child scopes and stops on the original failure", () => {
    const root =
      "/Users/test/Library/Application Support/io.github.legrch.farol/farol-state/secure-mcp-connector";
    const seen = [];
    assertInstalledEmptyRecoveryProcesses(root, (r) => seen.push(r));
    expect(seen).toEqual([
      root,
      root.replace("secure-mcp-connector", "go-core"),
    ]);
    const refused = [];
    expect(() =>
      assertInstalledEmptyRecoveryProcesses(root, (r) => {
        refused.push(r);
        throw Error("PROCESS_UNKNOWN");
      }),
    ).toThrow("PROCESS_UNKNOWN");
    expect(refused).toEqual([root]);
  });
});

describe("explicit owner cold-machine plan options", () => {
  it("requires both exact plan path and independent hash", () => {
    expect(
      parseInstalledEmptyRecoveryOptions([
        ...exact,
        "--cold-restart-plan",
        "/private/tmp/plan.json",
        "--cold-restart-plan-sha",
        "f".repeat(64),
      ])["--cold-restart-plan"],
    ).toBe("/private/tmp/plan.json");
    expect(() =>
      parseInstalledEmptyRecoveryOptions([
        ...exact,
        "--cold-restart-plan",
        "/private/tmp/plan.json",
      ]),
    ).toThrow("COLD_MACHINE_PLAN_EXACT_EVIDENCE_REQUIRED");
    expect(() =>
      parseInstalledEmptyRecoveryOptions([
        ...exact,
        "--cold-restart-plan-sha",
        "f".repeat(64),
      ]),
    ).toThrow("COLD_MACHINE_PLAN_EXACT_EVIDENCE_REQUIRED");
  });
});
