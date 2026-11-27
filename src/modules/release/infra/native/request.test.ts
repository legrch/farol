import { describe, expect, it } from "vitest";
import {
  assertInput,
  validInode,
  type InstalledUpdateRequest,
} from "./request";

const build = (char: string, version: string) => ({
  digest: char.repeat(64),
  version,
  buildId: char.repeat(64),
});

function request(extra: Record<string, unknown> = {}): InstalledUpdateRequest {
  return {
    action: "apply",
    operationId: "1".repeat(32),
    source: build("a", "1.0.0"),
    target: build("b", "1.1.0"),
    drain: {
      status: "reconciled",
      acceptedSource: "a".repeat(64),
      acceptedTarget: "b".repeat(64),
    },
    pid: 42,
    processStart: "Mon Jan  1 00:00:00 2024",
    waitSeconds: 30,
    relaunch: true,
    ...extra,
  } as InstalledUpdateRequest;
}

const closed = {
  kind: "confirmed_closed",
  startedAt: "2024-01-01T00:00:00Z",
  lastQuitSha256: "c".repeat(64),
  stateIdentity: { device: "1", inode: "2" },
};

describe("validInode", () => {
  it("accepts canonical decimal strings only", () => {
    expect(validInode({ device: "0", inode: "12" })).toBe(true);
    expect(validInode({ device: "01", inode: "1" })).toBe(false);
    expect(validInode({ device: "1", inode: "" })).toBe(false);
    expect(validInode({ device: "1", inode: "1".repeat(31) })).toBe(false);
  });
});

describe("assertInput", () => {
  it("accepts a plain request", () => {
    expect(() => assertInput(request())).not.toThrow();
  });

  it.each([
    ["bad action", { action: "other" }],
    ["short operation id", { operationId: "1" }],
    ["same digest", { target: build("a", "1.1.0") }],
    ["bad version", { source: build("a", "1.0") }],
    ["pid one", { pid: 1 }],
    ["zero wait", { waitSeconds: 0 }],
    ["long wait", { waitSeconds: 121 }],
    ["blank start", { processStart: " " }],
    ["bad location", { installLocation: "elsewhere" }],
    [
      "presentation without relaunch",
      { relaunchPresentation: "sidecar-only", relaunch: false },
    ],
    ["unreconciled drain", { drain: { status: "open" } }],
  ])("refuses %s", (_name, extra) => {
    expect(() => assertInput(request(extra))).toThrow(
      "INSTALLED_UPDATE_INPUT_INVALID",
    );
  });

  it("validates the closed predecessor", () => {
    expect(() => assertInput(request({ predecessor: closed }))).not.toThrow();
    expect(() =>
      assertInput(
        request({ predecessor: { ...closed, startedAt: "yesterday" } }),
      ),
    ).toThrow("INSTALLED_UPDATE_INPUT_INVALID");
    expect(() =>
      assertInput(request({ action: "recover", predecessor: closed })),
    ).toThrow("INSTALLED_UPDATE_INPUT_INVALID");
    expect(() =>
      assertInput(request({ action: "rollback", predecessor: closed })),
    ).toThrow("INSTALLED_UPDATE_INPUT_INVALID");
    expect(() =>
      assertInput(
        request({
          action: "rollback",
          relaunch: false,
          predecessor: closed,
        }),
      ),
    ).not.toThrow();
  });
});
