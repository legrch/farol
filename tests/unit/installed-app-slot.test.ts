import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installedFarolSlot,
  installedSlotBindingBytes,
  startInstalledUpdateHelper,
  type InstalledUpdateRequest,
} from "../../src/modules/release/infra/native/installed-update-helper";

afterEach(() => vi.restoreAllMocks());
describe("trusted installed slot selection (pure fixtures)", () => {
  function account() {
    vi.spyOn(os, "userInfo").mockReturnValue({
      uid: process.geteuid!(),
      gid: 20,
      homedir: "/Users/fixture",
      username: "fixture",
      shell: "/bin/zsh",
    });
  }
  it("selects only exact running resources and preserves legacy absence", () => {
    account();
    expect(installedFarolSlot()).toBe("/Users/fixture/Applications/Farol.app");
    expect(
      installedFarolSlot("/Applications/Farol.app/Contents/Resources/app"),
    ).toBe("/Applications/Farol.app");
    expect(
      installedFarolSlot(
        "/Users/fixture/Applications/Farol.app/Contents/Resources/app",
      ),
    ).toBe("/Users/fixture/Applications/Farol.app");
  });
  it.each([
    "/workspace/Farol.app/Contents/Resources/app",
    "/Applications/Farol.app/Contents/Resources/app/",
    "/Applications/../Applications/Farol.app/Contents/Resources/app",
    "/Users/other/Applications/Farol.app/Contents/Resources/app",
    "Contents/Resources/app",
  ])("refuses arbitrary or noncanonical resources %s", (resources) => {
    account();
    expect(() => installedFarolSlot(resources)).toThrow(
      "INSTALLED_UPDATE_SLOT_INVALID",
    );
  });
  it("does not consult HOME", () => {
    account();
    vi.stubEnv("HOME", "/workspace");
    try {
      expect(installedFarolSlot()).toBe(
        "/Users/fixture/Applications/Farol.app",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it.each([null, "/Applications/Farol.app", "SHARED", "", {}, undefined])(
    "refuses malformed explicit helper selection %s before any helper read/spawn",
    async (installLocation) => {
      const source = {
        version: "0.2.4",
        digest: "1".repeat(64),
        buildId: "2".repeat(64),
      };
      const target = {
        version: "0.2.5",
        digest: "3".repeat(64),
        buildId: "4".repeat(64),
      };
      const request = {
        installLocation,
        action: "apply",
        operationId: "a".repeat(32),
        source,
        target,
        drain: {
          status: "reconciled",
          acceptedSource: source.buildId,
          acceptedTarget: target.buildId,
        },
        pid: 123,
        processStart: "fixture",
        waitSeconds: 1,
        relaunch: false,
      } as unknown as InstalledUpdateRequest;
      await expect(
        startInstalledUpdateHelper(
          { kind: "refused", reason: "helper_go_core_required" },
          request,
        ),
      ).rejects.toThrow("INSTALLED_UPDATE_INPUT_INVALID");
    },
  );
});

it("binds the exact slot, operation ID and both build identities in canonical ASCII bytes", () => {
  const op = {
    operationId: "a".repeat(32),
    source: {
      version: "0.2.4",
      digest: "1".repeat(64),
      buildId: "2".repeat(64),
    },
    target: {
      version: "0.2.5",
      digest: "3".repeat(64),
      buildId: "4".repeat(64),
    },
  };
  const legacy = installedSlotBindingBytes(op, "legacy");
  const shared = installedSlotBindingBytes(op, "shared");
  expect(legacy).not.toEqual(shared);
  expect(shared.toString()).toBe(
    JSON.stringify({
      installLocation: "shared",
      operationId: op.operationId,
      schema: "farol.installed-operation-slot/1",
      source: {
        buildId: op.source.buildId,
        digest: op.source.digest,
        version: op.source.version,
      },
      target: {
        buildId: op.target.buildId,
        digest: op.target.digest,
        version: op.target.version,
      },
    }) + "\n",
  );
  expect(
    installedSlotBindingBytes({ ...op, operationId: "b".repeat(32) }, "shared"),
  ).not.toEqual(shared);
  expect(
    installedSlotBindingBytes(
      { ...op, target: { ...op.target, digest: "5".repeat(64) } },
      "shared",
    ),
  ).not.toEqual(shared);
});
