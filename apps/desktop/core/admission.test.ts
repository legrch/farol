import { describe, expect, it } from "vitest";
import { BridgeError } from "../bridge/client.ts";
import {
  refuseInvalidFreshLaunch,
  refuseInvalidShellSource,
  refuseMissingShellResources,
  refuseUnconfirmedPreviousDrain,
  shellAppRoot,
} from "./admission";

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof BridgeError ? error.code : "other";
  }
  return undefined;
}

describe("start admission", () => {
  it("refuses a fresh launch with a confirmed previous drain", () => {
    expect(codeOf(() => refuseInvalidFreshLaunch("fresh", true))).toBe(
      "invalid_fresh_launch",
    );
    expect(
      codeOf(() => refuseInvalidFreshLaunch("fresh", false)),
    ).toBeUndefined();
    expect(
      codeOf(() => refuseInvalidFreshLaunch(undefined, true)),
    ).toBeUndefined();
  });
  it("requires a confirmed drain for an ordinary launch", () => {
    expect(codeOf(() => refuseUnconfirmedPreviousDrain(undefined, false))).toBe(
      "previous_host_drain_unconfirmed",
    );
    expect(
      codeOf(() => refuseUnconfirmedPreviousDrain(undefined, true)),
    ).toBeUndefined();
    expect(
      codeOf(() => refuseUnconfirmedPreviousDrain("fresh", false)),
    ).toBeUndefined();
  });
  it("bounds the watchdog source", () => {
    const bad = (watchdogSource: unknown) =>
      codeOf(() => refuseInvalidShellSource({ watchdogSource }));
    expect(bad("x")).toBe("invalid_shell_launch_metadata");
    expect(bad(new Uint8Array(0))).toBe("invalid_shell_launch_metadata");
    expect(bad(new Uint8Array(64 * 1024 + 1))).toBe(
      "invalid_shell_launch_metadata",
    );
    expect(bad(new Uint8Array(64 * 1024))).toBeUndefined();
    expect(codeOf(() => refuseInvalidShellSource(undefined))).toBeUndefined();
  });
  it("requires resources only when a shell is selected", () => {
    expect(codeOf(() => refuseMissingShellResources(true, null))).toBe(
      "shell_host_resources_missing",
    );
    expect(codeOf(() => refuseMissingShellResources(true, {}))).toBeUndefined();
    expect(
      codeOf(() => refuseMissingShellResources(false, undefined)),
    ).toBeUndefined();
  });
  it("derives the app root only from the exact layout", () => {
    expect(shellAppRoot("/a/F.app/Contents/Resources/app")).toBe("/a/F.app");
    expect(codeOf(() => shellAppRoot("/a/b/c"))).toBe(
      "shell_host_layout_mismatch",
    );
  });
});
