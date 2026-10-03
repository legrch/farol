import { createHash } from "node:crypto";
import fs, { type BigIntStats } from "node:fs";
import { isAbsolute, join, parse, resolve, sep } from "node:path";
import {
  BridgeError,
  spawnCore,
  type Client,
  type NativeCoreLaunch,
} from "./client.ts";
import { protocolMajor, protocolMinor, validate } from "./wire.ts";

export interface CoreBuildBinding {
  readonly buildId: string;
  readonly sourceSHA: string;
  readonly sourceTreeDigest: string;
  readonly platform: Readonly<{
    goos: "darwin" | "linux" | "windows";
    goarch: "arm64" | "amd64";
  }>;
}
export interface CoreBinaryBinding {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}
export interface CoreArtifactDeclaration {
  readonly schema: "farol-core-artifact/1";
  readonly build: CoreBuildBinding;
  readonly binary: CoreBinaryBinding;
}
export interface TrustedCoreExpectation {
  readonly artifactRoot: string;
  readonly build: CoreBuildBinding;
  readonly binary: CoreBinaryBinding;
  readonly profileId: string;
}

function refuse(code: string): never {
  throw new BridgeError("refused", code);
}
function record(
  value: unknown,
  keys: readonly string[],
  code: string,
): Record<string, unknown> {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return refuse(code);
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      return refuse(code);
    const own = Reflect.ownKeys(value);
    if (
      own.length !== keys.length ||
      own.some((key) => !keys.includes(String(key)))
    )
      return refuse(code);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor))
        return refuse(code);
      result[key] = descriptor.value as unknown;
    }
    return result;
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    return refuse(code);
  }
}
function text(value: unknown, pattern: RegExp, code: string): string {
  if (typeof value !== "string" || !pattern.test(value)) return refuse(code);
  return value;
}
function buildBinding(value: unknown, code: string): CoreBuildBinding {
  const build = record(
    value,
    ["buildId", "sourceSHA", "sourceTreeDigest", "platform"],
    code,
  );
  const platform = record(build.platform, ["goos", "goarch"], code);
  if (
    (platform.goos !== "darwin" &&
      platform.goos !== "linux" &&
      platform.goos !== "windows") ||
    (platform.goarch !== "arm64" && platform.goarch !== "amd64")
  )
    return refuse(code);
  return Object.freeze({
    buildId: text(build.buildId, /^[A-Za-z0-9._:/-]{1,128}$/u, code),
    sourceSHA: text(build.sourceSHA, /^[a-f0-9]{40}$/u, code),
    sourceTreeDigest: text(build.sourceTreeDigest, /^[a-f0-9]{64}$/u, code),
    platform: Object.freeze({ goos: platform.goos, goarch: platform.goarch }),
  });
}
function binaryBinding(value: unknown, code: string): CoreBinaryBinding {
  const binary = record(value, ["path", "size", "sha256"], code);
  const path = text(binary.path, /^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/u, code);
  if (
    path.split("/").some((part) => !part || part === "." || part === "..") ||
    typeof binary.size !== "number" ||
    !Number.isSafeInteger(binary.size) ||
    binary.size <= 0
  )
    return refuse(code);
  return Object.freeze({
    path,
    size: binary.size,
    sha256: text(binary.sha256, /^[a-f0-9]{64}$/u, code),
  });
}

