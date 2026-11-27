import { spawn, execFile } from "node:child_process";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import type { Readable, Writable } from "node:stream";
import path from "node:path";
import { promisify } from "node:util";
import {
  CONTINUE_SCHEMA,
  MAX_CHANNEL_BYTES,
  correlation,
  parseHandoff,
  parseTerminal,
  type InstalledUpdateCompletion,
  type InstalledUpdateHandoff,
} from "./handoff";
import {
  assertInput,
  sha,
  validInode,
  type InstalledAppLocation,
  type InstalledUpdateFields,
  type InstalledUpdateRequest,
  type PromotionLeaseTransfer,
} from "./request";
import {
  installedSlotBindingBytes,
  type InstalledBoundOperation,
} from "./binding";

export type {
  AcceptedInstalledBuild,
  ConfirmedClosedPredecessor,
  InstalledAppLocation,
  InstalledUpdateInode,
  InstalledUpdateRequest,
  PromotionLeaseTransfer,
} from "./request";
export type {
  InstalledUpdateCompletion,
  InstalledUpdateHandoff,
} from "./handoff";
export {
  INSTALLED_SLOT_BINDING_FILE,
  installedSlotBindingBytes,
  type InstalledBoundOperation,
} from "./binding";

const APP_NAME = "Farol.app";
const execFileAsync = promisify(execFile);

/** Private host custody; no updater lease, authority or renderer input. */
export interface InstalledHelperLifetime {
  available(): boolean;
  retain(
    request: InstalledUpdateRequest,
    helper: Readonly<{ pid: number; processStart: string }>,
    deadlineAt: number,
  ): Promise<void>;
}

/** Capture once while the exact installed app process is still alive. */
export async function captureInstalledProcessStart(
  pid: number,
): Promise<string> {
  if (!Number.isSafeInteger(pid) || pid <= 1)
    throw new Error("INSTALLED_UPDATE_PID_INVALID");
  const { stdout, stderr } = await execFileAsync(
    "/bin/ps",
    ["-p", String(pid), "-o", "lstart="],
    {
      timeout: 3000,
      maxBuffer: 4096,
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    },
  );
  if (stderr || !stdout.trim()) throw new Error("INSTALLED_UPDATE_PID_UNKNOWN");
  return stdout.trim();
}

export interface InstalledUpdateOperation {
  readonly operationId: string;
  readonly pid: number | null;
  readonly completion: Promise<InstalledUpdateCompletion>;
  observe(): Readonly<{
    handoff: InstalledUpdateHandoff | null;
    exit: InstalledUpdateCompletion | null;
    protocolError: string | null;
  }>;
}

type QuitEffectRefusal = "quit_deadline_expired" | "quit_effect_not_allowed";

/**
 * The attested Go release helper: `farol-backend` from an immutable execution
 * image. `qualify` re-measures the executable against the build's compiled
 * declaration inside the caller's effect fence and returns its absolute path.
 * `remeasure` repeats only the image and executable measurement, without the
 * fence, for the check after the child has closed: by then a normal-Quit
 * fence has ended, and its refusal is not evidence of drift. It is the trusted
 * host's adapter, never renderer data. There is no interpreter alternative.
 */
export interface InstalledGoUpdateHelper {
  readonly buildId: string;
  qualify(): Promise<string>;
  remeasure(): Promise<string>;
}

/**
 * Closed outcome of selecting the update helper. A build without a compiled Go
 * core no longer updates, and a Go capability that cannot be selected refuses;
 * neither ever falls back to the retired Python helper.
 */
export type InstalledUpdateHelperSelection =
  | Readonly<{ kind: "go"; helper: InstalledGoUpdateHelper }>
  | Readonly<{
      kind: "refused";
      reason: "helper_go_core_required" | "helper_preflight_failed";
    }>;

const GO_LIVE_HELPER_MODE = "run-live-release-helper";
const GO_CLOSED_HELPER_MODE = "run-closed-release-helper";

