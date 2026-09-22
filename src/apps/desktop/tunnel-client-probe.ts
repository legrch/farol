import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const CLOSE_ON_EXEC =
  (fsConstants as typeof fsConstants & { O_CLOEXEC?: number }).O_CLOEXEC ?? 0;
const MAX_EXECUTABLE_BYTES = 128 * 1_024 * 1_024;
const MAX_OUTPUT_BYTES = 256 * 1_024;
const PROBE_TIMEOUT_MS = 5_000;
const SAFE_PATH = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
].join(":");

export type TunnelClientProbeCommand = Readonly<{
  executablePath: string;
  arguments: readonly string[];
  cwd: string;
  environment: Readonly<Record<string, string>>;
  timeoutMs: number;
  maxBufferBytes: number;
}>;

export type TunnelClientProbeRunner = (
  command: TunnelClientProbeCommand,
) => Promise<Readonly<{ stdout: string; stderr: string }>>;

export type TunnelClientProbe = Readonly<{
  executablePath: string;
  executableSha256: string;
  version: string;
  protocol: "openai-tunnel-client/v1";
}>;

type ProbeDependencies = Readonly<{ run?: TunnelClientProbeRunner }>;

function probeError(code: string): never {
  throw new Error(code);
}

function permittedOwner(uid: number): boolean {
  const effectiveUser = process.geteuid?.();
  return effectiveUser === undefined || uid === effectiveUser || uid === 0;
}

async function pinExecutable(executablePath: string): Promise<{
  canonicalPath: string;
  sha256: string;
}> {
  if (!path.isAbsolute(executablePath) || executablePath.includes("\0")) {
    probeError("TUNNEL_CLIENT_SELECTION_INVALID");
  }
  let selectedInfo;
  let canonicalPath;
  try {
    selectedInfo = await fs.lstat(executablePath);
    canonicalPath = await fs.realpath(executablePath);
  } catch {
    probeError("TUNNEL_CLIENT_EXECUTABLE_UNSAFE");
  }
  if (
    (!selectedInfo.isFile() && !selectedInfo.isSymbolicLink()) ||
    !permittedOwner(selectedInfo.uid)
  ) {
    probeError("TUNNEL_CLIENT_EXECUTABLE_UNSAFE");
  }

  let handle;
  try {
    handle = await fs.open(
      canonicalPath,
      fsConstants.O_RDONLY | NO_FOLLOW | CLOSE_ON_EXEC,
    );
  } catch {
    probeError("TUNNEL_CLIENT_EXECUTABLE_UNSAFE");
  }
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.size < 1 ||
      info.size > MAX_EXECUTABLE_BYTES ||
      !permittedOwner(info.uid) ||
      (info.mode & 0o111) === 0 ||
      (info.mode & 0o022) !== 0
    ) {
      probeError("TUNNEL_CLIENT_EXECUTABLE_UNSAFE");
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
    return { canonicalPath, sha256: digest.digest("hex") };
  } finally {
    await handle.close();
  }
}

const runProbe: TunnelClientProbeRunner = async (command) =>
  new Promise((resolve, reject) => {
    execFile(
      command.executablePath,
      [...command.arguments],
      {
        cwd: command.cwd,
        env: { ...command.environment },
        encoding: "utf8",
        maxBuffer: command.maxBufferBytes,
        timeout: command.timeoutMs,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) reject(error);
        else resolve({ stdout, stderr });
      },
    );
  });

const requiredSurfaces = {
  init: {
    arguments: ["help", "init"],
    flags: [
      "--profile",
      "--profile-dir",
      "--tunnel-id",
      "--control-plane-api-key-ref",
      "--health-listen-addr",
      "--mcp-command",
    ],
  },
  doctor: {
    // `help doctor` is prose in the reviewed client. The subcommand's own
    // help is the compatibility surface that lists its accepted flags.
    arguments: ["doctor", "--help"],
    flags: ["--profile", "--profile-dir", "--json", "--explain"],
  },
  run: {
    arguments: ["help", "run"],
    flags: [
      "--profile",
      "--profile-dir",
      "--health.listen-addr",
      "--health.url-file",
      "--pid.file",
    ],
  },
} as const;

const SEMVER =
  "[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?";
const bareVersion = new RegExp(
  `^(${SEMVER})(?: \\(git sha: ([0-9a-f]{7,64})\\))?$`,
  "u",
);
const labeledVersion = new RegExp(
  `^tunnel-client version (${SEMVER})(?: \\(git sha: ([0-9a-f]{7,64})\\))?$`,
  "u",
);

function parseVersionOutput(
  output: Readonly<{ stdout: string; stderr: string }>,
) {
  const candidates = [output.stdout.trim(), output.stderr.trim()].filter(
    (candidate) => candidate.length > 0,
  );
  if (candidates.length !== 1) return null;
  const candidate = candidates[0];
  if (candidate === undefined) return null;

  const parsed = bareVersion.exec(candidate) ?? labeledVersion.exec(candidate);
  if (!parsed?.[1]) return null;
  const gitSha = parsed[2];
  const build = parsed[1].split("+", 2)[1];
  if (gitSha && build && gitSha !== build) return null;
  return parsed[1];
}

export async function probeTunnelClient(
  input: Readonly<{
    executablePath: string;
    expectedDiscovery?: Readonly<{
      canonicalPath: string;
      sha256: string;
    }>;
  }>,
  dependencies: ProbeDependencies = {},
): Promise<TunnelClientProbe> {
  const pinned = await pinExecutable(input.executablePath);
  if (
    input.expectedDiscovery !== undefined &&
    (input.expectedDiscovery.canonicalPath !== pinned.canonicalPath ||
      input.expectedDiscovery.sha256 !== pinned.sha256)
  ) {
    probeError("TUNNEL_CLIENT_DISCOVERY_CANDIDATE_STALE");
  }
  const run = dependencies.run ?? runProbe;
  const common = {
    executablePath: pinned.canonicalPath,
    cwd: path.dirname(pinned.canonicalPath),
    environment: {
      PATH: `${path.dirname(pinned.canonicalPath)}:${SAFE_PATH}`,
      NO_COLOR: "1",
      TERM: "dumb",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
    },
    timeoutMs: PROBE_TIMEOUT_MS,
    maxBufferBytes: MAX_OUTPUT_BYTES,
  } as const;

  let versionOutput: Readonly<{ stdout: string; stderr: string }>;
  try {
    versionOutput = await run({ ...common, arguments: ["--version"] });
  } catch {
    probeError("TUNNEL_CLIENT_PROBE_FAILED");
  }
  const version = parseVersionOutput(versionOutput);
  if (!version) probeError("TUNNEL_CLIENT_INCOMPATIBLE");

  for (const { arguments: probeArguments, flags } of Object.values(
    requiredSurfaces,
  )) {
    let output: string;
    try {
      const result = await run({
        ...common,
        arguments: probeArguments,
      });
      output = `${result.stdout}\n${result.stderr}`;
    } catch {
      probeError("TUNNEL_CLIENT_PROBE_FAILED");
    }
    if (!flags.every((flag) => output.includes(flag))) {
      probeError("TUNNEL_CLIENT_INCOMPATIBLE");
    }
  }

  return {
    executablePath: pinned.canonicalPath,
    executableSha256: pinned.sha256,
    version,
    protocol: "openai-tunnel-client/v1",
  };
}
