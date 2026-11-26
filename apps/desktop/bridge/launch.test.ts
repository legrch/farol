import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { BridgeError } from "./errors.ts";
import {
  copyNativeCodexReadLaunch,
  copyShellMetadata,
  nativeArguments,
  refuseInvalidNative,
  refuseInvalidStartup,
  startupArguments,
  writeShellMetadata,
  type NativeCoreLaunch,
} from "./launch.ts";
import type { ProfileLaunchBinding } from "./profile.ts";

function launch(fields: Partial<NativeCoreLaunch> = {}): NativeCoreLaunch {
  return {
    profile: {
      beforeSpawn: () => {
        throw new Error("not used");
      },
      close: () => ({ state: "closed" }),
    },
    ownerId: "owner-1",
    computerId: "computer-1",
    storeMode: "open",
    ...fields,
  };
}

function refusal(action: () => void): string | undefined {
  try {
    action();
  } catch (error) {
    if (error instanceof BridgeError) return `${error.state}:${error.code}`;
    throw error;
  }
  return undefined;
}

const binding = {
  root: "/profile/root",
  device: "12",
  inode: "34",
  home: "/home",
  profileId: "profile",
} as unknown as ProfileLaunchBinding;

describe("copyNativeCodexReadLaunch", () => {
  it("returns nothing when the field is absent or undefined", () => {
    expect(copyNativeCodexReadLaunch({})).toBeUndefined();
    expect(copyNativeCodexReadLaunch({ codexRead: undefined })).toBeUndefined();
  });

  it("copies exactly the two trusted fields into a frozen value", () => {
    const copied = copyNativeCodexReadLaunch({
      codexRead: { hostId: "codex", trustedTemp: "/tmp/codex" },
    });
    expect(copied).toEqual({ hostId: "codex", trustedTemp: "/tmp/codex" });
    expect(Object.isFrozen(copied)).toBe(true);
  });

  it("refuses accessors, inherited fields and any other shape", () => {
    const refused = "refused:invalid_codex_read_launch";
    const getter = {};
    Object.defineProperty(getter, "codexRead", { get: () => undefined });
    expect(refusal(() => copyNativeCodexReadLaunch(getter))).toBe(refused);
    expect(
      refusal(() =>
        copyNativeCodexReadLaunch(Object.create({ codexRead: {} })),
      ),
    ).toBe(refused);
    for (const codexRead of [
      null,
      "codex",
      { hostId: "codex" },
      { hostId: "other", trustedTemp: "/tmp" },
      { hostId: "codex", trustedTemp: 1 },
      { hostId: "codex", trustedTemp: "/tmp", extra: true },
    ])
      expect(refusal(() => copyNativeCodexReadLaunch({ codexRead }))).toBe(
        refused,
      );
  });
});

describe("refuseInvalidStartup", () => {
  it("accepts no launch, normal and a complete fresh recovery", () => {
    expect(refusal(() => refuseInvalidStartup(undefined))).toBeUndefined();
    expect(
      refusal(() => refuseInvalidStartup(launch({ startupMode: "normal" }))),
    ).toBeUndefined();
    expect(
      refusal(() =>
        refuseInvalidStartup(
          launch({
            startupMode: "fresh",
            hostLifetimeId: "host",
            childLaunchId: "child",
            previousHostDrainConfirmed: false,
          }),
        ),
      ),
    ).toBeUndefined();
  });

  it("refuses an unknown startup mode", () => {
    expect(
      refusal(() =>
        refuseInvalidStartup(
          launch({ startupMode: "other" as unknown as "normal" }),
        ),
      ),
    ).toBe("refused:invalid_native_launch");
  });

  it("refuses a fresh launch without identity or with a confirmed drain", () => {
    const code = "refused:invalid_recovery_launch";
    expect(
      refusal(() => refuseInvalidStartup(launch({ startupMode: "fresh" }))),
    ).toBe(code);
    expect(
      refusal(() =>
        refuseInvalidStartup(
          launch({
            startupMode: "fresh",
            hostLifetimeId: "host",
            childLaunchId: "child",
            previousHostDrainConfirmed: true,
          }),
        ),
      ),
    ).toBe(code);
  });
});

