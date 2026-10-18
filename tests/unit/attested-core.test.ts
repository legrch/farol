import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import {
  AttestedCore,
  parseCoreArtifactDeclaration,
  type CoreArtifactDeclaration,
  type CoreBuildBinding,
  type TrustedCoreExpectation,
} from "../../apps/desktop/bridge/attested-core.ts";
import {
  BridgeError,
  spawnCore,
  type Client,
} from "../../apps/desktop/bridge/client.ts";

import { recordTerminal } from "../../apps/desktop/bridge/terminal-recorder.ts";
vi.mock("../../apps/desktop/bridge/terminal-recorder.ts", () => ({
  recordTerminal: vi.fn(),
}));

vi.mock("../../apps/desktop/bridge/client.ts", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../apps/desktop/bridge/client.ts")
  >()),
  spawnCore: vi.fn(),
}));

// Source-only evidence. These disposable files contain synthetic native headers,
// not Go programs. spawnCore is always mocked; no child, provider, GUI, handshake
// or real cleanup is exercised. Fixture pins describe known constructed bytes;
// production callers must obtain pins from an independently accepted declaration.
const goos = process.platform === "win32" ? "windows" : process.platform;
const goarch = process.arch === "x64" ? "amd64" : process.arch;
if (
  (goos !== "darwin" && goos !== "linux" && goos !== "windows") ||
  (goarch !== "arm64" && goarch !== "amd64")
)
  throw new Error("Unsupported fixture host");