export type InstalledUpdateLaunch =
  | Readonly<{
      status: "not_started";
      reason:
        | "helper_spawn_failed"
        | "helper_preflight_failed"
        | "helper_go_core_required"
        | "owner_home_invalid"
        | "promotion_lease_unconfirmed"
        | "spawn_record_required"
        | "helper_lifetime_unavailable"
        | QuitEffectRefusal;
      operation: InstalledUpdateOperation;
    }>
  | Readonly<{ status: "ready"; operation: InstalledUpdateOperation }>
  // The transfer was released and one continue frame was written. Completion,
  // not this result, reports whether the closed apply/rollback actually finished.
  | Readonly<{ status: "continued"; operation: InstalledUpdateOperation }>
  | Readonly<{
      status: "refused";
      reason: string;
      operation: InstalledUpdateOperation;
    }>
  | Readonly<{
      status: "outcome_unknown";
      reason: string;
      operation: InstalledUpdateOperation;
    }>
  | Readonly<{
      status: "terminal";
      operation: InstalledUpdateOperation;
      result: InstalledUpdateCompletion;
    }>;

/**
 * Spawns the attested Go release helper: `run-closed-release-helper` when a
 * promotion lease is transferred, otherwise `run-live-release-helper`.
 * Only `ready` authorizes normal Quit for apply/rollback or live recover. Every post-spawn
 * outcome retains the same child via its observation/completion handle.
 * Closed apply/rollback use their explicit transfer barrier and never grant live-app Quit.
 * The Go live helper relaunches after a recover and has no offline recover mode,
 * so an offline recover is refused by the helper, not simulated here.
 */