describe("refuseInvalidNative", () => {
  const code = "refused:invalid_native_launch";

  it("accepts safe identifiers", () => {
    expect(
      refusal(() =>
        refuseInvalidNative(
          launch({
            hostLifetimeId: "host",
            childLaunchId: "child",
            settingsMutations: true,
          }),
        ),
      ),
    ).toBeUndefined();
  });

  it("refuses unsafe identifiers, a half pair and a bad store mode", () => {
    for (const fields of [
      { ownerId: "-bad" },
      { computerId: "" },
      { hostLifetimeId: "host" },
      { childLaunchId: "child" },
      { hostLifetimeId: "host", childLaunchId: "/bad" },
      { storeMode: "other" as unknown as "open" },
      { settingsMutations: "yes" as unknown as boolean },
    ])
      expect(refusal(() => refuseInvalidNative(launch(fields)))).toBe(code);
  });
});

describe("nativeArguments and startupArguments", () => {
  it("binds the child to the profile and native identity in order", () => {
    expect(nativeArguments(launch(), binding)).toEqual([
      "--profile-root",
      "/profile/root",
      "--profile-device",
      "12",
      "--profile-inode",
      "34",
      "--owner",
      "owner-1",
      "--computer",
      "computer-1",
      "--home",
      "/home",
      "--store-mode",
      "open",
    ]);
    expect(
      nativeArguments(
        launch({ hostLifetimeId: "host", childLaunchId: "child" }),
        binding,
      ).slice(-4),
    ).toEqual(["--host-lifetime", "host", "--child-launch", "child"]);
  });

  it("adds optional flags only when they were requested", () => {
    expect(startupArguments(undefined, undefined)).toEqual([]);
    expect(startupArguments(launch(), undefined)).toEqual([]);
    expect(
      startupArguments(
        launch({
          startupMode: "fresh",
          previousHostDrainConfirmed: true,
          settingsMutations: true,
        }),
        { hostId: "codex", trustedTemp: "/tmp/codex" },
      ),
    ).toEqual([
      "--startup-mode",
      "fresh",
      "--previous-host-drain-confirmed",
      "--settings-mutations",
      "--codex-read-host",
      "codex",
      "--codex-read-temp",
      "/tmp/codex",
    ]);
  });
});

describe("copyShellMetadata", () => {
  const ready = {
    settingsMutations: true,
    hostLifetimeId: "host",
    childLaunchId: "child",
  };

  it("has nothing to copy without metadata", () => {
    expect(copyShellMetadata(undefined)).toBeUndefined();
    expect(copyShellMetadata(launch())).toBeUndefined();
  });

  it("copies the bytes so later caller changes do not reach the child", () => {
    const source = new Uint8Array([1, 2, 3]);
    const copied = copyShellMetadata(
      launch({ ...ready, shellMetadata: source }),
    );
    source[0] = 9;
    expect([...(copied ?? [])]).toEqual([1, 2, 3]);
  });

  it("refuses empty, oversized, non-byte or unauthorised metadata", () => {
    const code = "refused:invalid_shell_launch_metadata";
    for (const fields of [
      { ...ready, shellMetadata: new Uint8Array() },
      { ...ready, shellMetadata: new Uint8Array(256 * 1024 + 1) },
      { ...ready, shellMetadata: "bytes" as unknown as Uint8Array },
      { ...ready, settingsMutations: false, shellMetadata: new Uint8Array(1) },
      { shellMetadata: new Uint8Array(1) },
    ])
      expect(refusal(() => copyShellMetadata(launch(fields)))).toBe(code);
  });
});

describe("writeShellMetadata", () => {
  it("settles once the bytes are delivered", async () => {
    const stream = new PassThrough();
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    await writeShellMetadata(stream, Buffer.from("meta"), 1000);
    expect(Buffer.concat(chunks).toString()).toBe("meta");
  });

  it("reports an unavailable delivery when the pipe fails", async () => {
    const stream = new PassThrough();
    const failing = writeShellMetadata(stream, Buffer.from("meta"), 1000);
    stream.destroy(new Error("broken"));
    await expect(failing).rejects.toMatchObject({
      state: "unavailable",
      code: "shell_metadata_delivery_failed",
    });
  });

  it("reports an unavailable delivery when the budget expires", async () => {
    const stalled = new PassThrough({ highWaterMark: 1 });
    stalled.pause();
    await expect(
      writeShellMetadata(stalled, Buffer.alloc(1 << 20), 20),
    ).rejects.toMatchObject({
      state: "unavailable",
      code: "shell_metadata_delivery_failed",
    });
  });
});
