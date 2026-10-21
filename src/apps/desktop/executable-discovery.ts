import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Bounded, read-only discovery of the local Codex and OpenAI tunnel-client
 * executables, so the Setup UI can offer a candidate instead of forcing the
 * owner through a file picker.
 *
 * This module never executes a discovered candidate. It only decides which
 * candidates are safe to *offer* for the existing execution probes
 * (`probeCodexHost`, `probeTunnelClient`), which remain the only code paths
 * that run a chosen binary.
 *
 * Every filesystem, hashing, code-signing, home-directory, and architecture
 * dependency is injectable so tests can run against fixtures without
 * touching the real machine. The default implementations back onto real
 * `node:fs`, a chunked SHA-256 read (mirroring the probes' own safety
 * checks), and `/usr/bin/codesign`.
 */

const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const CLOSE_ON_EXEC =
  (fsConstants as typeof fsConstants & { O_CLOEXEC?: number }).O_CLOEXEC ?? 0;

// Discovery is allowed to *see* a larger executable than the probes will
// ever run (matching the Legacy dependency scan's 512 MiB ceiling), so a
// real Codex binary (~200-235 MB on this Mac) still shows up as a
// candidate even though `probeCodexHost`'s own 128 MiB cap will refuse it.
const MAX_CANDIDATE_BYTES = 512 * 1024 * 1024;
const CODESIGN_TIMEOUT_MS = 5_000;
const CODESIGN_PATH = "/usr/bin/codesign";
const OPENAI_TEAM_IDENTIFIER = "2DC432GLL2";

export type ExecutableKind = "codex" | "tunnel-client";

export type DiscoverySource =
  | "chatgpt-app"
  | "codex-app"
  | "homebrew"
  | "npm-global"
  | "reviewed-build-dir";

export type DiscoveryOrigin =
  | "reviewed-digest"
  | "signed-by-openai"
  | "signature-other-team"
  | "unsigned"
  | "unknown";

export type DiscoveryVerdict = "offer" | "needs-owner-choice" | "refused";

export type RefusalReason =
  | "not-a-regular-file"
  | "world-or-group-writable"
  | "wrong-owner"
  | "oversize"
  | "changed-during-discovery"
  | "symlink-loop"
  | "unreadable";

export type DiscoveryCandidate = Readonly<{
  /** The fixed or listing-derived path discovery started from. */
  requestedPath: string;
  /** The canonical realpath, or `requestedPath` when it cannot be resolved. */
  path: string;
  source: DiscoverySource;
  bytes?: number;
  sha256?: string;
  origin: DiscoveryOrigin;
  verdict: DiscoveryVerdict;
  refusalReason?: RefusalReason;
}>;

export type DiscoveryResult = Readonly<{
  candidates: readonly DiscoveryCandidate[];
  /** Every fixed path or listed directory discovery touched, found or not. */
  searched: readonly string[];
}>;

export type DiscoveryLstatResult = Readonly<{
  isFile(): boolean;
  isSymbolicLink(): boolean;
  isDirectory(): boolean;
}>;

export type DiscoveryFs = Readonly<{
  lstat: (targetPath: string) => Promise<DiscoveryLstatResult>;
  realpath: (targetPath: string) => Promise<string>;
  readdir: (targetPath: string) => Promise<readonly string[]>;
}>;

export type HashOutcome =
  | Readonly<{ ok: true; bytes: number; sha256: string }>
  | Readonly<{ ok: false; reason: RefusalReason; bytes?: number }>;

export type DiscoveryHash = (canonicalPath: string) => Promise<HashOutcome>;

export type CodesignInspection = Readonly<{
  /** A plain `codesign --verify --strict` passed: the signature is intact. */
  verified: boolean;
  /**
   * The authoritative trust decision: `codesign --verify --strict -R=...`
   * passed against the OpenAI-team requirement string. This is what decides
   * "offer" vs "needs-owner-choice" — never `teamIdentifier`, which is
   * display-only text parsed from `-dv --verbose=2` and is not itself proof
   * of who signed the binary.
   */
  trustedOpenAI: boolean;
  teamIdentifier?: string;
}>;

export type DiscoveryCodesign = Readonly<{
  verifyAndInspect: (executablePath: string) => Promise<CodesignInspection>;
}>;

export type ReviewedTunnelClientDigest = Readonly<{
  sha256: string;
  bytes: number;
}>;

