import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import {
  inspectCodexHostContract,
  type CodexHostContract,
} from "./codex-host-contract";

const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const CLOSE_ON_EXEC =
  (fsConstants as typeof fsConstants & { O_CLOEXEC?: number }).O_CLOEXEC ?? 0;
const MAX_EXECUTABLE_BYTES = 128 * 1_024 * 1_024;
const VERSION_TIMEOUT_MS = 5_000;
const SCHEMA_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 256 * 1_024;
const SAFE_PATH = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
].join(":");

export type CodexProbeCommand = Readonly<{
  executablePath: string;
  arguments: readonly string[];
  cwd: string;
  environment: Readonly<Record<string, string>>;
  timeoutMs: number;
  maxBufferBytes: number;
}>;

export type CodexProbeRunner = (
  command: CodexProbeCommand,
) => Promise<Readonly<{ stdout: string; stderr: string }>>;

export type CodexHostProbe = CodexHostContract &
  Readonly<{
    executablePath: string;
    executableSha256: string;
  }>;

type ProbeDependencies = Readonly<{ run?: CodexProbeRunner }>;

function probeError(code: string): never {
  throw new Error(code);
}

function permittedOwner(uid: number): boolean {
  const effectiveUser = process.geteuid?.();
  return effectiveUser === undefined || uid === effectiveUser || uid === 0;
}

async function hashSelectedExecutable(executablePath: string): Promise<string> {
  if (!path.isAbsolute(executablePath) || executablePath.includes("\0")) {
    probeError("CODEX_HOST_SELECTION_INVALID");
  }
  let selectedInfo;
  let canonicalPath;
  try {
    selectedInfo = await fs.lstat(executablePath);
    canonicalPath = await fs.realpath(executablePath);
  } catch {
    probeError("CODEX_HOST_EXECUTABLE_UNSAFE");
  }
  if (
    (!selectedInfo.isFile() && !selectedInfo.isSymbolicLink()) ||
    !permittedOwner(selectedInfo.uid)
  ) {
    probeError("CODEX_HOST_EXECUTABLE_UNSAFE");
  }

  let handle;
  try {
    handle = await fs.open(
      canonicalPath,
      fsConstants.O_RDONLY | NO_FOLLOW | CLOSE_ON_EXEC,
    );
  } catch {
    probeError("CODEX_HOST_EXECUTABLE_UNSAFE");
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
      probeError("CODEX_HOST_EXECUTABLE_UNSAFE");
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
    return digest.digest("hex");
  } finally {
    await handle.close();
  }
}

async function prepareScratchRoot(root: string): Promise<void> {
  if (!path.isAbsolute(root) || root.includes("\0")) {
    probeError("CODEX_HOST_PROBE_FAILED");
  }
  try {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const info = await fs.lstat(root);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      !permittedOwner(info.uid)
    ) {
      probeError("CODEX_HOST_PROBE_FAILED");
    }
    if ((info.mode & 0o077) !== 0) await fs.chmod(root, 0o700);
  } catch (error) {
    if (error instanceof Error && error.message === "CODEX_HOST_PROBE_FAILED") {
      throw error;
    }
    probeError("CODEX_HOST_PROBE_FAILED");
  }
}

const runCodexProbe: CodexProbeRunner = async (command) =>
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

export async function probeCodexHost(
  input: Readonly<{ executablePath: string; scratchRoot: string }>,
  dependencies: ProbeDependencies = {},
): Promise<CodexHostProbe> {
  const executableSha256 = await hashSelectedExecutable(input.executablePath);
  await prepareScratchRoot(input.scratchRoot);
  const work = await fs.mkdtemp(path.join(input.scratchRoot, "probe-"));
  await fs.chmod(work, 0o700);
  const run = dependencies.run ?? runCodexProbe;
  const common = {
    executablePath: input.executablePath,
    cwd: work,
    environment: {
      PATH: `${path.dirname(input.executablePath)}:${SAFE_PATH}`,
      NO_COLOR: "1",
      TERM: "dumb",
    },
    maxBufferBytes: MAX_OUTPUT_BYTES,
  } as const;
  try {
    let versionOutput: string;
    try {
      versionOutput = (
        await run({
          ...common,
          arguments: ["--version"],
          timeoutMs: VERSION_TIMEOUT_MS,
        })
      ).stdout;
    } catch {
      probeError("CODEX_HOST_PROBE_FAILED");
    }
    const schemaRoot = path.join(work, "schema");
    try {
      await run({
        ...common,
        arguments: [
          "app-server",
          "generate-json-schema",
          "--experimental",
          "--out",
          schemaRoot,
        ],
        timeoutMs: SCHEMA_TIMEOUT_MS,
      });
    } catch {
      probeError("CODEX_HOST_PROBE_FAILED");
    }
    let contract: CodexHostContract;
    try {
      contract = await inspectCodexHostContract(schemaRoot, versionOutput);
    } catch {
      probeError("CODEX_HOST_INCOMPATIBLE");
    }
    return {
      executablePath: input.executablePath,
      executableSha256,
      ...contract,
    };
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}
