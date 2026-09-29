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
// Update only after reviewing update_archive.py and its focused tests.
export const UPDATE_ARCHIVE_HELPER_SHA256 =
  "b9097be9dfb53c4cc8a3cdae7d083fde41226e77b0cd4e039b8b59b36d07d0fb";
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
      | "archive_refused"
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
    if (!before.isFile() || before.size < 1n || before.size > 262144n)
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
async function readArtifact(file: string): Promise<unknown> {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 2 || stat.size > 65536)
      throw new PackageVerificationError("package_mismatch");
    try {
      return JSON.parse(await handle.readFile("utf8")) as unknown;
    } catch (cause) {
      throw new PackageVerificationError("package_mismatch", cause);
    }
  } finally {
    await handle.close();
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
  }>,
) {
  const verified = new Map<string, VerifiedStagedPackage>();
  return {
    async verifyPackage(
      handle: string,
      expected: ReleaseManifest,
    ): Promise<VerifiedStagedPackage> {
      if (!handle || verified.has(handle))
        throw new PackageVerificationError("invalid_handle");
      await privateParent(options.stagingParent);
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
          mode: 0o600,
        });
        const { stdout } = await execFileAsync(
          "/usr/bin/python3",
          [
            "-I",
            "-S",
            "-B",
            extractorCopy,
            archivePath,
            stagingRoot,
            String(expected.archiveSize),
            expected.archiveSha256,
          ],
          { encoding: "utf8", maxBuffer: 8192, timeout: 600_000 },
        );
        const extracted = JSON.parse(stdout) as {
          appPath?: unknown;
          artifactPath?: unknown;
        };
        const stagedAppPath = path.join(stagingRoot, "Farol Next Preview.app");
        if (
          extracted.appPath !== stagedAppPath ||
          extracted.artifactPath !== path.join(stagingRoot, "artifact.json")
        )
          throw new PackageVerificationError("archive_refused");
        const artifact = await readArtifact(
          path.join(stagingRoot, "artifact.json"),
        );
        if (!claimsMatch(artifact, expected))
          throw new PackageVerificationError("package_mismatch");
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
              env: { PATH: "/usr/bin:/bin", ELECTRON_RUN_AS_NODE: "1" },
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
        await fs.rm(stagingRoot, { recursive: true, force: true });
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
      verified.delete(handle);
      if (result)
        await fs.rm(result.stagingRoot, { recursive: true, force: true });
    },
  };
}