// This is a consumed projection, not a new build manifest or trust producer.
// Lead maps its accepted outer build declaration to build + binary, then pins
// both independently in TrustedCoreExpectation. Never pin a digest observed from
// the executable under inspection. sourceSHA/tree/platform do not come from wire.
export function parseCoreArtifactDeclaration(
  value: unknown,
): CoreArtifactDeclaration {
  const code = "invalid_core_artifact";
  const artifact = record(value, ["schema", "build", "binary"], code);
  if (artifact.schema !== "farol-core-artifact/1") return refuse(code);
  return Object.freeze({
    schema: artifact.schema,
    build: buildBinding(artifact.build, code),
    binary: binaryBinding(artifact.binary, code),
  });
}
function expectation(value: unknown): TrustedCoreExpectation {
  const code = "invalid_core_expectation";
  const expected = record(
    value,
    ["artifactRoot", "build", "binary", "profileId"],
    code,
  );
  if (
    typeof expected.artifactRoot !== "string" ||
    expected.artifactRoot.includes("\0") ||
    !isAbsolute(expected.artifactRoot) ||
    resolve(expected.artifactRoot) !== expected.artifactRoot ||
    parse(expected.artifactRoot).root === expected.artifactRoot
  )
    return refuse(code);
  const build = buildBinding(expected.build, code);
  if (
    !validate("Handshake", {
      protocolMajor,
      protocolMinor,
      buildId: build.buildId,
      profileId: expected.profileId,
    })
  )
    return refuse(code);
  return Object.freeze({
    artifactRoot: expected.artifactRoot,
    build,
    binary: binaryBinding(expected.binary, code),
    profileId: expected.profileId as string,
  });
}
function bind(
  artifact: CoreArtifactDeclaration,
  expected: TrustedCoreExpectation,
): void {
  const { build, binary } = artifact;
  if (
    build.buildId !== expected.build.buildId ||
    build.sourceSHA !== expected.build.sourceSHA ||
    build.sourceTreeDigest !== expected.build.sourceTreeDigest ||
    build.platform.goos !== expected.build.platform.goos ||
    build.platform.goarch !== expected.build.platform.goarch ||
    binary.path !== expected.binary.path ||
    binary.size !== expected.binary.size ||
    binary.sha256 !== expected.binary.sha256
  )
    refuse("core_artifact_binding_mismatch");
  // Host facts are compatibility checks only; acceptance still comes from caller.
  const goos = process.platform === "win32" ? "windows" : process.platform;
  const goarch = process.arch === "x64" ? "amd64" : process.arch;
  if (build.platform.goos !== goos || build.platform.goarch !== goarch)
    refuse("core_artifact_platform_mismatch");
}
function sameInode(before: BigIntStats, after: BigIntStats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode
  );
}
function sameFile(before: BigIntStats, after: BigIntStats): boolean {
  return (
    sameInode(before, after) &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs &&
    before.nlink === after.nlink
  );
}
// A native header check prevents executable text/shims from redirecting spawn
// to an interpreter. It is compatibility evidence, not proof of Go provenance.
function executableHeader(
  bytes: Buffer,
  platform: CoreBuildBinding["platform"],
): void {
  if (bytes.length < 64) refuse("core_artifact_not_native_executable");
  const arm64 = platform.goarch === "arm64";
  if (platform.goos === "darwin") {
    if (
      bytes.readUInt32LE(0) === 0xfeedfacf &&
      bytes.readUInt32LE(4) === (arm64 ? 0x0100000c : 0x01000007) &&
      bytes.readUInt32LE(12) === 2
    )
      return;
  } else if (platform.goos === "linux") {
    if (
      bytes
        .subarray(0, 7)
        .equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1])) &&
      (bytes.readUInt16LE(16) === 2 || bytes.readUInt16LE(16) === 3) &&
      bytes.readUInt16LE(18) === (arm64 ? 183 : 62) &&
      bytes.readUInt32LE(20) === 1
    )
      return;
  } else {
    const pe = bytes.readUInt32LE(60);
    if (
      bytes.readUInt16LE(0) === 0x5a4d &&
      pe >= 64 &&
      pe <= bytes.length - 26 &&
      bytes.readUInt32LE(pe) === 0x00004550 &&
      bytes.readUInt16LE(pe + 4) === (arm64 ? 0xaa64 : 0x8664) &&
      (bytes.readUInt16LE(pe + 22) & 2) !== 0 &&
      bytes.readUInt16LE(pe + 24) === 0x020b
    )
      return;
  }
  return refuse("core_artifact_not_native_executable");
}
function verifyBinary(expected: TrustedCoreExpectation): string {
  try {
    const root = expected.artifactRoot;
    const executable = join(root, ...expected.binary.path.split("/"));
    // Check every physical component, including ancestors of the trusted root.
    // Do not resolve an alias into new authority or accept a redirected input.
    const filesystemRoot = parse(executable).root;
    const components = executable.slice(filesystemRoot.length).split(sep);
    let current = filesystemRoot;
    const directories: { path: string; stat: BigIntStats }[] = [];
    for (const component of components.slice(0, -1)) {
      current = join(current, component);
      const stat = fs.lstatSync(current, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink())
        refuse("core_artifact_path_redirected");
      directories.push({ path: current, stat });
    }
    const initial = fs.lstatSync(executable, { bigint: true });
    if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1n)
      refuse("core_artifact_not_owned_file");
    if (
      fs.realpathSync(root) !== root ||
      fs.realpathSync(executable) !== executable
    )
      refuse("core_artifact_path_redirected");
    if (process.platform !== "win32" && (initial.mode & 0o111n) === 0n)
      refuse("core_artifact_not_executable");
    if (initial.size !== BigInt(expected.binary.size))
      refuse("core_artifact_size_mismatch");
    const fd = fs.openSync(
      executable,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    try {
      if (!sameFile(initial, fs.fstatSync(fd, { bigint: true })))
        refuse("core_artifact_changed");
      const hash = createHash("sha256");
      const buffer = Buffer.alloc(Math.min(65536, expected.binary.size));
      let size = 0;
      while (size < buffer.length) {
        const count = fs.readSync(fd, buffer, {
          offset: size,
          length: buffer.length - size,
          position: null,
        });
        if (count === 0) refuse("core_artifact_size_mismatch");
        size += count;
      }
      executableHeader(buffer, expected.build.platform);
      hash.update(buffer);
      while (size < expected.binary.size) {
        const count = fs.readSync(fd, buffer, {
          offset: 0,
          length: Math.min(buffer.length, expected.binary.size - size),
          position: null,
        });
        if (count === 0) refuse("core_artifact_size_mismatch");
        hash.update(buffer.subarray(0, count));
        size += count;
      }
      if (
        fs.readSync(fd, buffer, { offset: 0, length: 1, position: null }) !== 0
      )
        refuse("core_artifact_size_mismatch");
      if (hash.digest("hex") !== expected.binary.sha256)
        refuse("core_artifact_digest_mismatch");
      if (!sameFile(initial, fs.fstatSync(fd, { bigint: true })))
        refuse("core_artifact_changed");
    } finally {
      fs.closeSync(fd);
    }
    for (const directory of directories) {
      const stat = fs.lstatSync(directory.path, { bigint: true });
      if (!stat.isDirectory() || !sameInode(directory.stat, stat))
        refuse("core_artifact_path_redirected");
    }
    if (
      fs.realpathSync(executable) !== executable ||
      !sameFile(initial, fs.lstatSync(executable, { bigint: true }))
    )
      refuse("core_artifact_changed");
    return executable;
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    return refuse("core_artifact_unreadable");
  }
}

