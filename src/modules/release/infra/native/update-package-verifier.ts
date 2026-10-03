import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants, type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
  PackageIdentity,
  ReleaseManifest,
} from "../../domain/github-release-contract";

const execFileAsync = promisify(execFile);
// Reviewed Go extractor; the legacy filename is a schema-6 transport boundary.
export const UPDATE_ARCHIVE_HELPER_SHA256 =
  "0f60969f4acbaf57d2c628c69412f4f81f227a94e1d27c60d36356fe8ed9d4c7";
const UPDATE_ARCHIVE_MAX_BYTES = 8 * 1024 * 1024;
type MeasuredIdentity = PackageIdentity & Readonly<{ buildVersion: string }>;
export type VerifiedStagedPackage = Readonly<{
  identity: MeasuredIdentity;
  stagedAppPath: string;
  stagingRoot: string;
}>;
export class PackageVerificationError extends Error {
  override readonly name = "PackageVerificationError";
  constructor(
    readonly code:
      | "invalid_handle"
      | "invalid_stage"
      | "stage_capacity"
      | "archive_refused"
      | "cleanup_unknown"
      | "package_mismatch",
    cause?: unknown,
  ) {
    super(code, { cause });
  }
}

function sameRegularFile(before: BigIntStats, after: BigIntStats): boolean {
  return (
    after.isFile() &&
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode &&
    before.nlink === after.nlink &&
    before.uid === after.uid &&
    before.gid === after.gid &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}

async function pinnedHelper(file: string): Promise<Buffer> {
  try {
    const before = await fs.lstat(file, { bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size < 1n ||
      before.size > BigInt(UPDATE_ARCHIVE_MAX_BYTES) ||
      (before.mode & 0o022n) !== 0n
    )
      throw new PackageVerificationError("invalid_stage");
    const handle = await fs.open(
      file,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    try {
      const opened = await handle.stat({ bigint: true });
      if (!sameRegularFile(before, opened))
        throw new PackageVerificationError("invalid_stage");
      // One sentinel byte detects growth without ever allocating or reading
      // beyond the checked helper size plus one.
      const buffer = Buffer.alloc(Number(opened.size) + 1);
      let total = 0;
      while (total < buffer.length) {
        const { bytesRead } = await handle.read(
          buffer,
          total,
          buffer.length - total,
          total,
        );
        if (bytesRead === 0) break;
        total += bytesRead;
      }
      if (
        total !== Number(opened.size) ||
        !sameRegularFile(opened, await handle.stat({ bigint: true })) ||
        !sameRegularFile(opened, await fs.lstat(file, { bigint: true }))
      )
        throw new PackageVerificationError("invalid_stage");
      const bytes = buffer.subarray(0, total);
      if (
        createHash("sha256").update(bytes).digest("hex") !==
        UPDATE_ARCHIVE_HELPER_SHA256
      )
        throw new PackageVerificationError("invalid_stage");
      return bytes;
    } finally {
      await handle.close();
    }
  } catch (cause) {
    if (cause instanceof PackageVerificationError) throw cause;
    throw new PackageVerificationError("invalid_stage", cause);
  }
}
async function privateParent(directory: string): Promise<void> {
  const stat = await fs.lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  )
    throw new PackageVerificationError("invalid_stage");
}
async function readArtifact(
  file: string,
  maxBytes = 65536,
  expectedSha256?: string,
): Promise<unknown> {
  try {
    const before = await fs.lstat(file, { bigint: true });
    if (!before.isFile() || before.size < 2n || before.size > BigInt(maxBytes))
      throw new PackageVerificationError("package_mismatch");
    const handle = await fs.open(
      file,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    try {
      const opened = await handle.stat({ bigint: true });
      if (!sameRegularFile(before, opened))
        throw new PackageVerificationError("package_mismatch");
      // The checked size plus one sentinel bounds allocation and detects growth.
      const buffer = Buffer.alloc(Number(opened.size) + 1);
      let total = 0;
      while (total < buffer.length) {
        const { bytesRead } = await handle.read(
          buffer,
          total,
          buffer.length - total,
          total,
        );
        if (bytesRead === 0) break;
        total += bytesRead;
      }
      if (
        total !== Number(opened.size) ||
        !sameRegularFile(opened, await handle.stat({ bigint: true })) ||
        !sameRegularFile(opened, await fs.lstat(file, { bigint: true }))
      )
        throw new PackageVerificationError("package_mismatch");
      const bytes = buffer.subarray(0, total);
      if (
        expectedSha256 !== undefined &&
        createHash("sha256").update(bytes).digest("hex") !== expectedSha256
      )
        throw new PackageVerificationError("package_mismatch");
      return JSON.parse(bytes.toString("utf8")) as unknown;
    } finally {
      await handle.close();
    }
  } catch (cause) {
    if (cause instanceof PackageVerificationError) throw cause;
    throw new PackageVerificationError("package_mismatch", cause);
  }
}
function claimsMatch(value: unknown, expected: ReleaseManifest): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const a = value as Record<string, unknown>;
  return (
    a.product === expected.product &&
    a.bundleId === expected.bundleId &&
    a.version === expected.version &&
    a.buildVersion === expected.buildVersion &&
    a.sourceCommit === expected.sourceCommit &&
    a.sourceTreeDigest === expected.sourceTreeDigest &&
    a.buildId === expected.buildId &&
    a.artifactSha256 === expected.artifactSha256 &&
    a.sourceDirty === false &&
    a.notarized === expected.notarized &&
    a.updateChannel ===
      (expected.channel === "owner-beta"
        ? "github-owner-beta"
        : "github-stable") &&
    (a.signing as Record<string, unknown> | null)?.kind === expected.signing
  );
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
// This consumer projection binds schema 7 to the expected release before the
// trusted content verifier measures its files, Mach-O header and complete tree.
// It does not promote the core declaration's own hash to trusted provenance.
function goClaimsMatch(
  embedded: unknown,
  core: unknown,
  expected: ReleaseManifest,
): boolean {
  const manifest = record(embedded);
  const declaration = record(core);
  const build = record(declaration?.build);
  const platform = record(build?.platform);
  const binary = record(declaration?.binary);
  const hashes = record(manifest?.entrySha256);
  return (
    manifest !== null &&
    declaration !== null &&
    build !== null &&
    platform !== null &&
    binary !== null &&
    hashes !== null &&
    manifest.schema === 4 &&
    manifest.sourceMode === "head-exact" &&
    manifest.inputExact === true &&
    manifest.dirty === false &&
    typeof manifest.inputLedgerSha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(manifest.inputLedgerSha256) &&
    manifest.product === expected.product &&
    manifest.bundleId === expected.bundleId &&
    manifest.version === expected.version &&
    manifest.buildId === expected.buildId &&
    manifest.sourceCommit === expected.sourceCommit &&
    manifest.sourceTreeDigest === expected.sourceTreeDigest &&
    Array.isArray(manifest.entries) &&
    manifest.entries.filter((entry) => entry === "core-artifact.json")
      .length === 1 &&
    manifest.entries.filter((entry) => entry === "farol-backend").length ===
      1 &&
    JSON.stringify(manifest.core) === JSON.stringify(core) &&
    exactKeys(declaration, ["schema", "build", "binary"]) &&
    declaration.schema === "farol-core-artifact/1" &&
    exactKeys(build, [
      "buildId",
      "sourceSHA",
      "sourceTreeDigest",
      "platform",
    ]) &&
    build.buildId === expected.buildId &&
    build.sourceSHA === expected.sourceCommit &&
    build.sourceTreeDigest === expected.sourceTreeDigest &&
    exactKeys(platform, ["goos", "goarch"]) &&
    platform.goos === expected.platform &&
    platform.goarch === expected.arch &&
    exactKeys(binary, ["path", "size", "sha256"]) &&
    binary.path === "farol-backend" &&
    typeof binary.size === "number" &&
    Number.isSafeInteger(binary.size) &&
    binary.size >= 64 &&
    binary.size <= 128 * 1024 * 1024 &&
    typeof binary.sha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(binary.sha256) &&
    hashes["farol-backend"] === binary.sha256 &&
    typeof hashes["core-artifact.json"] === "string" &&
    /^[a-f0-9]{64}$/u.test(hashes["core-artifact.json"])
  );
}
function measuredMatches(a: MeasuredIdentity, e: ReleaseManifest): boolean {
  return (
    a.product === e.product &&
    a.bundleId === e.bundleId &&
    a.version === e.version &&
    a.buildVersion === e.buildVersion &&
    a.buildId === e.buildId &&
    a.sourceCommit === e.sourceCommit &&
    a.sourceTreeDigest === e.sourceTreeDigest &&
    a.artifactSha256 === e.artifactSha256 &&
    a.signing === e.signing &&
    a.notarized === e.notarized
  );
}

/** The private download adapter resolves handles; a handle is never interpreted as a path. */
export function createUpdatePackageVerifier(
  options: Readonly<{
    archivePathForHandle(handle: string): Promise<string>;
    stagingParent: string;
    extractorPath: string;
    verifierPath: string;
    nodeExecutable?: string;
    // Electron callers supply physical removal; ASAR files are not directories.
    removeDirectory?(directory: string, force: boolean): Promise<void>;
  }>,
) {
  const removeDirectory =
    options.removeDirectory ??
    ((directory: string, force: boolean) =>
      fs.rm(directory, { recursive: true, force }));
  const verified = new Map<string, VerifiedStagedPackage>();
  return {
    async verifyPackage(
      handle: string,
      expected: ReleaseManifest,
    ): Promise<VerifiedStagedPackage> {
      if (!handle || verified.has(handle))
        throw new PackageVerificationError("invalid_handle");
      await privateParent(options.stagingParent);
      // Normal callers discard an extraction after use. A crash may leave its
      // owned directory behind; bound those obligations without deleting a
      // stage whose previous verification/cleanup outcome is not reconciled.
      let stages = 0;
      let entries = 0;
      for await (const entry of await fs.opendir(options.stagingParent)) {
        entries++;
        if (entry.name.startsWith("farol-update-verify-")) stages++;
        if (stages >= 2 || entries > 1024)
          throw new PackageVerificationError("stage_capacity");
      }
      const extractorBytes = await pinnedHelper(options.extractorPath);
      const archivePath = await options.archivePathForHandle(handle);
      if (!path.isAbsolute(archivePath))
        throw new PackageVerificationError("invalid_handle");
      const stagingRoot = await fs.mkdtemp(
        path.join(
          await fs.realpath(options.stagingParent),
          "farol-update-verify-",
        ),
      );
      try {
        const extractorCopy = path.join(stagingRoot, ".update_archive.py");
        await fs.writeFile(extractorCopy, extractorBytes, {
          flag: "wx",
          mode: 0o700,
        });
        const { stdout } = await execFileAsync(
          extractorCopy,
          [
            archivePath,
            stagingRoot,
            String(expected.archiveSize),
            expected.archiveSha256,
          ],
          {
            encoding: "utf8",
            maxBuffer: 8192,
            timeout: 600_000,
            env: { PATH: "/usr/bin:/bin" },
          },
        );
        const extracted = JSON.parse(stdout) as {
          appPath?: unknown;
          artifactPath?: unknown;
        };
        const artifact = await readArtifact(
          path.join(stagingRoot, "artifact.json"),
        );
        const schema =
          artifact !== null &&
          typeof artifact === "object" &&
          !Array.isArray(artifact)
            ? (artifact as Record<string, unknown>)["schema"]
            : null;
        // Historical schema-5 packages remain available to the standalone
        // archive verifier. Installing one into Farol.app would strand its
        // embedded updater at the retired fixed slot, so this route admits
        // only the two explicit branded generations.
        if (schema !== 6 && schema !== 7)
          throw new PackageVerificationError("package_mismatch");
        const stagedAppPath = path.join(stagingRoot, "Farol.app");
        if (
          extracted.appPath !== stagedAppPath ||
          extracted.artifactPath !== path.join(stagingRoot, "artifact.json")
        )
          throw new PackageVerificationError("archive_refused");
        if (!claimsMatch(artifact, expected))
          throw new PackageVerificationError("package_mismatch");
        if (schema === 7) {
          const resources = path.join(stagedAppPath, "Contents/Resources/app");
          const embedded = await readArtifact(
            path.join(resources, "build-manifest.json"),
          );
          const coreHash = record(record(embedded)?.entrySha256)?.[
            "core-artifact.json"
          ];
          if (typeof coreHash !== "string" || !/^[a-f0-9]{64}$/u.test(coreHash))
            throw new PackageVerificationError("package_mismatch");
          const core = await readArtifact(
            path.join(resources, "core-artifact.json"),
            8192,
            coreHash,
          );
          if (!goClaimsMatch(embedded, core, expected))
            throw new PackageVerificationError("package_mismatch");
        }
        let identity: MeasuredIdentity;
        try {
          const { stdout: verifiedJson } = await execFileAsync(
            options.nodeExecutable ?? process.execPath,
            [
              options.verifierPath,
              path.join(stagingRoot, "artifact.json"),
              stagedAppPath,
              expected.version,
              expected.buildVersion,
              expected.channel === "owner-beta"
                ? "github-owner-beta"
                : "github-stable",
            ],
            {
              encoding: "utf8",
              maxBuffer: 8192,
              timeout: 600_000,
              env: {
                PATH: "/usr/bin:/bin",
                ELECTRON_RUN_AS_NODE: "1",
                ELECTRON_NO_ASAR: "1",
              },
            },
          );
          identity = JSON.parse(verifiedJson) as MeasuredIdentity;
        } catch (cause) {
          throw new PackageVerificationError("package_mismatch", cause);
        }
        if (!measuredMatches(identity, expected))
          throw new PackageVerificationError("package_mismatch");
        const result = { identity, stagedAppPath, stagingRoot };
        verified.set(handle, result);
        return result;
      } catch (cause) {
        try {
          await removeDirectory(stagingRoot, true);
        } catch (cleanupError) {
          throw new PackageVerificationError("cleanup_unknown", cleanupError);
        }
        if (cause instanceof PackageVerificationError) throw cause;
        throw new PackageVerificationError("archive_refused", cause);
      }
    },
    /** In-memory binding only. After restart, reverify the opaque handle. */
    verifiedAppPath(handle: string): string | null {
      return verified.get(handle)?.stagedAppPath ?? null;
    },
    async discard(handle: string): Promise<void> {
      const result = verified.get(handle);
      if (result) await removeDirectory(result.stagingRoot, true);
      verified.delete(handle);
    },
  };
}