export type ReviewedTunnelClientDigests = Readonly<
  Record<"arm64" | "x86_64", ReviewedTunnelClientDigest>
>;

export type DiscoveryDependencies = Readonly<{
  fs?: Partial<DiscoveryFs>;
  hash?: DiscoveryHash;
  codesign?: DiscoveryCodesign;
  home?: string;
  /** Raw `process.arch`-shaped value, e.g. `"arm64"` or `"x64"`. */
  arch?: string;
  reviewedTunnelClientDigests?: ReviewedTunnelClientDigests;
}>;

/**
 * The reviewed tunnel-client builds, pinned by SHA-256 per architecture.
 * Mirrors `integrations/registry.json` → `dependencies.tunnelClient.builds`;
 * a dedicated test keeps the two in sync so this file cannot drift silently.
 */
export const REVIEWED_TUNNEL_CLIENT_DIGESTS: ReviewedTunnelClientDigests = {
  arm64: {
    sha256: "309fd85da5a8c2ca8dae920deea8ac10a4d7934ed18ac46e7df0c200139cc9c5",
    bytes: 20_405_442,
  },
  x86_64: {
    sha256: "89478d1d58350818275b852169745e1af0e18c02ff9b5b46d50df22018c95be9",
    bytes: 21_877_984,
  },
};

type CandidateSeed = Readonly<{ path: string; source: DiscoverySource }>;

function codexFixedSeeds(): readonly CandidateSeed[] {
  return [
    {
      path: "/Applications/ChatGPT.app/Contents/Resources/codex",
      source: "chatgpt-app",
    },
    {
      path: "/Applications/Codex.app/Contents/Resources/codex",
      source: "codex-app",
    },
    { path: "/opt/homebrew/bin/codex", source: "homebrew" },
    { path: "/usr/local/bin/codex", source: "homebrew" },
  ];
}

function tunnelClientFixedSeeds(): readonly CandidateSeed[] {
  return [
    { path: "/opt/homebrew/bin/tunnel-client", source: "homebrew" },
    {
      path: "/opt/homebrew/opt/tunnel-client/libexec/tunnel-client",
      source: "homebrew",
    },
    { path: "/usr/local/bin/tunnel-client", source: "homebrew" },
    {
      path: "/usr/local/opt/tunnel-client/libexec/tunnel-client",
      source: "homebrew",
    },
  ];
}

/**
 * `@openai/codex`'s own `bin/codex.js` picks a platform package by this
 * exact table (verified against the installed npm package on this Mac) and
 * vendors the native binary at
 * `<platform-package>/vendor/<target-triple>/bin/codex`. Discovery mirrors
 * only the macOS entries, since Farol Next is a macOS-only product.
 */
const NPM_PLATFORM_PACKAGE: Readonly<
  Record<string, Readonly<{ packageName: string; targetTriple: string }>>
> = {
  arm64: {
    packageName: "codex-darwin-arm64",
    targetTriple: "aarch64-apple-darwin",
  },
  x64: { packageName: "codex-darwin-x64", targetTriple: "x86_64-apple-darwin" },
};

async function npmGlobalCodexSeeds(
  home: string,
  rawArch: string,
  fs: DiscoveryFs,
  searched: string[],
): Promise<readonly CandidateSeed[]> {
  const platformPackage = NPM_PLATFORM_PACKAGE[rawArch];
  if (!platformPackage) return [];

  const nvmVersionsRoot = path.join(home, ".nvm", "versions", "node");
  searched.push(nvmVersionsRoot);

  let versions: readonly string[];
  try {
    versions = await fs.readdir(nvmVersionsRoot);
  } catch {
    return [];
  }

  return [...versions]
    .filter((version) => version.startsWith("v")) // skip ".DS_Store" and similar Finder noise
    .sort()
    .map((version) => ({
      path: path.join(
        nvmVersionsRoot,
        version,
        "lib",
        "node_modules",
        "@openai",
        "codex",
        "node_modules",
        "@openai",
        platformPackage.packageName,
        "vendor",
        platformPackage.targetTriple,
        "bin",
        "codex",
      ),
      source: "npm-global" as const,
    }));
}

function mapReviewedArch(rawArch: string): "arm64" | "x86_64" | undefined {
  if (rawArch === "arm64") return "arm64";
  if (rawArch === "x64") return "x86_64";
  return undefined;
}