const platform: CoreBuildBinding["platform"] = { goos, goarch };
function nativeBytes(length = 128): Buffer {
  const bytes = Buffer.alloc(length);
  const arm64 = platform.goarch === "arm64";
  if (platform.goos === "darwin") {
    bytes.writeUInt32LE(0xfeedfacf, 0);
    bytes.writeUInt32LE(arm64 ? 0x0100000c : 0x01000007, 4);
    bytes.writeUInt32LE(2, 12);
  } else if (platform.goos === "linux") {
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]).copy(bytes);
    bytes.writeUInt16LE(2, 16);
    bytes.writeUInt16LE(arm64 ? 183 : 62, 18);
    bytes.writeUInt32LE(1, 20);
  } else {
    bytes.writeUInt16LE(0x5a4d, 0);
    bytes.writeUInt32LE(64, 60);
    bytes.writeUInt32LE(0x00004550, 64);
    bytes.writeUInt16LE(arm64 ? 0xaa64 : 0x8664, 68);
    bytes.writeUInt16LE(2, 86);
    bytes.writeUInt16LE(0x020b, 88);
  }
  return bytes;
}
function declaration(bytes: Buffer): CoreArtifactDeclaration {
  return {
    schema: "farol-core-artifact/1",
    build: {
      buildId: "accepted-build",
      sourceSHA: "acb131d9e7d483296d4edac262cf881cddfb91bb",
      sourceTreeDigest: "1".repeat(64),
      platform: { ...platform },
    },
    binary: {
      path: "bin/farol-core",
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  };
}
const mockSpawn = vi.mocked(spawnCore);
let root: string;
let executable: string;
let artifact: CoreArtifactDeclaration;
let expected: TrustedCoreExpectation;
let close: ReturnType<typeof vi.fn>;
let client: Client;
beforeEach(() => {
  vi.mocked(recordTerminal).mockReset().mockResolvedValue();
  root = fs.realpathSync(
    fs.mkdtempSync(join(tmpdir(), "farol-attested-core-")),
  );
  executable = join(root, "bin", "farol-core");
  fs.mkdirSync(dirname(executable));
  const bytes = nativeBytes();
  fs.writeFileSync(executable, bytes, { mode: 0o755 });
  artifact = declaration(bytes);
  expected = {
    artifactRoot: root,
    build: structuredClone(artifact.build),
    binary: { ...artifact.binary },
    profileId: "disposable-profile",
  };
  close = vi.fn().mockResolvedValue(undefined);
  client = { close, cleanupState: "none" } as unknown as Client;
  mockSpawn.mockReset().mockResolvedValue(client);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});
async function refused(core: AttestedCore, code: string): Promise<void> {
  const result = core.start();
  await expect(result).rejects.toBeInstanceOf(BridgeError);
  await expect(result).rejects.toMatchObject({ state: "refused", code });
  expect(mockSpawn).not.toHaveBeenCalled();
}
function replaceFixture(bytes: Buffer): void {
  fs.writeFileSync(executable, bytes);
  artifact = declaration(bytes);
  expected = { ...expected, binary: { ...artifact.binary } };
}

describe("closed consumed artifact declaration", () => {
  it("copies and freezes all admitted fields without creating trust", () => {
    const parsed = parseCoreArtifactDeclaration(artifact);
    expect(parsed).toEqual(artifact);
    expect(parsed).not.toBe(artifact);
    for (const value of [
      parsed,
      parsed.build,
      parsed.build.platform,
      parsed.binary,
    ])
      expect(Object.isFrozen(value)).toBe(true);
  });
  it.each([
    null,
    true,
    1,
    "{}",
    [],
    {},
    { ...declaration(nativeBytes()), schema: 2 },
  ])("refuses a non-declaration: %j", (value) => {
    expect(() => parseCoreArtifactDeclaration(value)).toThrow(
      "invalid_core_artifact",
    );
  });
  it.each([
    ["top-level executable redirect", { executable: "/outside/farol" }],
    ["launch arguments", { args: ["serve"] }],
    ["environment redirect", { env: { PATH: "/outside" } }],
    ["operation authority", { grants: ["computer"] }],
    ["profile from artifact", { profileId: "other" }],
  ])("rejects %s instead of consuming it", (_name, extra) => {
    expect(() =>
      parseCoreArtifactDeclaration({ ...artifact, ...extra }),
    ).toThrow("invalid_core_artifact");
  });
  it("rejects fields that try to move outer build authority into binary metadata", () => {
    expect(() =>
      parseCoreArtifactDeclaration({
        ...artifact,
        binary: { ...artifact.binary, sourceSHA: artifact.build.sourceSHA },
      }),
    ).toThrow("invalid_core_artifact");
    expect(() =>
      parseCoreArtifactDeclaration({
        ...artifact,
        build: { ...artifact.build, dirty: false },
      }),
    ).toThrow("invalid_core_artifact");
    expect(() =>
      parseCoreArtifactDeclaration({
        ...artifact,
        build: { ...artifact.build, platform: { ...platform, host: "any" } },
      }),
    ).toThrow("invalid_core_artifact");
  });
  it("rejects accessor, inherited, hidden and symbolic fields without invoking getters", () => {
    const getter = vi.fn(() => artifact.build);
    const accessor = { ...artifact };
    Object.defineProperty(accessor, "build", { enumerable: true, get: getter });
    const hidden = { ...artifact };
    Object.defineProperty(hidden, "schema", { enumerable: false });
    const inherited: unknown = Object.create(artifact);
    for (const value of [
      accessor,
      hidden,
      inherited,
      { ...artifact, [Symbol("extra")]: 1 },
    ])
      expect(() => parseCoreArtifactDeclaration(value)).toThrow(
        "invalid_core_artifact",
      );
    expect(getter).not.toHaveBeenCalled();
  });
  it("classifies throwing proxy traps as invalid data", () => {
    const proxy = new Proxy(artifact, {
      ownKeys: () => {
        throw new Error("fixture trap");
      },
    });
    expect(() => parseCoreArtifactDeclaration(proxy)).toThrow(
      "invalid_core_artifact",
    );
  });
  it("preserves an existing bridge error thrown by a declaration trap", () => {
    const failure = new BridgeError("unknown", "fixture_declaration_trap");
    const proxy = new Proxy(artifact, {
      ownKeys() {
        throw failure;
      },
    });
    try {
      parseCoreArtifactDeclaration(proxy);
      expect.unreachable("Expected the original trap error");
    } catch (error) {
      expect(error).toBe(failure);
    }
  });
  it.each([
    "../farol",
    "bin/../farol",
    "/bin/farol",
    "bin//farol",
    "bin/./farol",
    "bin/",
    "bin\\farol",
    "bin/farol --serve",
    "file:///bin/farol",
    "C:/farol",
  ])("refuses non-canonical binary input %s", (path) => {
    expect(() =>
      parseCoreArtifactDeclaration({
        ...artifact,
        binary: { ...artifact.binary, path },
      }),
    ).toThrow("invalid_core_artifact");
  });
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "128"])(
    "refuses invalid binary size %s",
    (size) => {
      expect(() =>
        parseCoreArtifactDeclaration({
          ...artifact,
          binary: { ...artifact.binary, size },
        }),
      ).toThrow("invalid_core_artifact");
    },
  );
  it.each([
    { ...declaration(nativeBytes()).build, sourceSHA: "not-a-commit" },
    { ...declaration(nativeBytes()).build, sourceTreeDigest: "1".repeat(40) },
    { ...declaration(nativeBytes()).build, buildId: "" },
    {
      ...declaration(nativeBytes()).build,
      platform: { goos: "freebsd", goarch: "arm64" },
    },
    {
      ...declaration(nativeBytes()).build,
      platform: { goos: "darwin", goarch: "x64" },
    },
  ])("refuses malformed build binding %j", (build) => {
    expect(() => parseCoreArtifactDeclaration({ ...artifact, build })).toThrow(
      "invalid_core_artifact",
    );
  });
  it("refuses malformed binary digest", () => {
    expect(() =>
      parseCoreArtifactDeclaration({
        ...artifact,
        binary: { ...artifact.binary, sha256: "A".repeat(64) },
      }),
    ).toThrow("invalid_core_artifact");
  });
});