// Trusted Electron host only; keep one instance for one child lifetime. A start
// is consumed before validation, even on refusal. No renderer IPC or operation
// body can supply these expectations. Client retains all pipe/cleanup ownership.
// Caller must keep the accepted artifact tree immutable through spawn and child
// lifetime: path-based spawnCore cannot atomically attest exec under host mutation.
export class AttestedCore {
  private consumed = false;
  constructor(
    private readonly artifact: unknown,
    private readonly expected: TrustedCoreExpectation,
  ) {}
  // Caller retains a native selection when artifact validation refuses before spawnCore.
  start(timeoutMs = 2000, native?: NativeCoreLaunch): Promise<Client> {
    if (this.consumed)
      return Promise.reject(new BridgeError("refused", "core_start_consumed"));
    this.consumed = true;
    try {
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000)
        refuse("invalid_deadline");
      const expected = expectation(this.expected);
      const artifact = parseCoreArtifactDeclaration(this.artifact);
      bind(artifact, expected);
      const executable = verifyBinary(expected);
      // spawnCore alone performs the one handshake and any owned-child cleanup.
      // Propagate its original rejection, including cleanup unknown, unchanged.
      return spawnCore(
        executable,
        expected.profileId,
        expected.build.buildId,
        timeoutMs,
        ...(native ? ([native] as const) : []),
      );
    } catch (error) {
      return Promise.reject(error);
    }
  }
}
