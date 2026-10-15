import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Client,
  spawnCore,
  type NativeCoreLaunch,
  type BackendLifecycleObservation,
} from "../../apps/desktop/bridge/client.ts";
import { Decoder, frame } from "../../apps/desktop/bridge/frame.ts";

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

describe("inherited Shell startup metadata", () => {
  function setup(pipe: Writable = new PassThrough()) {
    const f = fixture();
    Object.assign(f.child, {
      stdio: [f.child.stdin, f.child.stdout, f.child.stderr, pipe],
    });
    const native: NativeCoreLaunch = {
      ...f.native,
      settingsMutations: true,
      hostLifetimeId: "host-one",
      childLaunchId: "child-one",
      shellMetadata: Buffer.from("synthetic startup metadata"),
    };
    return { ...f, native, pipe };
  }
  it("copies bytes to descriptor 3 once, before the same child handshake", async () => {
    const f = setup();
    const chunks: Buffer[] = [];
    f.pipe.on("data", (bytes: Buffer) => chunks.push(bytes));
    const pending = spawnCore(
      "/owned/backend",
      "profile",
      "test",
      1000,
      f.native,
    );
    f.native.shellMetadata!.fill(0);
    const client = await pending;
    expect(Buffer.concat(chunks).toString()).toBe("synthetic startup metadata");
    expect(vi.mocked(spawn).mock.calls[0]?.[1]).toContain("--shell-support-fd");
    expect(vi.mocked(spawn).mock.calls[0]?.[2]).toEqual({
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    });
    expect(JSON.stringify(vi.mocked(spawn).mock.calls)).not.toContain(
      "synthetic startup metadata",
    );
    expect(f.handshake).toHaveBeenCalledTimes(1);
    expect(f.child.stdin.readableLength).toBe(0);
    expect(() =>
      f.pipe.emit("error", new Error("late private diagnostic")),
    ).not.toThrow();
    await client.close();
    expect(f.profile.close).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledTimes(1);
  });
  it("preserves Shell descriptor 3 with the optional selected-read arguments", async () => {
    const f = setup();
    const client = await spawnCore("/owned/backend", "profile", "test", 1000, {
      ...f.native,
      codexRead: { hostId: "codex", trustedTemp: "/app/tmp" },
    });
    const args = vi.mocked(spawn).mock.calls[0]![1]!;
    expect(args.slice(-6)).toEqual([
      "--codex-read-host",
      "codex",
      "--codex-read-temp",
      "/app/tmp",
      "--shell-support-fd",
      "3",
    ]);
    expect(vi.mocked(spawn).mock.calls[0]![2]).toEqual({
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    });
    await client.close();
  });
  it("rejects missing storage, lifetime or oversized metadata before spawn", async () => {
    for (const override of [
      { settingsMutations: false },
      { hostLifetimeId: undefined, childLaunchId: undefined },
      { shellMetadata: Buffer.alloc(0) },
      { shellMetadata: Buffer.alloc(256 * 1024 + 1) },
    ]) {
      vi.mocked(spawn).mockClear();
      const f = setup();
      const input = { ...f.native, ...override } as NativeCoreLaunch;
      await expect(
        spawnCore("/owned/backend", "profile", "test", 1000, input),
      ).rejects.toMatchObject({ code: "invalid_shell_launch_metadata" });
      expect(spawn).not.toHaveBeenCalled();
      expect(f.profile.close).toHaveBeenCalledTimes(1);
    }
  });
  it("closes only the original child when delivery fails", async () => {
    const pipe = new Writable({
      write(_bytes, _encoding, done) {
        done(new Error("private failure"));
      },
    });
    const f = setup(pipe);
    await expect(
      spawnCore("/owned/backend", "profile", "test", 1000, f.native),
    ).rejects.toMatchObject({ code: "shell_metadata_delivery_failed" });
    expect(f.handshake).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(f.profile.close).toHaveBeenCalledTimes(1);
  });
  it("bounds a stalled write without renewing startup", async () => {
    vi.useFakeTimers();
    const f = setup(
      new Writable({
        write() {
          /* Deliberately never acknowledge. */
        },
      }),
    );
    const rejected = expect(
      spawnCore("/owned/backend", "profile", "test", 100, f.native),
    ).rejects.toMatchObject({ code: "shell_metadata_delivery_failed" });
    await vi.advanceTimersByTimeAsync(101);
    await rejected;
    expect(f.handshake).not.toHaveBeenCalled();
    expect(f.profile.close).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledTimes(1);
  });
  it("subtracts delivery time from the original handshake budget", async () => {
    vi.useFakeTimers();
    const f = setup(
      new Writable({
        write(_bytes, _encoding, done) {
          setTimeout(done, 25);
        },
      }),
    );
    const pending = spawnCore(
      "/owned/backend",
      "profile",
      "test",
      100,
      f.native,
    );
    await vi.advanceTimersByTimeAsync(25);
    const client = await pending;
    expect(f.handshake.mock.calls[0]?.[1]).toBeGreaterThan(0);
    expect(f.handshake.mock.calls[0]?.[1]).toBeLessThanOrEqual(75);
    await client.close();
  });
});