describe("independently pinned host binding", () => {
  it.each([
    ["buildId", "other-build"],
    ["sourceSHA", "2".repeat(40)],
    ["sourceTreeDigest", "2".repeat(64)],
  ])("refuses a different %s before file access", async (key, value) => {
    const open = vi.spyOn(fs, "openSync");
    await refused(
      new AttestedCore(
        { ...artifact, build: { ...artifact.build, [key]: value } },
        expected,
      ),
      "core_artifact_binding_mismatch",
    );
    expect(open).not.toHaveBeenCalled();
  });
  it.each([
    {
      goos: platform.goos === "darwin" ? "linux" : "darwin",
      goarch: platform.goarch,
    },
    {
      goos: platform.goos,
      goarch: platform.goarch === "arm64" ? "amd64" : "arm64",
    },
  ])("refuses a different declared platform %j", async (different) => {
    await refused(
      new AttestedCore(
        { ...artifact, build: { ...artifact.build, platform: different } },
        expected,
      ),
      "core_artifact_binding_mismatch",
    );
  });
  it("also checks pinned platform compatibility with the host, without inferring acceptance", async () => {
    const different: CoreBuildBinding = {
      ...expected.build,
      platform: {
        ...platform,
        goarch: platform.goarch === "arm64" ? "amd64" : "arm64",
      },
    };
    await refused(
      new AttestedCore(
        { ...artifact, build: different },
        { ...expected, build: different },
      ),
      "core_artifact_platform_mismatch",
    );
  });
  it.each([
    ["path", "bin/other"],
    ["size", 1],
    ["sha256", "2".repeat(64)],
  ])("refuses artifact-controlled binary %s", async (key, value) => {
    await refused(
      new AttestedCore(
        { ...artifact, binary: { ...artifact.binary, [key]: value } },
        expected,
      ),
      "core_artifact_binding_mismatch",
    );
  });
  it.each([
    "relative",
    "/tmp/../outside",
    "/tmp/",
    parse(process.cwd()).root,
    "\0",
  ])("refuses untrusted root spelling %j", async (artifactRoot) => {
    await refused(
      new AttestedCore(artifact, { ...expected, artifactRoot }),
      "invalid_core_expectation",
    );
  });
  it.each(["", "bad profile", "x".repeat(129), null])(
    "refuses invalid profile %j before spawn",
    async (profileId) => {
      await refused(
        new AttestedCore(artifact, {
          ...expected,
          profileId,
        } as unknown as TrustedCoreExpectation),
        "invalid_core_expectation",
      );
    },
  );
  it("validates the profile before inspecting the expected binary", async () => {
    const inspect = vi.fn(() => {
      throw new BridgeError("unknown", "fixture_binary_trap");
    });
    await refused(
      new AttestedCore(artifact, {
        ...expected,
        profileId: "bad profile",
        binary: new Proxy(expected.binary, { getPrototypeOf: inspect }),
      }),
      "invalid_core_expectation",
    );
    expect(inspect).not.toHaveBeenCalled();
  });
  it("runtime-parses expectations and rejects a launch override", async () => {
    await refused(
      new AttestedCore(artifact, {
        ...expected,
        executable,
      } as TrustedCoreExpectation),
      "invalid_core_expectation",
    );
  });
});