/**
 * Where this user's own copy of the reviewed tunnel-client build lives, and
 * the pinned digest it must match, or undefined on an unreviewed architecture.
 */
export function reviewedTunnelClientPath(
  home: string,
  rawArch: string,
  reviewedDigests: ReviewedTunnelClientDigests = REVIEWED_TUNNEL_CLIENT_DIGESTS,
): Readonly<{ path: string; digest: ReviewedTunnelClientDigest }> | undefined {
  const reviewedArch = mapReviewedArch(rawArch);
  const digest = reviewedArch ? reviewedDigests[reviewedArch] : undefined;
  const seed = reviewedArch
    ? reviewedBuildDirSeed(home, reviewedArch, reviewedDigests)
    : undefined;
  return digest && seed ? { path: seed.path, digest } : undefined;
}

function reviewedBuildDirSeed(
  home: string,
  reviewedArch: "arm64" | "x86_64",
  reviewedDigests: ReviewedTunnelClientDigests,
): CandidateSeed | undefined {
  const digest = reviewedDigests[reviewedArch];
  if (!digest) return undefined;
  return {
    path: path.join(
      home,
      ".local",
      "libexec",
      "agent-commons",
      "secure-mcp-tunnel",
      "builds",
      digest.sha256,
      "tunnel-client",
    ),
    source: "reviewed-build-dir",
  };
}

function permittedOwner(uid: number): boolean {
  const effectiveUser = process.geteuid?.();
  return effectiveUser === undefined || uid === effectiveUser || uid === 0;
}

const defaultFs: DiscoveryFs = {
  lstat: (targetPath) => fsPromises.lstat(targetPath),
  realpath: (targetPath) => fsPromises.realpath(targetPath),
  readdir: (targetPath) => fsPromises.readdir(targetPath),
};

/**
 * Safety-checks and hashes an already-canonical path, mirroring the file
 * checks `codex-host-probe.ts` and `tunnel-client-probe.ts` perform before
 * they will ever run a selected executable: regular file, owned by the
 * effective user (or root), not group/world-writable, and within the size
 * ceiling. Opens with `O_NOFOLLOW` so a symlink swapped in after `realpath`
 * cannot be followed.
 */
const defaultHash: DiscoveryHash = async (canonicalPath) => {
  let handle;
  try {
    handle = await fsPromises.open(
      canonicalPath,
      fsConstants.O_RDONLY | NO_FOLLOW | CLOSE_ON_EXEC,
    );
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { ok: false, reason: "not-a-regular-file" };
    if (!permittedOwner(info.uid)) return { ok: false, reason: "wrong-owner" };
    if ((info.mode & 0o022) !== 0) {
      return { ok: false, reason: "world-or-group-writable", bytes: info.size };
    }
    if (info.size < 1 || info.size > MAX_CANDIDATE_BYTES) {
      return { ok: false, reason: "oversize", bytes: info.size };
    }
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1_024);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length,
        position,
      );
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return { ok: true, bytes: info.size, sha256: digest.digest("hex") };
  } catch {
    return { ok: false, reason: "unreadable" };
  } finally {
    await handle.close();
  }
};

async function runCodesign(
  args: readonly string[],
  executablePath: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      CODESIGN_PATH,
      [...args, executablePath],
      { timeout: CODESIGN_TIMEOUT_MS, encoding: "utf8", windowsHide: true },
      (error, stdout, stderr) => {
        if (error) reject(error);
        else resolve(`${stdout}\n${stderr}`);
      },
    );
  });
}

// Trust decision: the signature must chain to Apple's own root AND the
// signing certificate's OU must be the OpenAI team identifier. A plain
// `--verify --strict` only proves the binary was not modified after
// signing; it says nothing about *who* signed it, so a self-signed or
// third-party-signed binary would pass it just as cleanly as a genuine
// OpenAI build. The `-R` requirement string is the actual trust boundary.
//
// Verified: `codesign --verify --strict -R=...` exits 0 against both real
// Codex binaries (ChatGPT.app and Codex.app) when run outside the agent
// tool sandbox; inside this sandbox codesign itself fails to launch, which
// is a sandbox artifact, not a defect in the requirement string — do not
// "fix" this by loosening it.
const OPENAI_CODESIGN_REQUIREMENT = `anchor apple generic and certificate leaf[subject.OU] = "${OPENAI_TEAM_IDENTIFIER}"`;

