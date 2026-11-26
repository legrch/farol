import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  readyMatches,
  resourcesOriginRefused,
  supervisedControlRefused,
} from "./origin";
import type { InstalledUpdateResourcesOrigin } from "./startup";

const userData = "/Users/someone/Library/Application Support/farol";
const operationId = "1".repeat(32);
const privateApp = path.join(
  userData,
  "installed-updates",
  operationId,
  "launch-Farol.app",
);
const origin = (over: object): InstalledUpdateResourcesOrigin =>
  ({
    kind: "shared-slot",
    slot: "/Applications/Farol.app",
    app: "/Applications/Farol.app",
    ...over,
  }) as never;

describe("resourcesOriginRefused", () => {
  const check = (
    value: InstalledUpdateResourcesOrigin,
    over: Partial<Parameters<typeof resourcesOriginRefused>[0]> = {},
  ) =>
    resourcesOriginRefused({
      origin: value,
      supervised: false,
      actualApp: value.app,
      userData,
      ...over,
    });
  it("accepts the shared slot and the operation's own private launch", () => {
    expect(check(origin({}))).toBe(false);
    expect(
      check(origin({ kind: "private-launch", operationId, app: privateApp })),
    ).toBe(false);
  });
  it("refuses a supervised owner, another slot or another running app", () => {
    expect(check(origin({}), { supervised: true })).toBe(true);
    expect(check(origin({ slot: "/Other/Farol.app" }))).toBe(true);
    expect(check(origin({}), { actualApp: "/elsewhere" })).toBe(true);
  });
  it("refuses an unknown kind and a shared origin at another path", () => {
    expect(check(origin({ kind: "other" }))).toBe(true);
    expect(check(origin({ app: "/Other/Farol.app" }))).toBe(true);
  });
  it("refuses a private launch with a malformed id or another location", () => {
    expect(
      check(
        origin({ kind: "private-launch", operationId: "XYZ", app: privateApp }),
      ),
    ).toBe(true);
    expect(
      check(
        origin({
          kind: "private-launch",
          operationId,
          app: "/Applications/Farol.app",
        }),
      ),
    ).toBe(true);
  });
});

describe("supervisedControlRefused", () => {
  const input = {
    userData: "/p",
    profile: "/p",
    leaseFile: "/p/lease",
    leasePath: (profile: string) => `${profile}/lease`,
    resourcesApp: "/Staging/Farol.app",
    slot: "/Applications/Farol.app",
    directory: "/Staging/Farol.app/Contents/Resources/app",
  };
  it("accepts a staged app beside the captured profile and slot", () => {
    expect(supervisedControlRefused(input)).toBe(false);
  });
  it("refuses another profile, lease, slot, location or directory", () => {
    expect(supervisedControlRefused({ ...input, userData: "/q" })).toBe(true);
    expect(supervisedControlRefused({ ...input, leaseFile: "/x" })).toBe(true);
    expect(
      supervisedControlRefused({ ...input, resourcesApp: input.slot }),
    ).toBe(true);
    expect(
      supervisedControlRefused({ ...input, resourcesApp: "/p/inside.app" }),
    ).toBe(true);
    expect(supervisedControlRefused({ ...input, directory: "/x" })).toBe(true);
  });
  it("does not ask for the lease path of a different profile", () => {
    let asked = 0;
    supervisedControlRefused({
      ...input,
      userData: "/q",
      leasePath: (profile) => {
        asked += 1;
        return profile;
      },
    });
    expect(asked).toBe(0);
  });
});

describe("readyMatches", () => {
  const digest = "a".repeat(64);
  const buildId = "b".repeat(64);
  const input = {
    digest,
    expectedDigest: digest,
    manifestBuildId: buildId,
    expectedBuildId: buildId,
    ready: {
      operation: null,
      downloadId: "2".repeat(32),
      handle: `/root/download-${"2".repeat(32)}/archive`,
    },
    root: "/root",
  };
  it("accepts an unclaimed archive in its own download directory", () => {
    expect(readyMatches(input)).toBe(true);
  });
  it("refuses a changed record, an unparsed manifest or another build", () => {
    expect(readyMatches({ ...input, digest: "c".repeat(64) })).toBe(false);
    expect(readyMatches({ ...input, manifestBuildId: null })).toBe(false);
    expect(readyMatches({ ...input, expectedBuildId: "c".repeat(64) })).toBe(
      false,
    );
  });
  it("refuses a claimed, released or misplaced archive", () => {
    const ready = input.ready;
    for (const over of [
      { operation: {} },
      { preparation: {} },
      { helper: { pid: 2, processStart: null } },
      { archiveReleased: true },
      { downloadId: undefined },
      { handle: "/root/elsewhere/archive" },
    ])
      expect(readyMatches({ ...input, ready: { ...ready, ...over } })).toBe(
        false,
      );
    expect(readyMatches({ ...input, ready: { ...ready, helper: null } })).toBe(
      true,
    );
  });
});
