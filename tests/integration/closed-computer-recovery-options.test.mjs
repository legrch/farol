import fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  closedRecoveryUserData,
  assertClosedRecoveryProcesses,
  parseClosedRecoveryOptions,
} from "../../tooling/recover-closed-computer.mjs";

const valid = [
  "--apply",
  "--operation",
  "11111111-1111-4111-8111-111111111111",
  "--expected-run",
  "a".repeat(64),
  "--expected-quit",
  "b".repeat(64),
];
describe("closed Computer maintenance command boundary (no owner state read)", () => {
  it("requires an explicit operation and both exact historical byte identities", () => {
    expect(parseClosedRecoveryOptions(valid)).toEqual({
      operationId: valid[2],
      expectedRunSha256: valid[4],
      expectedQuitSha256: valid[6],
    });
  });
  it("selects ordinary Dev only through the explicit maintenance option", () => {
    expect(parseClosedRecoveryOptions([...valid, "--development"])).toEqual({
      operationId: valid[2],
      expectedRunSha256: valid[4],
      expectedQuitSha256: valid[6],
      development: true,
    });
  });
  for (const extra of [
    ["--home", "/tmp/home"],
    ["--user-data", "/tmp/profile"],
    ["--force"],
    ["--apply"],
    ["--operation", "duplicate"],
    ["--development", "--development"],
    ["--development", "preview"],
  ]) {
    it(`refuses ${extra[0]} without an alternate state/helper route`, () => {
      expect(() => parseClosedRecoveryOptions([...valid, ...extra])).toThrow(
        "CLOSED_COMPUTER_RECOVERY_OPTIONS_INVALID",
      );
    });
  }
  it("refuses missing or malformed evidence instead of selecting a new operation", () => {
    expect(() => parseClosedRecoveryOptions(valid.slice(1))).toThrow(
      "CLOSED_COMPUTER_RECOVERY_EXACT_EVIDENCE_REQUIRED",
    );
    expect(() => parseClosedRecoveryOptions(valid.slice(0, -1))).toThrow(
      "CLOSED_COMPUTER_RECOVERY_EXACT_EVIDENCE_REQUIRED",
    );
  });
});