const defaultCodesign: DiscoveryCodesign = {
  verifyAndInspect: async (executablePath) => {
    let verified = false;
    try {
      await runCodesign(["--verify", "--strict"], executablePath);
      verified = true;
    } catch {
      verified = false;
    }

    let trustedOpenAI = false;
    try {
      await runCodesign(
        ["--verify", "--strict", `-R=${OPENAI_CODESIGN_REQUIREMENT}`],
        executablePath,
      );
      trustedOpenAI = true;
    } catch {
      trustedOpenAI = false;
    }

    let teamIdentifier: string | undefined;
    try {
      const output = await runCodesign(["-dv", "--verbose=2"], executablePath);
      const match = /^TeamIdentifier=(.+)$/mu.exec(output);
      const raw = match?.[1]?.trim();
      if (raw && raw !== "not set") teamIdentifier = raw;
    } catch {
      teamIdentifier = undefined;
    }

    return teamIdentifier === undefined
      ? { verified, trustedOpenAI }
      : { verified, trustedOpenAI, teamIdentifier };
  },
};

export function classifyCodexOrigin(
  inspection: CodesignInspection,
): DiscoveryOrigin {
  // The `-R` requirement check is the sole trust decision: it fails closed
  // against a forged, coincidentally-matching, or merely similarly-named
  // TeamIdentifier string, because it is macOS verifying the certificate
  // chain itself rather than this process parsing signer-controlled text.
  if (inspection.trustedOpenAI) return "signed-by-openai";
  if (inspection.verified && inspection.teamIdentifier) {
    return "signature-other-team";
  }
  if (!inspection.verified && !inspection.teamIdentifier) return "unsigned";
  return "unknown";
}

export function classifyTunnelClientOrigin(
  sha256: string,
  reviewedArch: "arm64" | "x86_64" | undefined,
  reviewedDigests: ReviewedTunnelClientDigests,
): DiscoveryOrigin {
  if (reviewedArch && reviewedDigests[reviewedArch]?.sha256 === sha256) {
    return "reviewed-digest";
  }
  return "unknown";
}

function isLoopError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ELOOP"
  );
}

type ResolveContext = Readonly<{
  fs: DiscoveryFs;
  hash: DiscoveryHash;
  codesign: DiscoveryCodesign;
  reviewedArch: "arm64" | "x86_64" | undefined;
  reviewedDigests: ReviewedTunnelClientDigests;
}>;

async function safeCodesignInspect(
  codesign: DiscoveryCodesign,
  executablePath: string,
): Promise<CodesignInspection> {
  try {
    return await codesign.verifyAndInspect(executablePath);
  } catch {
    return { verified: false, trustedOpenAI: false };
  }
}

