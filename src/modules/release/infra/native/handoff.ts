import type {
  AcceptedInstalledBuild,
  InstalledUpdateInode,
  InstalledUpdateRequest,
} from "./request";

export type InstalledUpdateHandoff =
  | Readonly<{ phase: "waiting_for_exit" }>
  | Readonly<{ phase: "closed_predecessor_ready" }>
  | Readonly<{ phase: "refused"; error: string }>;

export interface InstalledUpdateCompletion {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly terminal: Readonly<{ phase: string; error: string | null }> | null;
  readonly protocolError: string | null;
}

export const MAX_CHANNEL_BYTES = 4096;
export const HANDOFF_SCHEMA = "farol.installed-update-handoff/1";
export const CONTINUE_SCHEMA = "farol.installed-update-continue/1";

export function correlation(
  input: InstalledUpdateRequest,
  lease?: InstalledUpdateInode,
) {
  return {
    operationId: input.operationId,
    action: input.action,
    source: input.source,
    target: input.target,
    pid: input.pid,
    processStart: input.processStart,
    ...(input.relaunchPresentation !== undefined
      ? { relaunchPresentation: input.relaunchPresentation }
      : {}),
    ...(input.predecessor
      ? { predecessor: input.predecessor, leaseIdentity: lease }
      : {}),
  };
}

function sameInode(value: unknown, expected: InstalledUpdateInode): boolean {
  const record = object(value);
  return (
    record !== null &&
    Object.keys(record).length === 2 &&
    record["device"] === expected.device &&
    record["inode"] === expected.inode
  );
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function sameBuild(value: unknown, expected: AcceptedInstalledBuild): boolean {
  const record = object(value);
  return (
    record !== null &&
    Object.keys(record).length === 3 &&
    record["digest"] === expected.digest &&
    record["version"] === expected.version &&
    record["buildId"] === expected.buildId
  );
}

export function parseHandoff(
  bytes: Buffer,
  expected: InstalledUpdateRequest,
  lease?: InstalledUpdateInode,
): InstalledUpdateHandoff | null {
  try {
    const event = object(JSON.parse(bytes.toString("utf8")));
    if (
      !event ||
      event["schema"] !== HANDOFF_SCHEMA ||
      event["operationId"] !== expected.operationId ||
      event["action"] !== expected.action ||
      event["pid"] !== expected.pid ||
      event["processStart"] !== expected.processStart ||
      event["relaunchPresentation"] !== expected.relaunchPresentation ||
      !sameBuild(event["source"], expected.source) ||
      !sameBuild(event["target"], expected.target)
    )
      return null;
    const closed = expected.predecessor;
    if (closed) {
      const proof = object(event["predecessor"]);
      if (
        !lease ||
        !sameInode(event["leaseIdentity"], lease) ||
        !proof ||
        Object.keys(proof).length !== 4 ||
        proof["kind"] !== closed.kind ||
        proof["startedAt"] !== closed.startedAt ||
        proof["lastQuitSha256"] !== closed.lastQuitSha256 ||
        !sameInode(proof["stateIdentity"], closed.stateIdentity)
      )
        return null;
      if (
        event["phase"] === "closed_predecessor_ready" &&
        Object.keys(event).length ===
          10 + (expected.relaunchPresentation ? 1 : 0)
      )
        return { phase: "closed_predecessor_ready" };
    }
    if (
      event["phase"] === "waiting_for_exit" &&
      !closed &&
      (expected.action !== "recover" || expected.relaunch) &&
      Object.keys(event).length === 8 + (expected.relaunchPresentation ? 1 : 0)
    ) {
      return { phase: "waiting_for_exit" };
    }
    if (
      event["phase"] === "refused" &&
      Object.keys(event).length ===
        (closed ? 11 : 9) + (expected.relaunchPresentation ? 1 : 0) &&
      typeof event["error"] === "string" &&
      /^[a-z][a-z0-9_]{0,79}$/u.test(event["error"])
    ) {
      return { phase: "refused", error: event["error"] };
    }
  } catch {
    /* Invalid or multiple frames never authorize Quit. */
  }
  return null;
}

export function parseTerminal(
  bytes: Buffer,
  operationId: string,
): InstalledUpdateCompletion["terminal"] {
  try {
    const record = object(JSON.parse(bytes.toString("utf8")));
    if (
      !record ||
      record["operationId"] !== operationId ||
      typeof record["phase"] !== "string" ||
      !/^[a-z_]{1,40}$/u.test(record["phase"])
    )
      return null;
    if (Object.keys(record).length === 2)
      return { phase: record["phase"], error: null };
    if (
      Object.keys(record).length === 3 &&
      typeof record["error"] === "string" &&
      /^[a-z][a-z0-9_]{0,79}$/u.test(record["error"])
    ) {
      return { phase: record["phase"], error: record["error"] };
    }
  } catch {
    /* The journal remains authoritative when terminal output is unknown. */
  }
  return null;
}