describe("disposable file verification before mocked spawn", () => {
  it("hands the exact verified path/build/profile/deadline to spawnCore and returns its Client", async () => {
    const read = vi.spyOn(fs, "readSync");
    mockSpawn.mockImplementationOnce(async (path) => {
      expect(read).toHaveBeenCalled();
      expect(path).toBe(executable);
      return client;
    });
    expect(await new AttestedCore(artifact, expected).start(1234)).toBe(client);
    expect(mockSpawn).toHaveBeenCalledExactlyOnceWith(
      executable,
      "disposable-profile",
      "accepted-build",
      1234,
    );
    expect(close).not.toHaveBeenCalled();
  });
  it("hashes the full file across more than one buffer", async () => {
    const bytes = nativeBytes(65536 + 37);
    bytes[65536] = 42;
    replaceFixture(bytes);
    expect(await new AttestedCore(artifact, expected).start()).toBe(client);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });
  it("handles simulated short reads without treating a partial header as executable text", async () => {
    const read = fs.readSync;
    vi.spyOn(fs, "readSync").mockImplementation((fd, buffer, options) =>
      read(fd, buffer, {
        ...options,
        length: Math.min(options?.length ?? buffer.byteLength, 7),
      }),
    );
    expect(await new AttestedCore(artifact, expected).start()).toBe(client);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });
  it("refuses simulated premature EOF and closes the descriptor", async () => {
    const closed = vi.spyOn(fs, "closeSync");
    vi.spyOn(fs, "readSync").mockReturnValueOnce(0);
    await refused(
      new AttestedCore(artifact, expected),
      "core_artifact_size_mismatch",
    );
    expect(closed).toHaveBeenCalledTimes(1);
  });
  it("refuses a digest mismatch despite unchanged size and executable header", async () => {
    const bytes = nativeBytes();
    bytes[127] = 42;
    fs.writeFileSync(executable, bytes);
    await refused(
      new AttestedCore(artifact, expected),
      "core_artifact_digest_mismatch",
    );
  });
  it("refuses a size mismatch before opening bytes", async () => {
    fs.appendFileSync(executable, Buffer.from([42]));
    const open = vi.spyOn(fs, "openSync");
    await refused(
      new AttestedCore(artifact, expected),
      "core_artifact_size_mismatch",
    );
    expect(open).not.toHaveBeenCalled();
  });
  it("refuses a missing file without discovery or another input", async () => {
    fs.unlinkSync(executable);
    await refused(
      new AttestedCore(artifact, expected),
      "core_artifact_unreadable",
    );
  });
  it("refuses a directory in the executable slot", async () => {
    fs.unlinkSync(executable);
    fs.mkdirSync(executable);
    await refused(
      new AttestedCore(artifact, expected),
      "core_artifact_not_owned_file",
    );
  });
  it.skipIf(process.platform === "win32")(
    "refuses a non-executable regular file",
    async () => {
      fs.chmodSync(executable, 0o644);
      await refused(
        new AttestedCore(artifact, expected),
        "core_artifact_not_executable",
      );
    },
  );
  it.each(["#!/bin/sh\necho redirect\n", "echo implicit-shell-redirect\n"])(
    "refuses executable text with matching pins: %s",
    async (text) => {
      replaceFixture(Buffer.from(text.padEnd(128, " ")));
      await refused(
        new AttestedCore(artifact, expected),
        "core_artifact_not_native_executable",
      );
    },
  );
  it("refuses a native header for another architecture even with matching byte pins", async () => {
    const bytes = nativeBytes();
    if (platform.goos === "darwin") bytes.writeUInt32LE(0, 4);
    else if (platform.goos === "linux") bytes.writeUInt16LE(0, 18);
    else bytes.writeUInt16LE(0, 68);
    replaceFixture(bytes);
    await refused(
      new AttestedCore(artifact, expected),
      "core_artifact_not_native_executable",
    );
  });
  it("refuses a tiny pinned file", async () => {
    replaceFixture(Buffer.from([1, 2, 3]));
    await refused(
      new AttestedCore(artifact, expected),
      "core_artifact_not_native_executable",
    );
  });
  it("refuses a symlink executable even when its target bytes have the right digest", async () => {
    const target = join(root, "target");
    fs.renameSync(executable, target);
    fs.symlinkSync(target, executable);
    await refused(
      new AttestedCore(artifact, expected),
      "core_artifact_not_owned_file",
    );
  });
  it("refuses a symlink binary directory", async () => {
    const target = join(root, "target");
    fs.renameSync(dirname(executable), target);
    fs.symlinkSync(target, dirname(executable), "dir");
    await refused(
      new AttestedCore(artifact, expected),
      "core_artifact_path_redirected",
    );
  });
  it("refuses a symlink trusted root without normalizing it into authority", async () => {
    const alias = join(root, "alias");
    fs.symlinkSync(root, alias, "dir");
    await refused(
      new AttestedCore(artifact, { ...expected, artifactRoot: alias }),
      "core_artifact_path_redirected",
    );
  });
  it("refuses a symlink in an ancestor of the trusted root", async () => {
    const container = join(root, "container");
    const target = join(container, "artifact");
    fs.mkdirSync(join(target, "bin"), { recursive: true });
    fs.copyFileSync(executable, join(target, "bin", "farol-core"));
    const alias = join(root, "alias");
    fs.symlinkSync(container, alias, "dir");
    await refused(
      new AttestedCore(artifact, {
        ...expected,
        artifactRoot: join(alias, "artifact"),
      }),
      "core_artifact_path_redirected",
    );
  });
  it("refuses a hard-linked binary alias", async () => {
    fs.linkSync(executable, join(root, "other-input"));
    await refused(
      new AttestedCore(artifact, expected),
      "core_artifact_not_owned_file",
    );
  });
  it("detects a simulated metadata change while reading and closes its descriptor", async () => {
    const read = fs.readSync;
    const closed = vi.spyOn(fs, "closeSync");
    vi.spyOn(fs, "readSync").mockImplementationOnce((fd, buffer, options) => {
      const count = read(fd, buffer, options);
      fs.chmodSync(executable, 0o700);
      return count;
    });
    await refused(
      new AttestedCore(artifact, expected),
      "core_artifact_changed",
    );
    expect(closed).toHaveBeenCalledTimes(1);
  });
  it("detects a simulated replacement of the path by identical bytes", async () => {
    const read = fs.readSync;
    vi.spyOn(fs, "readSync").mockImplementationOnce((fd, buffer, options) => {
      const count = read(fd, buffer, options);
      fs.renameSync(executable, join(root, "previous"));
      fs.writeFileSync(executable, nativeBytes(), { mode: 0o755 });
      return count;
    });
    await refused(
      new AttestedCore(artifact, expected),
      "core_artifact_changed",
    );
  });
  it("detects a simulated directory redirect after reading started", async () => {
    const read = fs.readSync;
    vi.spyOn(fs, "readSync").mockImplementationOnce((fd, buffer, options) => {
      const count = read(fd, buffer, options);
      const target = join(root, "renamed-bin");
      fs.renameSync(dirname(executable), target);
      fs.symlinkSync(target, dirname(executable), "dir");
      return count;
    });
    await refused(
      new AttestedCore(artifact, expected),
      "core_artifact_path_redirected",
    );
  });
  it("classifies a simulated read failure, closes the descriptor and never spawns", async () => {
    const closed = vi.spyOn(fs, "closeSync");
    vi.spyOn(fs, "readSync").mockImplementationOnce(() => {
      throw new Error("fixture read error");
    });
    await refused(
      new AttestedCore(artifact, expected),
      "core_artifact_unreadable",
    );
    expect(closed).toHaveBeenCalledTimes(1);
  });
});