async function resolveCandidate(
  seed: CandidateSeed,
  kind: ExecutableKind,
  ctx: ResolveContext,
): Promise<DiscoveryCandidate | undefined> {
  let lstatResult: DiscoveryLstatResult;
  try {
    lstatResult = await ctx.fs.lstat(seed.path);
  } catch {
    return undefined; // not present; not a refusal, simply absent
  }

  if (!lstatResult.isFile() && !lstatResult.isSymbolicLink()) {
    return {
      requestedPath: seed.path,
      path: seed.path,
      source: seed.source,
      origin: "unknown",
      verdict: "refused",
      refusalReason: "not-a-regular-file",
    };
  }

  let canonicalPath: string;
  try {
    canonicalPath = await ctx.fs.realpath(seed.path);
  } catch (error) {
    return {
      requestedPath: seed.path,
      path: seed.path,
      source: seed.source,
      origin: "unknown",
      verdict: "refused",
      refusalReason: isLoopError(error) ? "symlink-loop" : "unreadable",
    };
  }

  const hashed = await ctx.hash(canonicalPath);
  if (!hashed.ok) {
    return {
      requestedPath: seed.path,
      path: canonicalPath,
      source: seed.source,
      ...(hashed.bytes !== undefined ? { bytes: hashed.bytes } : {}),
      origin: "unknown",
      verdict: "refused",
      refusalReason: hashed.reason,
    };
  }

  if (kind === "codex") {
    const inspection = await safeCodesignInspect(ctx.codesign, canonicalPath);
    // Bind the signature verdict to the same bytes that discovery reports.
    // codesign operates on a path, so hash again after it returns. A change
    // across that boundary is refused: no signer verdict can be bound to it.
    const afterSignature = await ctx.hash(canonicalPath);
    if (!afterSignature.ok) {
      return {
        requestedPath: seed.path,
        path: canonicalPath,
        source: seed.source,
        ...(afterSignature.bytes !== undefined
          ? { bytes: afterSignature.bytes }
          : {}),
        origin: "unknown",
        verdict: "refused",
        refusalReason: afterSignature.reason,
      };
    }
    if (
      afterSignature.sha256 !== hashed.sha256 ||
      afterSignature.bytes !== hashed.bytes
    ) {
      return {
        requestedPath: seed.path,
        path: canonicalPath,
        source: seed.source,
        bytes: afterSignature.bytes,
        sha256: afterSignature.sha256,
        origin: "unknown",
        verdict: "refused",
        refusalReason: "changed-during-discovery",
      };
    }
    const origin = classifyCodexOrigin(inspection);
    return {
      requestedPath: seed.path,
      path: canonicalPath,
      source: seed.source,
      bytes: hashed.bytes,
      sha256: hashed.sha256,
      origin,
      verdict: origin === "signed-by-openai" ? "offer" : "needs-owner-choice",
    };
  }

  const origin = classifyTunnelClientOrigin(
    hashed.sha256,
    ctx.reviewedArch,
    ctx.reviewedDigests,
  );
  return {
    requestedPath: seed.path,
    path: canonicalPath,
    source: seed.source,
    bytes: hashed.bytes,
    sha256: hashed.sha256,
    origin,
    verdict: origin === "reviewed-digest" ? "offer" : "needs-owner-choice",
  };
}

const VERDICT_RANK: Readonly<Record<DiscoveryVerdict, number>> = {
  offer: 0,
  "needs-owner-choice": 1,
  refused: 2,
};

export async function discoverExecutables(
  kind: ExecutableKind,
  dependencies: DiscoveryDependencies = {},
): Promise<DiscoveryResult> {
  const fs: DiscoveryFs = { ...defaultFs, ...dependencies.fs };
  const hash = dependencies.hash ?? defaultHash;
  const codesign = dependencies.codesign ?? defaultCodesign;
  const home = dependencies.home ?? os.homedir();
  const rawArch = dependencies.arch ?? process.arch;
  const reviewedDigests =
    dependencies.reviewedTunnelClientDigests ?? REVIEWED_TUNNEL_CLIENT_DIGESTS;
  const reviewedArch = mapReviewedArch(rawArch);

  const searched: string[] = [];
  let seeds: readonly CandidateSeed[];
  if (kind === "codex") {
    const npmSeeds = await npmGlobalCodexSeeds(home, rawArch, fs, searched);
    seeds = [...codexFixedSeeds(), ...npmSeeds];
  } else {
    const reviewedSeed = reviewedArch
      ? reviewedBuildDirSeed(home, reviewedArch, reviewedDigests)
      : undefined;
    seeds = [
      ...tunnelClientFixedSeeds(),
      ...(reviewedSeed ? [reviewedSeed] : []),
    ];
  }
  for (const seed of seeds) searched.push(seed.path);

  const ctx: ResolveContext = {
    fs,
    hash,
    codesign,
    reviewedArch,
    reviewedDigests,
  };
  const resolved = new Map<string, number>();
  const order: DiscoveryCandidate[] = [];
  for (const seed of seeds) {
    const candidate = await resolveCandidate(seed, kind, ctx);
    if (!candidate) continue;
    // Multiple fixed locations commonly resolve to the same reviewed build,
    // either through symlinks or byte-identical copies. Present and probe it
    // once: path aliases are not independent owner choices.
    const identity = candidate.sha256
      ? `sha256:${candidate.sha256}`
      : `path:${candidate.path}`;
    const existingIndex = resolved.get(identity);
    if (existingIndex === undefined) {
      resolved.set(identity, order.length);
      order.push(candidate);
      continue;
    }
    const existing = order[existingIndex];
    if (
      existing !== undefined &&
      VERDICT_RANK[candidate.verdict] < VERDICT_RANK[existing.verdict]
    ) {
      order[existingIndex] = candidate;
    }
  }

  const candidates = [...order].sort(
    (a, b) => VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict],
  );

  return { candidates, searched: [...new Set(searched)] };
}
