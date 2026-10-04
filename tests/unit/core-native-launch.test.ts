import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Client,
  spawnCore,
  type NativeCoreLaunch,
} from "../../apps/desktop/bridge/client.ts";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

// A simulated child proves launch mapping and resource lifetime only. It does
// not prove native profile identity, actual process cleanup or Go admission.
function fixture(closeOnEnd = true) {
  const child = Object.assign(new EventEmitter(), {
    pid: 123,
    exitCode: null,
    signalCode: null,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  if (closeOnEnd)
    child.stdin.once("finish", () => child.emit("close", 0, null));
  vi.mocked(spawn).mockReturnValue(
    child as unknown as ChildProcessWithoutNullStreams,
  );
  const handshake = vi.spyOn(Client.prototype, "handshake").mockResolvedValue({
    protocolMajor: 1,
    protocolMinor: 0,
    buildId: "test",
    profileId: "profile",
    backendGeneration: "generation",
    capabilities: [],
    maxFrameBytes: 1048576,
  });
  const profile = {
    beforeSpawn: vi.fn(() => ({
      state: "qualified" as const,
      binding: {
        profileId: "profile",
        root: "/private/profile",
        home: "/Users/owner",
        device: "18446744073709551615",
        inode: "9007199254740993",
      },
    })),
    close: vi.fn(() => ({ state: "closed" as const })),
  };
  const native: NativeCoreLaunch = {
    profile,
    ownerId: "owner",
    computerId: "computer",
    storeMode: "open",
  };
  return { child, handshake, native, profile };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("native backend launch binding", () => {
  it("retains the exact close event independently of mutable child status fields", async () => {
    const { child, native } = fixture();
    const client = await spawnCore(
      "/owned/backend",
      "profile",
      "test",
      1000,
      native,
    );
    const observed = await client.closeAndObserve();
    expect(observed).toEqual({ exitCode: 0, signal: null, forced: false });
    expect(Object.isFrozen(observed)).toBe(true);
    Object.assign(child, { exitCode: 9, signalCode: "SIGTERM" });
    expect(await client.closeAndObserve()).toBe(observed);
    expect(child.kill).not.toHaveBeenCalled();
  });
  it("does not promote exitCode properties to an observed terminal event", async () => {
    const { child, native } = fixture(false);
    const client = await spawnCore(
      "/owned/backend",
      "profile",
      "test",
      1000,
      native,
    );
    Object.assign(child, { exitCode: 0 });
    await expect(client.closeAndObserve()).rejects.toMatchObject({
      code: "backend_terminal_unobserved",
    });
    child.emit("close", 0, null);
    await expect(client.closeAndObserve()).rejects.toMatchObject({
      code: "backend_terminal_unobserved",
    });
    expect(child.kill).not.toHaveBeenCalled();
  });
  it("reports signal termination without converting it to normal exit", async () => {
    const { child, native } = fixture(false);
    const client = await spawnCore(
      "/owned/backend",
      "profile",
      "test",
      1000,
      native,
    );
    child.emit("close", null, "SIGTERM");
    expect(await client.closeAndObserve()).toEqual({
      exitCode: null,
      signal: "SIGTERM",
      forced: false,
    });
  });
  it("retains a forced termination attempt even if the child later reports exit zero", async () => {
    vi.useFakeTimers();
    const { child, native } = fixture(false);
    const client = await spawnCore(
      "/owned/backend",
      "profile",
      "test",
      1000,
      native,
    );
    const closing = client.closeAndObserve();
    await vi.advanceTimersByTimeAsync(1001);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    child.emit("close", 0, null);
    expect(await closing).toEqual({ exitCode: 0, signal: null, forced: true });
    await client.closeAndObserve();
    expect(child.kill).toHaveBeenCalledTimes(1);
  });
  it("keeps terminal timeout unknown after a late close event", async () => {
    vi.useFakeTimers();
    const { child, native } = fixture(false);
    const client = await spawnCore(
      "/owned/backend",
      "profile",
      "test",
      1000,
      native,
    );
    const closing = expect(client.closeAndObserve()).rejects.toMatchObject({
      code: "backend_cleanup_unconfirmed",
    });
    await vi.advanceTimersByTimeAsync(2001);
    await closing;
    child.emit("close", 0, null);
    await expect(client.closeAndObserve()).rejects.toMatchObject({
      code: "backend_cleanup_unconfirmed",
    });
  });
  it("cannot observe an unowned process through cleanup", async () => {
    const { child } = fixture(false);
    const client = new Client(
      child as unknown as ChildProcessWithoutNullStreams,
    );
    await expect(client.closeAndObserve()).rejects.toMatchObject({
      code: "backend_child_not_owned",
    });
    expect(child.kill).not.toHaveBeenCalled();
    await client.close();
  });
  it("passes exact decimal identities and holds the profile until this child closes", async () => {
    const { native, profile } = fixture();
    const client = await spawnCore(
      "/owned/backend",
      "profile",
      "test",
      1000,
      native,
    );
    expect(spawn).toHaveBeenCalledExactlyOnceWith(
      "/owned/backend",
      [
        "serve",
        "--profile",
        "profile",
        "--profile-root",
        "/private/profile",
        "--profile-device",
        "18446744073709551615",
        "--profile-inode",
        "9007199254740993",
        "--owner",
        "owner",
        "--computer",
        "computer",
        "--home",
        "/Users/owner",
        "--store-mode",
        "open",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    expect(profile.close).not.toHaveBeenCalled();
    await client.close();
    await client.close();
    expect(client.cleanupState).toBe("confirmed");
    expect(profile.close).toHaveBeenCalledTimes(1);
  });
  it("retains the originally selected profile owner through caller mutation", async () => {
    const { native, profile } = fixture();
    const client = await spawnCore(
      "/owned/backend",
      "profile",
      "test",
      1000,
      native,
    );
    const replacement = { beforeSpawn: vi.fn(), close: vi.fn() };
    Object.assign(native, { profile: replacement });
    await client.close();
    expect(profile.close).toHaveBeenCalledTimes(1);
    expect(replacement.close).not.toHaveBeenCalled();
  });
  it("refuses crossed profile before dispatch and releases its qualifier", async () => {
    const { native, profile } = fixture();
    await expect(
      spawnCore("/owned/backend", "other", "test", 1000, native),
    ).rejects.toMatchObject({ code: "profile_binding_mismatch" });
    expect(spawn).not.toHaveBeenCalled();
    expect(profile.close).toHaveBeenCalledTimes(1);
  });
  it("does not spawn after profile revalidation refuses", async () => {
    const { native, profile } = fixture();
    profile.beforeSpawn.mockReturnValue({
      state: "refused",
      code: "PROFILE_CHANGED",
      retry: "never",
    } as never);
    await expect(
      spawnCore("/owned/backend", "profile", "test", 1000, native),
    ).rejects.toMatchObject({ code: "PROFILE_CHANGED" });
    expect(spawn).not.toHaveBeenCalled();
    expect(profile.close).toHaveBeenCalledTimes(1);
  });
  it.each(["invalid identity", "", undefined])(
    "rejects malformed owner %s before profile consumption",
    async (ownerId) => {
      const { native, profile } = fixture();
      await expect(
        spawnCore("/owned/backend", "profile", "test", 1000, {
          ...native,
          ownerId,
        } as NativeCoreLaunch),
      ).rejects.toMatchObject({ code: "invalid_native_launch" });
      expect(spawn).not.toHaveBeenCalled();
      expect(profile.beforeSpawn).not.toHaveBeenCalled();
      expect(profile.close).toHaveBeenCalledTimes(1);
    },
  );
  it("cleans the exact child and profile after known handshake refusal", async () => {
    const { native, profile, handshake } = fixture();
    const original = new Error("handshake refused");
    handshake.mockRejectedValue(original);
    await expect(
      spawnCore("/owned/backend", "profile", "test", 1000, native),
    ).rejects.toBe(original);
    expect(profile.close).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledTimes(1);
  });
  it("keeps the profile retained when child termination is unknown", async () => {
    vi.useFakeTimers();
    const { native, profile } = fixture(false);
    const client = await spawnCore(
      "/owned/backend",
      "profile",
      "test",
      1000,
      native,
    );
    const closing = expect(client.close()).rejects.toMatchObject({
      code: "backend_cleanup_unconfirmed",
    });
    await vi.advanceTimersByTimeAsync(2001);
    await closing;
    expect(client.cleanupState).toBe("unknown");
    expect(profile.close).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(1);
  });
  it("reports descriptor cleanup failure without retrying it", async () => {
    const { native, profile } = fixture();
    profile.close.mockReturnValue({
      state: "unknown",
      code: "PROFILE_CLEANUP_UNKNOWN",
      retry: "never",
    } as never);
    const client = await spawnCore(
      "/owned/backend",
      "profile",
      "test",
      1000,
      native,
    );
    await expect(client.close()).rejects.toMatchObject({
      code: "profile_cleanup_unconfirmed",
    });
    await expect(client.closeAndObserve()).rejects.toMatchObject({
      code: "profile_cleanup_unconfirmed",
    });
    await expect(client.close()).rejects.toMatchObject({
      code: "profile_cleanup_unconfirmed",
    });
    expect(profile.close).toHaveBeenCalledTimes(1);
  });
});