describe("closed Computer maintenance profile selection (synthetic metadata)", () => {
  const home = "/private/tmp/synthetic-owner";
  const appData = `${home}/Library/Application Support`;
  const directory = {
    device: "1",
    inode: "101",
    directory: true,
    symbolicLink: false,
  };
  const samePath = (candidate) => candidate;
  const inspect = (legacy, preferred) => (candidate) => {
    if (candidate === `${appData}/Farol DEV`) return legacy;
    expect(candidate).toBe(`${appData}/Farol Dev`);
    return preferred;
  };
  it("keeps default production recovery independent of the Dev profile", () => {
    expect(
      closedRecoveryUserData(home, false, () => {
        throw new Error("MUST_NOT_INSPECT_DEV");
      }),
    ).toBe(`${appData}/io.github.legrch.farol`);
  });
  it("keeps ordinary Dev separate from production and acceptance profiles", () => {
    expect(
      closedRecoveryUserData(home, true, inspect(null, directory), samePath),
    ).toBe(`${appData}/Farol Dev`);
    expect(
      closedRecoveryUserData(home, true, inspect(directory, null), samePath),
    ).toBe(`${appData}/Farol DEV`);
    expect(
      closedRecoveryUserData(
        home,
        true,
        inspect(directory, directory),
        samePath,
      ),
    ).toBe(`${appData}/Farol Dev`);
  });
  it("uses the physical legacy spelling for same-inode case aliases", () => {
    const selected = `${appData}/Farol Dev`;
    const physical = `${appData}/Farol DEV`;
    const canonicalize = (candidate) => {
      expect(candidate).toBe(selected);
      return physical;
    };
    expect(
      closedRecoveryUserData(
        home,
        true,
        inspect(directory, directory),
        canonicalize,
      ),
    ).toBe(physical);
  });
  it("retains a disposable legacy directory and supplies an exact physical path", async () => {
    const temporary = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-dev-recovery-name-"),
    );
    const home = realpathSync(temporary);
    try {
      const appData = path.join(home, "Library", "Application Support");
      const legacy = path.join(appData, "Farol DEV");
      await fs.mkdir(legacy, { recursive: true, mode: 0o700 });
      const before = await fs.lstat(legacy);
      const selected = closedRecoveryUserData(home, true);
      const after = await fs.lstat(selected);
      // Recovery uses fs.promises.realpath. On a case-insensitive volume the
      // JavaScript sync resolver can preserve an alias spelling that the
      // native asynchronous resolver correctly rejects as non-canonical.
      expect(await fs.realpath(selected)).toBe(selected);
      expect(after.dev).toBe(before.dev);
      expect(after.ino).toBe(before.ino);
      expect(await fs.readdir(appData)).toEqual(["Farol DEV"]);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
  it.each([
    `${appData}/unrelated`,
    `${home}/other/Farol Dev`,
    `${appData}/io.github.legrch.farol`,
    `${appData}/Farol Dev/child`,
  ])(
    "refuses canonicalization outside both fixed Dev entries (%s)",
    (physical) => {
      expect(() =>
        closedRecoveryUserData(
          home,
          true,
          inspect(null, directory),
          () => physical,
        ),
      ).toThrow("DEV_PROFILE_DIRECTORY_UNSAFE");
    },
  );
  it("refuses an unreadable canonical path before maintenance", () => {
    expect(() =>
      closedRecoveryUserData(home, true, inspect(null, directory), () => {
        throw new Error("synthetic unreadable metadata");
      }),
    ).toThrow("DEV_PROFILE_DIRECTORY_UNREADABLE");
  });
  it("refuses distinct or unsafe profiles before any maintenance action", () => {
    expect(() =>
      closedRecoveryUserData(
        home,
        true,
        inspect(directory, { ...directory, inode: "202" }),
      ),
    ).toThrow("DEV_PROFILE_DIRECTORY_AMBIGUOUS");
    expect(() =>
      closedRecoveryUserData(
        home,
        true,
        inspect(null, { ...directory, symbolicLink: true }),
      ),
    ).toThrow("DEV_PROFILE_DIRECTORY_UNSAFE");
  });
  it("refuses an untyped environment instead of choosing another profile", () => {
    expect(() => closedRecoveryUserData(home, "dev")).toThrow(
      "CLOSED_COMPUTER_RECOVERY_OPTIONS_INVALID",
    );
  });
});

describe("closed recovery process checks across physical Dev spellings", () => {
  const appData = "/private/tmp/synthetic-owner/Library/Application Support";
  const suffix = "/farol-state/secure-mcp-connector";
  it("checks both fixed Dev aliases so canonicalization cannot miss a child", () => {
    const observed = [];
    assertClosedRecoveryProcesses(
      `${appData}/Farol DEV${suffix}`,
      true,
      (root) => {
        observed.push(root);
      },
    );
    expect(observed).toEqual([
      `${appData}/Farol DEV${suffix}`,
      `${appData}/Farol Dev${suffix}`,
    ]);
  });
  it("propagates a failed process check without trying another spelling", () => {
    const observed = [];
    expect(() =>
      assertClosedRecoveryProcesses(
        `${appData}/Farol Dev${suffix}`,
        true,
        (root) => {
          observed.push(root);
          throw new Error("CLOSED_COMPUTER_RECOVERY_PROCESS_UNVERIFIED");
        },
      ),
    ).toThrow("CLOSED_COMPUTER_RECOVERY_PROCESS_UNVERIFIED");
    expect(observed).toEqual([`${appData}/Farol Dev${suffix}`]);
  });
  it("does not inspect Dev for default production maintenance", () => {
    const observed = [];
    const production = `${appData}/io.github.legrch.farol${suffix}`;
    assertClosedRecoveryProcesses(production, false, (root) =>
      observed.push(root),
    );
    expect(observed).toEqual([production]);
  });
  it("refuses a retained child using the non-canonical Dev spelling", () => {
    expect(() =>
      assertClosedRecoveryProcesses(
        `${appData}/Farol DEV${suffix}`,
        true,
        (root) => {
          if (root === `${appData}/Farol Dev${suffix}`)
            throw new Error("CLOSED_COMPUTER_RECOVERY_PROCESS_UNVERIFIED");
        },
      ),
    ).toThrow("CLOSED_COMPUTER_RECOVERY_PROCESS_UNVERIFIED");
  });
  it("refuses a non-Dev process root before any probe", () => {
    expect(() =>
      assertClosedRecoveryProcesses(
        `${appData}/io.github.legrch.farol${suffix}`,
        true,
        () => {
          throw new Error("MUST_NOT_PROBE");
        },
      ),
    ).toThrow("DEV_PROFILE_DIRECTORY_UNSAFE");
  });
});