export async function startInstalledUpdateHelper(
  selection: InstalledUpdateHelperSelection,
  input: InstalledUpdateRequest,
  options: Readonly<{
    readinessTimeoutMs?: number;
    /** Original normal-Quit budget; both options are required together. */
    deadlineAt?: number;
    canStartEffect?(): boolean;
    promotionLease?: PromotionLeaseTransfer;
    lifetime?: InstalledHelperLifetime;
    // The application records this actual handle before any helper program or
    // operation bytes are sent. Failure remains an observed, unknown launch.
    recordSpawn?(operation: InstalledUpdateOperation): Promise<void>;
  }> = {},
): Promise<InstalledUpdateLaunch> {
  assertInput(input);
  const deadlineAt = options.deadlineAt;
  const selectedCanStartEffect = options.canStartEffect;
  if (
    (deadlineAt !== undefined) !== (selectedCanStartEffect !== undefined) ||
    (deadlineAt !== undefined &&
      (!Number.isSafeInteger(deadlineAt) ||
        deadlineAt <= 0 ||
        typeof selectedCanStartEffect !== "function" ||
        input.relaunch))
  )
    throw new Error("INSTALLED_UPDATE_QUIT_CONTEXT_INVALID");
  const canStartEffect = selectedCanStartEffect?.bind(options);
  const readinessTimeoutMs = options.readinessTimeoutMs ?? 180_000;
  if (
    !Number.isSafeInteger(readinessTimeoutMs) ||
    readinessTimeoutMs < 1 ||
    readinessTimeoutMs > 300_000
  ) {
    throw new Error("INSTALLED_UPDATE_READINESS_DEADLINE_INVALID");
  }
  const readinessDeadlineAt =
    deadlineAt === undefined
      ? undefined
      : Math.min(deadlineAt, Date.now() + readinessTimeoutMs);
  const lifetimeDeadlineAt =
    readinessDeadlineAt ?? Date.now() + readinessTimeoutMs;
  const waitBudgetMs = (): number =>
    readinessDeadlineAt === undefined
      ? readinessTimeoutMs
      : Math.max(0, readinessDeadlineAt - Date.now());
  const effectRefusal = (): QuitEffectRefusal | null => {
    if (deadlineAt === undefined || !canStartEffect) return null;
    if (Date.now() >= deadlineAt) return "quit_deadline_expired";
    try {
      if (canStartEffect() !== true) return "quit_effect_not_allowed";
    } catch {
      return "quit_effect_not_allowed";
    }
    return Date.now() >= deadlineAt ? "quit_deadline_expired" : null;
  };
  let preflightRefusal: QuitEffectRefusal | null = null;
  const checkPreflight = (): void => {
    const reason = effectRefusal();
    if (reason) {
      preflightRefusal = reason;
      throw new Error(reason);
    }
  };
  // Pin the request before asynchronous preflight; later caller mutation cannot
  // change either the bytes sent or the identity expected in the acknowledgment.
  const fields: InstalledUpdateFields = {
    ...(input.relaunchPresentation !== undefined
      ? { relaunchPresentation: input.relaunchPresentation }
      : {}),
    ...(input.installLocation !== undefined
      ? { installLocation: input.installLocation }
      : {}),
    operationId: input.operationId,
    source: { ...input.source },
    target: { ...input.target },
    drain: { ...input.drain },
    pid: input.pid,
    processStart: input.processStart,
    waitSeconds: input.waitSeconds,
    relaunch: input.relaunch,
  };
  const pinned: InstalledUpdateRequest = input.predecessor
    ? input.action === "rollback"
      ? {
          ...fields,
          action: "rollback",
          relaunch: false,
          predecessor: {
            ...input.predecessor,
            stateIdentity: { ...input.predecessor.stateIdentity },
          },
        }
      : {
          ...fields,
          action: "apply",
          predecessor: {
            ...input.predecessor,
            stateIdentity: { ...input.predecessor.stateIdentity },
          },
        }
    : { ...fields, action: input.action };
  const selectedLease = options.promotionLease;
  const lease = selectedLease
    ? {
        descriptor: selectedLease.descriptor,
        identity: { ...selectedLease.identity },
        verify: selectedLease.verify.bind(selectedLease),
        release: selectedLease.release.bind(selectedLease),
      }
    : null;
  const beforeSpawn = (
    reason:
      | "helper_preflight_failed"
      | "helper_go_core_required"
      | "owner_home_invalid"
      | "promotion_lease_unconfirmed"
      | "spawn_record_required"
      | "helper_lifetime_unavailable"
      | QuitEffectRefusal,
  ): InstalledUpdateLaunch => {
    // This receipt explicitly has no process and no process exit code. It is
    // created only on the preflight side of the spawn boundary.
    const result: InstalledUpdateCompletion = {
      code: null,
      signal: null,
      terminal: null,
      protocolError: reason,
    };
    return {
      status: "not_started",
      reason,
      operation: {
        operationId: pinned.operationId,
        pid: null,
        completion: Promise.resolve(result),
        observe: () => ({ handoff: null, exit: result, protocolError: reason }),
      },
    };
  };
  const initialRefusal = effectRefusal();
  if (initialRefusal) return beforeSpawn(initialRefusal);
  if (options.lifetime && !options.lifetime.available())
    return beforeSpawn("helper_lifetime_unavailable");
  if (options.lifetime && !options.recordSpawn)
    return beforeSpawn("spawn_record_required");
  // A legacy build, or a Go capability the host could not select, starts no
  // process at all. The retired interpreter is never an alternative.
  if (selection.kind === "refused") return beforeSpawn(selection.reason);
  const goHelper = selection.helper;
  if (
    Boolean(pinned.predecessor) !== Boolean(lease) ||
    (lease &&
      (!Number.isSafeInteger(lease.descriptor) ||
        lease.descriptor < 3 ||
        !validInode(lease.identity)))
  )
    return beforeSpawn("promotion_lease_unconfirmed");
  if (lease && !options.recordSpawn)
    return beforeSpawn("spawn_record_required");
  if (lease) {
    // This read-only preflight may itself lose its reply. No child exists yet.
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const verified = await Promise.race([
        lease.verify(),
        new Promise<false>((resolve) => {
          deadline = setTimeout(() => resolve(false), waitBudgetMs());
        }),
      ]);
      checkPreflight();
      if (verified !== true) return beforeSpawn("promotion_lease_unconfirmed");
    } catch {
      return beforeSpawn(preflightRefusal ?? "promotion_lease_unconfirmed");
    } finally {
      clearTimeout(deadline);
    }
  }
  let executable: string;
  try {
    checkPreflight();
    executable = await goHelper.qualify();
    checkPreflight();
    if (
      typeof executable !== "string" ||
      !path.isAbsolute(executable) ||
      path.normalize(executable) !== executable ||
      !sha.test(goHelper.buildId)
    )
      throw new Error("INSTALLED_UPDATE_HELPER_INVALID");
  } catch {
    return beforeSpawn(preflightRefusal ?? "helper_preflight_failed");
  }
  let user: os.UserInfo<string>;
  try {
    user = os.userInfo();
    if (
      user.uid !== process.geteuid?.() ||
      !path.isAbsolute(user.homedir) ||
      path.normalize(user.homedir) !== user.homedir
    )
      return beforeSpawn("owner_home_invalid");
  } catch {
    return beforeSpawn("owner_home_invalid");
  }
  const request = {
    schema: "farol.installed-update/1",
    ...pinned,
    home: user.homedir,
    ...(lease ? { leaseIdentity: lease.identity } : {}),
  };
  const spawnRefusal = effectRefusal();
  if (spawnRefusal) return beforeSpawn(spawnRefusal);
  // fd3 request, fd4 ACK, fd5 borrowed promotion lease, fd6 continuation; fd1
  // carries the one terminal line. Stdin and stderr carry nothing.
  const child = spawn(
    executable,
    [lease ? GO_CLOSED_HELPER_MODE : GO_LIVE_HELPER_MODE],
    {
      cwd: "/",
      env: { LANG: "C.UTF-8", PATH: "/usr/bin:/bin" },
      detached: true,
      stdio: lease
        ? ["ignore", "pipe", "ignore", "pipe", "pipe", lease.descriptor, "pipe"]
        : ["ignore", "pipe", "ignore", "pipe", "pipe"],
    },
  );
  let handoff: InstalledUpdateHandoff | null = null;
  let exit: InstalledUpdateCompletion | null = null;
  let protocolError: string | null = null;
  let resolveCompletion!: (result: InstalledUpdateCompletion) => void;
  const completion = new Promise<InstalledUpdateCompletion>((resolve) => {
    resolveCompletion = resolve;
  });
  const operation: InstalledUpdateOperation = {
    operationId: pinned.operationId,
    get pid() {
      return child.pid ?? null;
    },
    completion,
    observe: () => ({ handoff, exit, protocolError }),
  };
  let resolveLaunch!: (result: InstalledUpdateLaunch) => void;
  const launched = new Promise<InstalledUpdateLaunch>((resolve) => {
    resolveLaunch = resolve;
  });
  let settled = false;
  let spawned = false;
  let spawnFailed = false;
  let requestSent = false;
  let transferStarted = false;
  let continueSent = false;
  let continueWritten = false;
  const continuePipe = lease
    ? (child.stdio.at(6) as Writable | null | undefined)
    : null;
  const detach = (): void => {
    child.unref();
    for (const pipe of child.stdio)
      (pipe as { unref?: () => void } | null)?.unref?.();
  };
  const finish = (result: InstalledUpdateLaunch): void => {
    if (settled) return;
    settled = true;
    if (!requestSent) {
      // The helper has received no request. Closing only our pipe lets it exit
      // without executing an install; retain its handle for terminal readback.
      (child.stdio[3] as Writable | null)?.destroy();
    }
    if (lease && result.status !== "continued" && result.status !== "terminal")
      continuePipe?.destroy();
    clearTimeout(timer);
    detach();
    resolveLaunch(result);
  };
  const unknown = (reason: string): void => {
    protocolError ??= reason;
    finish({ status: "outcome_unknown", reason, operation });
  };
  const canSendEffect = (): boolean => {
    if (settled) return false;
    if (options.lifetime && Date.now() >= lifetimeDeadlineAt) {
      unknown("helper_lifetime_deadline_expired");
      return false;
    }
    const reason = effectRefusal();
    if (reason) {
      unknown(reason);
      return false;
    }
    return true;
  };
  const finishClosedTransfer = (): void => {
    if (!continueWritten || settled) return;
    if (exit) {
      if (
        exit.code === 0 &&
        !exit.signal &&
        !exit.protocolError &&
        exit.terminal &&
        exit.terminal.error === null &&
        (pinned.action === "rollback"
          ? exit.terminal.phase === "rolled_back"
          : ["verified", "completed"].includes(exit.terminal.phase))
      )
        finish({ status: "terminal", operation, result: exit });
      else
        unknown(
          pinned.action === "rollback"
            ? "closed_rollback_terminal_unconfirmed"
            : "closed_apply_terminal_unconfirmed",
        );
    } else finish({ status: "continued", operation });
  };
  const transfer = async (): Promise<void> => {
    if (settled || transferStarted || !lease) return;
    if (!canSendEffect()) return;
    if (!requestSent) {
      unknown("readiness_before_request");
      return;
    }
    transferStarted = true;
    try {
      const verified = await lease.verify();
      if (!canSendEffect()) return;
      if (verified !== true) {
        unknown("promotion_lease_unconfirmed");
        return;
      }
    } catch {
      unknown("promotion_lease_unconfirmed");
      return;
    }
    if (!canSendEffect()) return;
    try {
      await lease.release();
    } catch {
      unknown("promotion_lease_release_unknown");
      return;
    }
    // A late release reply after timeout never opens the mutation barrier.
    if (!canSendEffect()) return;
    if (!continuePipe) {
      unknown("continue_channel_missing");
      return;
    }
    const frame =
      JSON.stringify({
        schema: CONTINUE_SCHEMA,
        ...correlation(pinned, lease.identity),
      }) + "\n";
    if (Buffer.byteLength(frame) > MAX_CHANNEL_BYTES) {
      unknown("continue_oversized");
      return;
    }
    if (!canSendEffect()) return;
    continueSent = true;
    try {
      continuePipe.end(frame, (error?: Error | null) => {
        if (settled) return;
        if (error) {
          unknown("continue_write_unknown");
          return;
        }
        continueWritten = true;
        finishClosedTransfer();
      });
    } catch {
      unknown("continue_write_unknown");
    }
  };
  const timer = setTimeout(
    () => unknown(effectRefusal() ?? "readiness_timeout"),
    waitBudgetMs(),
  );
  const ack = child.stdio[4] as Readable | null;
  const ackChunks: Buffer[] = [];
  const outputChunks: Buffer[] = [];
  let ackBytes = 0;
  let outputBytes = 0;
  let ackEnded = false;
  let ackInvalid = false;
  child.stdout?.on("data", (chunk: Buffer) => {
    outputBytes += chunk.length;
    if (outputBytes > MAX_CHANNEL_BYTES) {
      unknown("terminal_output_oversized");
      return;
    }
    outputChunks.push(chunk);
  });
  child.stdout?.on("error", () => unknown("terminal_channel_error"));
  ack?.on("data", (chunk: Buffer) => {
    ackBytes += chunk.length;
    if (ackBytes > MAX_CHANNEL_BYTES) {
      ackInvalid = true;
      unknown("readiness_oversized");
      return;
    }
    ackChunks.push(chunk);
  });
  ack?.on("error", () => {
    ackInvalid = true;
    unknown("readiness_channel_error");
  });
  ack?.on("end", () => {
    ackEnded = true;
    if (ackInvalid || ackBytes === 0) return;
    handoff = parseHandoff(Buffer.concat(ackChunks), pinned, lease?.identity);
    if (!handoff) {
      unknown("readiness_malformed");
      return;
    }
    if (handoff.phase === "refused")
      finish({ status: "refused", reason: handoff.error, operation });
    else if (handoff.phase === "closed_predecessor_ready") void transfer();
    else if (canSendEffect()) finish({ status: "ready", operation });
  });
  ack?.on("close", () => {
    if (!ackEnded && !spawnFailed) unknown("readiness_channel_closed");
  });
  child.once("error", (error: NodeJS.ErrnoException) => {
    if (
      !spawned &&
      child.pid === undefined &&
      error.syscall === `spawn ${executable}` &&
      [
        "ENOENT",
        "EACCES",
        "EPERM",
        "ENOEXEC",
        "ENOMEM",
        "EAGAIN",
        "EMFILE",
        "ENFILE",
      ].includes(error.code ?? "")
    ) {
      // Node emitted an exec failure before the spawn event. No request bytes
      // have been written. Still require terminal channel closure.
      spawnFailed = true;
    } else unknown("helper_process_error");
  });
  const handleClose = (
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void => {
    if (
      spawnFailed &&
      !spawned &&
      child.pid === undefined &&
      code !== null &&
      code < 0 &&
      signal === null &&
      ackBytes === 0 &&
      outputBytes === 0 &&
      !handoff &&
      !protocolError
    ) {
      exit = {
        code,
        signal,
        terminal: null,
        protocolError: "helper_spawn_failed",
      };
      resolveCompletion(exit);
      finish({
        status: "not_started",
        reason: "helper_spawn_failed",
        operation,
      });
      return;
    }
    const terminal =
      outputBytes <= MAX_CHANNEL_BYTES
        ? parseTerminal(Buffer.concat(outputChunks), pinned.operationId)
        : null;
    exit = {
      code,
      signal,
      terminal,
      protocolError:
        protocolError ?? (terminal ? null : "terminal_output_invalid"),
    };
    resolveCompletion(exit);
    if (lease) {
      if (continueWritten) finishClosedTransfer();
      else if (!continueSent && !settled)
        unknown("helper_exited_before_continue");
      // An immediate terminal can race the stream's write callback. That
      // callback or the original deadline settles the same transfer once.
    } else if (
      pinned.action === "recover" &&
      !pinned.relaunch &&
      code === 0 &&
      !signal &&
      terminal &&
      terminal.error === null &&
      !protocolError
    ) {
      finish({ status: "terminal", operation, result: exit });
    } else if (!settled) unknown("helper_exited_before_readiness");
  };
  child.once("close", (code, signal) => {
    void (async () => {
      // The image the child ran must still be the attested one after its exit,
      // or its terminal line cannot be trusted. An exec that never started has
      // nothing to re-measure. This is a measurement, not an effect, so it
      // runs outside the effect fence that may have ended with the Quit.
      if (spawned) {
        let unchanged = false;
        try {
          unchanged = (await goHelper.remeasure()) === executable;
        } catch {
          unchanged = false;
        }
        if (!unchanged) protocolError ??= "helper_executable_changed";
      }
      handleClose(code, signal);
    })();
  });
  const write = (stream: Writable | null, data: Buffer | string): boolean => {
    if (!canSendEffect()) return false;
    if (!stream) {
      unknown("request_channel_missing");
      return false;
    }
    stream.once("error", () => unknown("request_channel_error"));
    stream.end(data);
    return true;
  };
  const sendRequest = () => {
    if (!canSendEffect()) return;
    requestSent = write(
      child.stdio[3] as Writable | null,
      JSON.stringify(request),
    );
  };
  child.once("spawn", () => {
    spawned = true;
    if (!options.recordSpawn && !lease && !options.lifetime) {
      sendRequest();
      return;
    }
    void (async () => {
      try {
        if (options.recordSpawn) await options.recordSpawn(operation);
      } catch {
        unknown("spawn_record_failed");
        return;
      }
      try {
        if (options.lifetime) {
          if (!canSendEffect() || child.pid === undefined) return;
          const processStart = await captureInstalledProcessStart(child.pid);
          if (!canSendEffect()) return;
          await options.lifetime.retain(
            pinned,
            { pid: child.pid, processStart },
            lifetimeDeadlineAt,
          );
        }
      } catch {
        unknown("helper_lifetime_unknown");
        return;
      }
      if (!canSendEffect()) return;
      if (lease) {
        try {
          const verified = await lease.verify();
          if (!canSendEffect()) return;
          if (verified !== true) {
            unknown("promotion_lease_unconfirmed");
            return;
          }
        } catch {
          unknown("promotion_lease_unconfirmed");
          return;
        }
      }
      sendRequest();
    })();
  });
  continuePipe?.on("error", () => unknown("continue_write_unknown"));
  continuePipe?.on("close", () => {
    if (!continueWritten && !settled) unknown("continue_channel_closed");
  });
  if (lease && !continuePipe) unknown("continue_channel_missing");
  if (!ack || !child.stdout) unknown("readiness_channel_missing");
  return launched;
}

