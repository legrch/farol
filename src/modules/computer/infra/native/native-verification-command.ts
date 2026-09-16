import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { TextDecoder } from "node:util";

import type {
  ReadonlyWorkspaceRequest,
  ReadonlyWorkspaceResult,
} from "../../app/port/readonly-workspace";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const XCODE_SELECT = "/usr/bin/xcode-select";
const XCRUN = "/usr/bin/xcrun";
const CODESIGN = "/usr/bin/codesign";
const MAX_OUTPUT_BYTES = 64 * 1_024;
const MAX_STDERR_BYTES = 4 * 1_024;
const COMMAND_TIMEOUT_MS = 10_000;
const O_CLOEXEC =
  (Reflect.get(fsConstants, "O_CLOEXEC") as number | undefined) ?? 0;

const REVIEWED_DEVELOPER_ROOTS = Object.freeze([
  "/Applications/Xcode.app/Contents/Developer",
  "/Library/Developer/CommandLineTools",
]);

const COMMAND_PROFILE = `(version 1)
(import "dyld-support.sb")
(deny default)
(allow process-exec (literal (param "FAROL_GIT")))
(allow process-fork)
(allow signal (target self))
(allow sysctl-read)
(allow mach-lookup)
(allow file-read*
  (subpath "/System")
  (subpath "/usr/lib")
  (subpath "/usr/share")
  (subpath "/private/etc")
  (literal "/dev/null")
  (literal "/dev/urandom")
  (subpath (param "FAROL_DEVELOPER"))
  (subpath (param "FAROL_WORKSPACE")))
(allow file-write-data
  (require-all
    (path "/dev/null")
    (vnode-type CHARACTER-DEVICE)))
(allow file-write*
  (literal "/dev/stdout")
  (literal "/dev/stderr")
  (literal "/dev/null")
  (regex #"^/dev/fd/[0-9]+$"))
(deny network*)`;

type VerificationOperation = Extract<
  ReadonlyWorkspaceRequest["operation"],
  { kind: "verification.run" }
>;

export type NativeVerificationCommandOptions = Readonly<{
  attestGit?: () => Promise<string>;
}>;

type ExactResult = Readonly<{ stdout: string; stderr: string }>;
type CommandFailureCode =
  | "WORKSPACE_COMMAND_UNSUPPORTED"
  | "WORKSPACE_COMMAND_SANDBOX_UNAVAILABLE"
  | "WORKSPACE_COMMAND_EXECUTABLE_UNTRUSTED"
  | "WORKSPACE_COMMAND_TIMEOUT"
  | "WORKSPACE_COMMAND_OUTPUT_TOO_LARGE"
  | "WORKSPACE_COMMAND_FAILED";

function failure(code: CommandFailureCode): ReadonlyWorkspaceResult {
  return { ok: false, error: { code, retry: "never" } };
}

function plainPath(value: string): boolean {
  return (
    path.isAbsolute(value) &&
    path.normalize(value) === value &&
    value !== "/" &&
    value.length <= 4_096 &&
    !/[\0\n\r"\\]/u.test(value)
  );
}

function runExact(
  executable: string,
  arguments_: readonly string[],
): Promise<ExactResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...arguments_], {
      env: { LANG: "C", LC_ALL: "C" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let finished = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), COMMAND_TIMEOUT_MS);
    const finish = (action: () => void): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      action();
    };
    const collect =
      (chunks: Buffer[]) =>
      (chunk: Buffer): void => {
        bytes += chunk.length;
        if (bytes > 16 * 1_024) child.kill("SIGKILL");
        else chunks.push(chunk);
      };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code, signal) =>
      finish(() => {
        if (code !== 0 || signal !== null || bytes > 16 * 1_024) {
          reject(new Error("reviewed executable failed"));
          return;
        }
        resolve({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
      }),
    );
  });
}