describe("one-shot Child delegation", () => {
  it("consumes the lifetime before a pending first spawn resolves", async () => {
    let release: ((value: Client) => void) | undefined;
    mockSpawn.mockImplementationOnce(
      () =>
        new Promise<Client>((resolve) => {
          release = resolve;
        }),
    );
    const core = new AttestedCore(artifact, expected);
    const pending = core.start();
    await expect(core.start()).rejects.toMatchObject({
      state: "refused",
      code: "core_start_consumed",
    });
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    release?.(client);
    await expect(pending).resolves.toBe(client);
  });
  it("never starts again after the returned Client is closed", async () => {
    const core = new AttestedCore(artifact, expected);
    await (await core.start()).close();
    await expect(core.start()).rejects.toMatchObject({
      state: "refused",
      code: "core_start_consumed",
    });
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
  it("consumes even a validation refusal without allowing repaired input to restart", async () => {
    const invalid = { ...artifact, schema: "wrong" };
    const core = new AttestedCore(invalid, expected);
    await refused(core, "invalid_core_artifact");
    invalid.schema = artifact.schema;
    await expect(core.start()).rejects.toMatchObject({
      code: "core_start_consumed",
    });
    expect(mockSpawn).not.toHaveBeenCalled();
  });
  it.each([0, -1, NaN, Infinity, 30001])(
    "refuses invalid deadline %s before spawn and consumes admission",
    async (timeoutMs) => {
      const core = new AttestedCore(artifact, expected);
      await expect(core.start(timeoutMs)).rejects.toMatchObject({
        state: "refused",
        code: "invalid_deadline",
      });
      await expect(core.start()).rejects.toMatchObject({
        code: "core_start_consumed",
      });
      expect(mockSpawn).not.toHaveBeenCalled();
    },
  );
  it.each([
    new BridgeError("refused", "wrong_backend_identity"),
    new BridgeError("unavailable", "backend_unavailable"),
    new BridgeError("unknown", "response_timeout"),
    new BridgeError("unknown", "backend_cleanup_unconfirmed"),
  ])(
    "preserves spawnCore error identity %s without cleanup, restart or fallback",
    async (error) => {
      mockSpawn.mockRejectedValueOnce(error);
      const core = new AttestedCore(artifact, expected);
      await expect(core.start()).rejects.toBe(error);
      await expect(core.start()).rejects.toMatchObject({
        code: "core_start_consumed",
      });
      expect(mockSpawn).toHaveBeenCalledTimes(1);
      expect(close).not.toHaveBeenCalled();
    },
  );
  it("leaves a returned Client cleanup-unknown error untouched and cannot restart", async () => {
    const error = new BridgeError("unknown", "backend_cleanup_unconfirmed");
    close.mockRejectedValueOnce(error);
    const core = new AttestedCore(artifact, expected);
    const result = await core.start();
    await expect(result.close()).rejects.toBe(error);
    await expect(core.start()).rejects.toMatchObject({
      code: "core_start_consumed",
    });
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe("retirement recorder attestation", () => {
  const ack = {
    handoffId: "retirement",
    receiptDigest: "d".repeat(64),
    ackDigest: "a".repeat(64),
  };
  async function started() {
    const profile = {
      beforeSpawn: vi.fn(() => ({
        state: "qualified" as const,
        binding: {
          profileId: expected.profileId,
          root: "/synthetic/profile",
          home: "/synthetic/home",
          device: "1",
          inode: "2",
        },
      })),
      close: vi.fn(() => ({ state: "closed" as const })),
    };
    const observe = vi
      .fn()
      .mockResolvedValue({ exitCode: 0, signal: null, forced: false });
    Object.assign(client, {
      verifiedContext: {
        profileId: expected.profileId,
        backendGeneration: "generation-1",
      },
      closeAndObserve: observe,
    });
    mockSpawn.mockImplementationOnce(
      async (_path, _profile, _build, _timeout, native) => {
        native!.profile.beforeSpawn();
        return client;
      },
    );
    const core = new AttestedCore(artifact, expected);
    await core.start(1000, {
      profile,
      ownerId: "owner",
      computerId: "computer",
      storeMode: "create",
      hostLifetimeId: "host-1",
      childLaunchId: "child-1",
    });
    return { core, profile, observe };
  }
  it("retains original context and profile without another qualification", async () => {
    const f = await started();
    await f.core.completeRetirement(ack);
    await f.core.completeRetirement(ack);
    expect(f.observe).toHaveBeenCalledTimes(1);
    expect(f.profile.beforeSpawn).toHaveBeenCalledTimes(1);
    expect(recordTerminal).toHaveBeenCalledExactlyOnceWith(
      executable,
      {
        profileId: expected.profileId,
        root: "/synthetic/profile",
        home: "/synthetic/home",
        device: "1",
        inode: "2",
      },
      {
        ...ack,
        backendGeneration: "generation-1",
        hostLifetimeId: "host-1",
        childLaunchId: "child-1",
        exitCode: "0",
        signal: "",
        forced: false,
      },
      ack,
    );
  });
  it("re-attests bytes after exact child close and refuses changed executable", async () => {
    const f = await started();
    f.observe.mockImplementation(async () => {
      const bytes = nativeBytes();
      bytes[127] = 43;
      fs.writeFileSync(executable, bytes);
      return { exitCode: 0, signal: null, forced: false };
    });
    await expect(f.core.completeRetirement(ack)).rejects.toMatchObject({
      code: "core_artifact_digest_mismatch",
    });
    await expect(f.core.completeRetirement(ack)).rejects.toMatchObject({
      code: "core_artifact_digest_mismatch",
    });
    expect(f.observe).toHaveBeenCalledTimes(1);
    expect(recordTerminal).not.toHaveBeenCalled();
  });
  it("does not launch recorder after unknown original child cleanup", async () => {
    const f = await started();
    const failure = new BridgeError("unknown", "cleanup_lost");
    f.observe.mockRejectedValue(failure);
    await expect(f.core.completeRetirement(ack)).rejects.toBe(failure);
    expect(recordTerminal).not.toHaveBeenCalled();
  });
});