describe("native backend launch binding", () => {
  it("reports spontaneous original backend death immediately with retained phase and safe facts", async () => {
    const { child } = fixture(false);
    const diagnostic = vi.fn();
    const identity = { hostLifetimeId: "host-one", childLaunchId: "child-one" };
    const client = new Client(
      child as unknown as ChildProcessWithoutNullStreams,
      true,
      undefined,
      diagnostic,
      identity,
    );
    const decoder = new Decoder();
    child.stdin.on("data", (bytes: Buffer) =>
      decoder.push(bytes, (request: unknown) => {
        const original = request as { id: string };
        child.stdout.write(
          frame({
            jsonrpc: "2.0",
            id: original.id,
            result: {
              status: "ok",
              requestId: original.id,
              context: { profileId: "profile", backendGeneration: "backend" },
              data: {
                protocolMajor: 1,
                protocolMinor: 0,
                buildId: "build",
                profileId: "profile",
                backendGeneration: "backend",
                capabilities: [],
                maxFrameBytes: 1048576,
              },
            },
          }),
        );
      }),
    );
    vi.mocked(Client.prototype.handshake).mockRestore();
    await client.handshake(
      {
        protocolMajor: 1,
        protocolMinor: 0,
        buildId: "build",
        profileId: "profile",
      },
      1000,
    );
    identity.hostLifetimeId = "mutated-host";
    child.stderr.write("private account transcript secret path");
    child.emit("close", null, "SIGTERM");
    expect(diagnostic.mock.calls[0]?.[0]).toEqual({
      source: "go-backend",
      phase: "active",
      event: "child-close",
      code: "backend_child_closed",
      state: "observed",
      exitCode: null,
      signal: "SIGTERM",
      forced: false,
      hostLifetimeId: "host-one",
      childLaunchId: "child-one",
    });
    expect(client.lifecycleObservations).toHaveLength(2);
    expect(Object.isFrozen(client.lifecycleObservations[0])).toBe(true);
    expect(JSON.stringify(diagnostic.mock.calls)).not.toMatch(
      /private|account|transcript|secret|path|mutated/,
    );
    await client.close();
    expect(child.kill).not.toHaveBeenCalled();
  });
  it("preserves requested-close and cleanup UNKNOWN evidence through late close and throwing sink", async () => {
    vi.useFakeTimers();
    const { child, native } = fixture(false);
    const diagnostic = vi.fn<
      (observation: BackendLifecycleObservation) => void
    >(() => {
      throw new Error("private diagnostic failure");
    });
    const client = await spawnCore("/owned/backend", "profile", "test", 1000, {
      ...native,
      hostLifetimeId: "host-one",
      childLaunchId: "child-one",
      onLifecycleObservation: diagnostic,
    });
    const closing = expect(client.closeAndObserve()).rejects.toMatchObject({
      code: "backend_cleanup_unconfirmed",
    });
    await vi.advanceTimersByTimeAsync(2001);
    await closing;
    expect(
      diagnostic.mock.calls.map(([value]) => [
        value.phase,
        value.event,
        value.code,
      ]),
    ).toEqual([
      ["closing", "failure", "client_closed"],
      ["closing", "cleanup-unknown", "backend_cleanup_unconfirmed"],
    ]);
    child.emit("close", 0, null);
    expect(diagnostic.mock.calls[2]?.[0]).toMatchObject({
      phase: "closing",
      event: "child-close",
      exitCode: 0,
      signal: null,
      forced: true,
    });
    await expect(client.closeAndObserve()).rejects.toMatchObject({
      code: "backend_cleanup_unconfirmed",
    });
    expect(diagnostic).toHaveBeenCalledTimes(3);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
  });
  it("retains startup failure and sanitizes malformed terminal diagnostic facts", async () => {
    const { child } = fixture(false);
    const diagnostic = vi.fn();
    const client = new Client(
      child as unknown as ChildProcessWithoutNullStreams,
      true,
      undefined,
      diagnostic,
    );
    child.emit("error", new Error("private credential content"));
    expect(diagnostic.mock.calls[0]?.[0]).toMatchObject({
      phase: "startup",
      event: "failure",
      code: "backend_unavailable",
      state: "outcome_unknown",
    });
    child.emit("close", Number.NaN, "private signal content");
    expect(diagnostic.mock.calls[1]?.[0]).toMatchObject({
      phase: "startup",
      event: "child-close",
      state: "outcome_unknown",
      exitCode: null,
      signal: null,
    });
    expect(JSON.stringify(diagnostic.mock.calls)).not.toMatch(
      /private|credential/,
    );
    await client.close();
    expect(child.kill).not.toHaveBeenCalled();
  });
  it("isolates rejected async lifecycle diagnostics from original backend closure", async () => {
    const { child } = fixture(false);
    const diagnostic = vi.fn(async () => {
      throw new Error("private async diagnostic failure");
    });
    const client = new Client(
      child as unknown as ChildProcessWithoutNullStreams,
      true,
      undefined,
      diagnostic,
    );
    child.emit("close", 17, null);
    await client.close();
    await Promise.resolve();
    expect(diagnostic).toHaveBeenCalledTimes(2);
    expect(client.lifecycleObservations[0]).toMatchObject({
      phase: "startup",
      event: "child-close",
      exitCode: 17,
      signal: null,
    });
    expect(child.kill).not.toHaveBeenCalled();
  });
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

it.each([true, false, undefined])(
  "maps only explicit mutation storage selection %s",
  async (settingsMutations) => {
    const { native } = fixture();
    const client = await spawnCore("/owned/backend", "profile", "test", 1000, {
      ...native,
      ...(settingsMutations === undefined ? {} : { settingsMutations }),
    });
    const args = vi.mocked(spawn).mock.calls[0]![1] as readonly string[];
    expect(args.includes("--settings-mutations")).toBe(
      settingsMutations === true,
    );
    await client.close();
  },
);

it("refuses malformed mutation storage selection before spawning", async () => {
  const { native } = fixture();
  await expect(
    spawnCore("/owned/backend", "profile", "test", 1000, {
      ...native,
      settingsMutations: "true" as unknown as boolean,
    }),
  ).rejects.toMatchObject({ code: "invalid_native_launch" });
  expect(spawn).not.toHaveBeenCalled();
});

describe("optional trusted Codex read launch", () => {
  it.each([undefined, { hostId: "codex" as const, trustedTemp: "/app/tmp" }])(
    "maps only the explicit pair %j without another pipe",
    async (codexRead) => {
      const f = fixture();
      const client = await spawnCore(
        "/owned/backend",
        "profile",
        "test",
        1000,
        {
          ...f.native,
          ...(codexRead ? { codexRead } : {}),
        },
      );
      const args = vi.mocked(spawn).mock.calls[0]![1]!;
      expect(args.includes("--codex-read-host")).toBe(codexRead !== undefined);
      expect(args.includes("--codex-read-temp")).toBe(codexRead !== undefined);
      if (codexRead)
        expect(args.slice(-4)).toEqual([
          "--codex-read-host",
          "codex",
          "--codex-read-temp",
          "/app/tmp",
        ]);
      expect(vi.mocked(spawn).mock.calls[0]![2]).toEqual({
        stdio: ["pipe", "pipe", "pipe"],
      });
      await client.close();
    },
  );

  it.each([
    null,
    true,
    {},
    { hostId: "other", trustedTemp: "/app/tmp" },
    { hostId: "codex" },
    { hostId: "codex", trustedTemp: 7 },
    { hostId: "codex", trustedTemp: "/app/tmp", threadId: "other" },
    { hostId: "codex", trustedTemp: "/app/tmp", [Symbol("extra")]: true },
  ])(
    "refuses malformed adapter input before spawning: %j",
    async (codexRead) => {
      const f = fixture();
      await expect(
        spawnCore("/owned/backend", "profile", "test", 1000, {
          ...f.native,
          codexRead,
        } as NativeCoreLaunch),
      ).rejects.toMatchObject({ code: "invalid_codex_read_launch" });
      expect(spawn).not.toHaveBeenCalled();
      expect(f.profile.beforeSpawn).not.toHaveBeenCalled();
      expect(f.profile.close).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["selection", "hostId", "trustedTemp"])(
    "refuses %s accessors without invoking them",
    async (field) => {
      const f = fixture();
      const get = vi.fn(() => {
        throw new Error("Accessor must remain uncalled");
      });
      const codexRead = { hostId: "codex", trustedTemp: "/app/tmp" };
      const native = { ...f.native, codexRead };
      Object.defineProperty(
        field === "selection" ? native : codexRead,
        field === "selection" ? "codexRead" : field,
        { get },
      );
      await expect(
        spawnCore(
          "/owned/backend",
          "profile",
          "test",
          1000,
          native as NativeCoreLaunch,
        ),
      ).rejects.toMatchObject({ code: "invalid_codex_read_launch" });
      expect(get).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
    },
  );

  it("keeps Go path validation on the backend boundary", async () => {
    const f = fixture();
    const client = await spawnCore("/owned/backend", "profile", "test", 1000, {
      ...f.native,
      codexRead: { hostId: "codex", trustedTemp: "relative" },
    });
    expect(vi.mocked(spawn).mock.calls[0]![1]!.slice(-2)).toEqual([
      "--codex-read-temp",
      "relative",
    ]);
    await client.close();
  });
});