/** Select only the trusted running resources directory, without filesystem guessing. */
export function installedFarolSlot(resourcesDirectory?: string): string {
  const user = os.userInfo();
  if (
    user.uid !== process.geteuid?.() ||
    !path.isAbsolute(user.homedir) ||
    path.normalize(user.homedir) !== user.homedir ||
    user.homedir === "/"
  )
    throw new Error("INSTALLED_UPDATE_SLOT_INVALID");
  const legacy = path.join(user.homedir, "Applications", APP_NAME);
  if (resourcesDirectory === undefined) return legacy;
  for (const slot of ["/Applications/Farol.app", legacy])
    if (resourcesDirectory === path.join(slot, "Contents/Resources/app"))
      return slot;
  throw new Error("INSTALLED_UPDATE_SLOT_INVALID");
}

export interface InstalledGoSlotBindingHelper {
  readonly buildId: string;
  // Trusted host resource attestation, never a renderer path or fresh hash.
  // Caller retains the accepted immutable image through original-child close.
  qualify(): Promise<string>;
}

export async function publishInstalledOperationBinding(
  go: InstalledGoSlotBindingHelper,
  operation: InstalledBoundOperation,
  installLocation: InstalledAppLocation,
  beforeEffect: () => void = () => undefined,
): Promise<void> {
  const bytes = installedSlotBindingBytes(operation, installLocation);
  const home = os.userInfo();
  if (
    home.uid !== process.geteuid?.() ||
    !path.isAbsolute(home.homedir) ||
    path.normalize(home.homedir) !== home.homedir
  )
    throw new Error("UPDATE_SLOT_BINDING_INVALID");
  const root = path.join(
    home.homedir,
    "Library/Application Support/io.github.legrch.farol/installed-updates",
  );
  const directory = path.join(root, operation.operationId);
  const safeDirectory = async (file: string) => {
    const info = await fs.lstat(file, { bigint: true });
    if (
      !info.isDirectory() ||
      info.uid !== BigInt(home.uid) ||
      (info.mode & 0o077n) !== 0n ||
      (await fs.realpath(file)) !== file
    )
      throw new Error("UPDATE_SLOT_BINDING_INVALID");
    return info;
  };
  beforeEffect();
  const parent = await safeDirectory(root);
  const before = await safeDirectory(directory);
  const fd = await fs.open(
    directory,
    constants.O_RDONLY |
      constants.O_DIRECTORY |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK,
  );
  try {
    const opened = await fd.stat({ bigint: true });
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.mode !== before.mode ||
      opened.uid !== before.uid
    )
      throw new Error("UPDATE_SLOT_BINDING_INVALID");
    const recheck = async () => {
      const named = await safeDirectory(directory);
      const liveParent = await safeDirectory(root);
      if (
        named.dev !== opened.dev ||
        named.ino !== opened.ino ||
        named.mode !== opened.mode ||
        liveParent.dev !== parent.dev ||
        liveParent.ino !== parent.ino ||
        liveParent.mode !== parent.mode
      )
        throw new Error("UPDATE_SLOT_BINDING_CHANGED");
    };
    // The attested Go publisher is the only one; a failed attestation or
    // execution refuses and never reaches a Python helper.
    const executable = await go.qualify();
    if (
      !path.isAbsolute(executable) ||
      path.normalize(executable) !== executable ||
      !sha.test(go.buildId)
    )
      throw new Error("UPDATE_SLOT_BINDING_INVALID");
    await recheck();
    beforeEffect();
    // Inherit only the pinned operation directory; all writes occur relative to fd4.
    const child = spawn(
      executable,
      ["publish-installed-slot-binding", "--build-id", go.buildId],
      {
        cwd: "/",
        env: { LANG: "C.UTF-8", PATH: "/usr/bin:/bin" },
        stdio: ["pipe", "pipe", "pipe", "pipe", fd.fd],
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let failure: unknown;
    let outputBytes = 0;
    const closed = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => {
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    let stopRequested = false;
    const stop = (error: unknown) => {
      failure ??= error;
      if (stopRequested) return;
      stopRequested = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* retain original close */
      }
    };
    child.once("error", stop);
    for (const stream of [
      child.stdin,
      child.stdout,
      child.stderr,
      child.stdio[3],
    ])
      stream?.on("error", stop);
    for (const [stream, chunks] of [
      [child.stdout, stdout],
      [child.stderr, stderr],
    ] as const)
      stream?.on("data", (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > 4096)
          stop(new Error("UPDATE_SLOT_BINDING_UNCONFIRMED"));
        else chunks.push(chunk);
      });
    const deadline = setTimeout(
      () => stop(new Error("UPDATE_SLOT_BINDING_UNCONFIRMED")),
      5000,
    );
    try {
      beforeEffect();
      child.stdin!.end();
      (child.stdio[3] as Writable).end(bytes);
    } catch (error) {
      stop(error);
    }
    // A timeout/kill request never substitutes for this exact child's terminal proof.
    const result = await closed.finally(() => clearTimeout(deadline));
    if (
      failure ||
      result.code !== 0 ||
      result.signal !== null ||
      Buffer.concat(stderr).length !== 0 ||
      Buffer.concat(stdout).toString() !== "SLOT_BINDING_OK\n"
    )
      throw new Error("UPDATE_SLOT_BINDING_UNCONFIRMED");
    if ((await go.qualify()) !== executable)
      throw new Error("UPDATE_SLOT_BINDING_UNCONFIRMED");
    await recheck();
    beforeEffect();
  } finally {
    await fd.close();
  }
}