async function systemExecutable(filePath: string): Promise<void> {
  if (!plainPath(filePath)) throw new Error("invalid executable path");
  const listed = await lstat(filePath, { bigint: true });
  let handle;
  try {
    handle = await open(
      filePath,
      fsConstants.O_RDONLY | O_CLOEXEC | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const opened = await handle.stat({ bigint: true });
    if (
      listed.isSymbolicLink() ||
      !opened.isFile() ||
      listed.dev !== opened.dev ||
      listed.ino !== opened.ino ||
      opened.uid !== 0n ||
      (opened.mode & 0o022n) !== 0n ||
      (opened.mode & 0o111n) === 0n
    ) {
      throw new Error("untrusted executable");
    }
  } finally {
    await handle?.close();
  }
}

function signatureField(output: string, name: string): string | null {
  return output.match(new RegExp(`^${name}=(.+)$`, "m"))?.[1] ?? null;
}

async function attestReviewedGit(): Promise<string> {
  await systemExecutable(XCODE_SELECT);
  await systemExecutable(XCRUN);
  await systemExecutable(CODESIGN);
  await systemExecutable(SANDBOX_EXEC);
  const selected = await runExact(XCODE_SELECT, ["-p"]);
  const found = await runExact(XCRUN, ["--find", "git"]);
  if (selected.stderr !== "" || found.stderr !== "") {
    throw new Error("developer tools reported an error");
  }
  const developerRoot = selected.stdout.trim();
  const git = found.stdout.trim();
  if (
    !REVIEWED_DEVELOPER_ROOTS.includes(developerRoot) ||
    git !== `${developerRoot}/usr/bin/git`
  ) {
    throw new Error("git is outside the reviewed developer root");
  }
  await systemExecutable(git);
  const signature = await runExact(CODESIGN, ["-dv", "--verbose=4", git]);
  if (
    signatureField(signature.stderr, "Identifier") !== "com.apple.git" ||
    signatureField(signature.stderr, "TeamIdentifier") !== "59GAB85EFG"
  ) {
    throw new Error("git signature is not reviewed");
  }
  const version = await runExact(git, ["--version"]);
  if (
    version.stderr !== "" ||
    !/^git version [0-9]+\.[0-9]+\.[0-9]+ \(Apple Git-[0-9]+\)\n$/u.test(
      version.stdout,
    )
  ) {
    throw new Error("git version is not reviewed");
  }
  return git;
}

let reviewedGit: Promise<string> | undefined;

async function defaultAttestGit(): Promise<string> {
  reviewedGit ??= attestReviewedGit();
  try {
    return await reviewedGit;
  } catch (error) {
    reviewedGit = undefined;
    throw error;
  }
}

async function validateWorkspaceRoot(root: string): Promise<boolean> {
  if (!plainPath(root)) return false;
  const uid = process.getuid?.();
  if (uid === undefined) return false;
  try {
    const physical = await realpath(root);
    const listed = await lstat(root, { bigint: true });
    const gitDirectory = await lstat(path.join(root, ".git"), { bigint: true });
    return (
      physical === root &&
      !listed.isSymbolicLink() &&
      listed.isDirectory() &&
      listed.uid === BigInt(uid) &&
      (listed.mode & 0o022n) === 0n &&
      !gitDirectory.isSymbolicLink() &&
      gitDirectory.isDirectory() &&
      gitDirectory.uid === BigInt(uid) &&
      (gitDirectory.mode & 0o022n) === 0n
    );
  } catch {
    return false;
  }
}

function validDeniedPath(relative: string): boolean {
  return (
    relative.length > 0 &&
    !relative.startsWith("/") &&
    !relative.endsWith("/") &&
    !relative.includes("\\") &&
    relative
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function deniedRules(root: string, deniedPaths: readonly string[]): string {
  return deniedPaths
    .map((relative, index) => {
      if (!validDeniedPath(relative)) {
        throw new Error("invalid denied path");
      }
      const absolute = path.join(root, ...relative.split("/"));
      if (!plainPath(absolute)) throw new Error("invalid denied path");
      return `(deny file-read* (subpath (param "FAROL_DENY_${index}")))`;
    })
    .join("\n");
}

function killProcessGroup(child: ReturnType<typeof spawn>): void {
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // The fixed child can exit between the bound check and group signal.
    }
  }
  child.kill("SIGKILL");
}

function runGitStatus(
  git: string,
  root: string,
  deniedPaths: readonly string[],
): Promise<ReadonlyWorkspaceResult> {
  let profile: string;
  let parameters: string[];
  try {
    const rules = deniedRules(root, deniedPaths);
    profile = `${COMMAND_PROFILE}${rules === "" ? "" : `\n${rules}`}\n`;
    parameters = [
      "-D",
      `FAROL_GIT=${git}`,
      "-D",
      `FAROL_DEVELOPER=${path.resolve(path.dirname(git), "../..")}`,
      "-D",
      `FAROL_WORKSPACE=${root}`,
    ];
    deniedPaths.forEach((relative, index) => {
      parameters.push(
        "-D",
        `FAROL_DENY_${index}=${path.join(root, ...relative.split("/"))}`,
      );
    });
  } catch {
    return Promise.resolve(failure("WORKSPACE_COMMAND_UNSUPPORTED"));
  }

  return new Promise((resolve) => {
    const child = spawn(
      SANDBOX_EXEC,
      [
        ...parameters,
        "-p",
        profile,
        git,
        "-C",
        root,
        "-c",
        "core.attributesFile=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.excludesFile=/dev/null",
        "-c",
        "core.untrackedCache=false",
        "-c",
        "core.quotepath=true",
        "-c",
        "submodule.recurse=false",
        "status",
        "--short",
        "--branch",
        "--untracked-files=no",
        "--ignore-submodules=all",
      ],
      {
        cwd: root,
        detached: true,
        env: {
          GIT_CEILING_DIRECTORIES: root,
          GIT_ATTR_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_OPTIONAL_LOCKS: "0",
          GIT_TERMINAL_PROMPT: "0",
          HOME: "/var/empty",
          LANG: "C",
          LC_ALL: "C",
          PATH: "/usr/bin:/bin",
          TMPDIR: "/private/tmp",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let outputTooLarge = false;
    let finished = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child);
    }, COMMAND_TIMEOUT_MS);
    const finish = (result: ReadonlyWorkspaceResult): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        outputTooLarge = true;
        killProcessGroup(child);
      } else {
        stdout.push(chunk);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_STDERR_BYTES) {
        outputTooLarge = true;
        killProcessGroup(child);
      } else {
        stderr.push(chunk);
      }
    });
    child.once("error", () =>
      finish(failure("WORKSPACE_COMMAND_SANDBOX_UNAVAILABLE")),
    );
    child.once("close", (code, signal) => {
      if (timedOut) {
        finish(failure("WORKSPACE_COMMAND_TIMEOUT"));
        return;
      }
      if (outputTooLarge) {
        finish(failure("WORKSPACE_COMMAND_OUTPUT_TOO_LARGE"));
        return;
      }
      const errorText = Buffer.concat(stderr).toString("utf8");
      if (/^sandbox-exec: sandbox_apply:/mu.test(errorText)) {
        finish(failure("WORKSPACE_COMMAND_SANDBOX_UNAVAILABLE"));
        return;
      }
      if (code !== 0 || signal !== null || errorText !== "") {
        finish(failure("WORKSPACE_COMMAND_FAILED"));
        return;
      }
      try {
        const output = new TextDecoder("utf-8", { fatal: true }).decode(
          Buffer.concat(stdout),
        );
        if (output.includes("\0")) {
          finish(failure("WORKSPACE_COMMAND_FAILED"));
          return;
        }
        finish({
          ok: true,
          value: {
            kind: "workspace.command",
            command: "git.status",
            relativePath: ".",
            exitCode: 0,
            stdout: output,
            stderr: "",
            outputBytes: stdoutBytes,
            network: "none",
          },
        });
      } catch {
        finish(failure("WORKSPACE_COMMAND_FAILED"));
      }
    });
  });
}

export async function executeNativeVerificationCommand(
  request: ReadonlyWorkspaceRequest,
  operation: VerificationOperation,
  options: NativeVerificationCommandOptions = {},
): Promise<ReadonlyWorkspaceResult> {
  if (
    operation.command !== "git.status" ||
    operation.relativePath !== "." ||
    !(await validateWorkspaceRoot(request.workspace.root))
  ) {
    return failure("WORKSPACE_COMMAND_UNSUPPORTED");
  }
  let git: string;
  try {
    git = await (options.attestGit ?? defaultAttestGit)();
    if (!plainPath(git)) throw new Error("invalid git path");
  } catch {
    return failure("WORKSPACE_COMMAND_EXECUTABLE_UNTRUSTED");
  }
  return runGitStatus(
    git,
    request.workspace.root,
    request.workspace.deniedPaths,
  );
}
