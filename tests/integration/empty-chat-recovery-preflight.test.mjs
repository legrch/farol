import { describe, expect, it } from "vitest";
import {
  assertEmptyRecoveryProcesses,
  parseEmptyRecoveryOptions,
} from "../../tooling/recover-empty-chat.mjs";

// Actual private CLI admission only; no process, profile, maintenance or native
// effect. These checks do not confer host or recovery authority.
describe("one-shot empty Chat recovery preflight", () => {
  it("checks connector and Go roots under both fixed Dev spellings", () => {
    const seen = [];
    assertEmptyRecoveryProcesses(
      "/Users/test/Library/Application Support/Farol DEV/farol-next-state/secure-mcp-connector",
      (root) => seen.push(root),
    );
    expect(seen).toEqual([
      "/Users/test/Library/Application Support/Farol DEV/farol-next-state/secure-mcp-connector",
      "/Users/test/Library/Application Support/Farol DEV/farol-next-state/go-core",
      "/Users/test/Library/Application Support/Farol Dev/farol-next-state/secure-mcp-connector",
      "/Users/test/Library/Application Support/Farol Dev/farol-next-state/go-core",
    ]);
  });
  it("refuses a Go child using the alternate spelling without continuing", () => {
    const seen = [];
    expect(() =>
      assertEmptyRecoveryProcesses(
        "/Users/test/Library/Application Support/Farol Dev/farol-next-state/secure-mcp-connector",
        (root) => {
          seen.push(root);
          if (root.endsWith("Farol DEV/farol-next-state/go-core"))
            throw Error("CLOSED_COMPUTER_RECOVERY_PROCESS_UNVERIFIED");
        },
      ),
    ).toThrow("CLOSED_COMPUTER_RECOVERY_PROCESS_UNVERIFIED");
    expect(seen).toHaveLength(4);
  });
  const exact = [
    "--apply",
    "--development",
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
  ];
  it("requires a complete exact Dev-only selection", () => {
    expect(parseEmptyRecoveryOptions(exact)["--expected-source"]).toBe(
      "b".repeat(40),
    );
    for (let n = 0; n < exact.length; n++) {
      if (exact[n].startsWith("--")) {
        const count = n < 2 ? 1 : 2;
        expect(() =>
          parseEmptyRecoveryOptions([
            ...exact.slice(0, n),
            ...exact.slice(n + count),
          ]),
        ).toThrow();
      }
    }
  });
  it("requires an explicit interrupted-retirement selection with the failed Quit digest", () => {
    const selected = [
      ...exact,
      "--interrupted-retirement",
      "--expected-quit",
      "e".repeat(64),
    ];
    expect(parseEmptyRecoveryOptions(selected)["--expected-quit"]).toBe(
      "e".repeat(64),
    );
    expect(() =>
      parseEmptyRecoveryOptions([...exact, "--interrupted-retirement"]),
    ).toThrow();
    expect(() =>
      parseEmptyRecoveryOptions([...exact, "--expected-quit", "e".repeat(64)]),
    ).toThrow();
    expect(() =>
      parseEmptyRecoveryOptions([...selected, "--interrupted-retirement"]),
    ).toThrow();
  });
  it("admits only the exact Dev unacknowledged-run mode with its failed Quit digest", () => {
    const selected = [
      ...exact,
      "--unacknowledged-dev",
      "--expected-quit",
      "e".repeat(64),
    ];
    expect(parseEmptyRecoveryOptions(selected)["--unacknowledged-dev"]).toBe(
      true,
    );
    expect(() =>
      parseEmptyRecoveryOptions([...exact, "--unacknowledged-dev"]),
    ).toThrow();
    expect(() =>
      parseEmptyRecoveryOptions([...selected, "--interrupted-retirement"]),
    ).toThrow();
    expect(() =>
      parseEmptyRecoveryOptions([...selected, "--unacknowledged-dev"]),
    ).toThrow();
  });
  it.each([
    "--profile",
    "--home",
    "--production",
    "--retry",
    "--resume",
    "--force",
    "--development",
  ])("refuses %s overrides or duplicates", (flag) => {
    expect(() =>
      parseEmptyRecoveryOptions([...exact, flag, "anything"]),
    ).toThrow();
  });
  it("refuses relative selection paths and malformed source/digests", () => {
    for (const [name, value] of [
      ["--selection", "relative.json"],
      ["--expected-source", "b".repeat(39)],
      ["--expected-run", "Z".repeat(64)],
    ]) {
      const bad = [...exact];
      bad[bad.indexOf(name) + 1] = value;
      expect(() => parseEmptyRecoveryOptions(bad)).toThrow();
    }
  });
});
