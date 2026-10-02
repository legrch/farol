import { describe, expect, it } from "vitest";
import {
  closedRecoveryUserData,
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
    ).toBe(`${appData}/Farol Next Preview`);
  });
  it("keeps ordinary Dev separate from production and acceptance profiles", () => {
    expect(closedRecoveryUserData(home, true, inspect(null, directory))).toBe(
      `${appData}/Farol Dev`,
    );
    expect(closedRecoveryUserData(home, true, inspect(directory, null))).toBe(
      `${appData}/Farol DEV`,
    );
    expect(
      closedRecoveryUserData(home, true, inspect(directory, directory)),
    ).toBe(`${appData}/Farol Dev`);
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
