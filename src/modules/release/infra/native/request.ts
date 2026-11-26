import { legacyPredecessorRequiresStateRecovery } from "../../domain/predecessor-state";

export const sha = /^[0-9a-f]{64}$/u;

export interface AcceptedInstalledBuild {
  readonly digest: string;
  readonly version: string;
  readonly buildId: string;
}

export interface InstalledUpdateInode {
  readonly device: string;
  readonly inode: string;
}

export interface ConfirmedClosedPredecessor {
  /** Exact current process closure: source for apply, installed target for rollback. */
  readonly kind: "confirmed_closed";
  readonly startedAt: string;
  readonly lastQuitSha256: string;
  readonly stateIdentity: InstalledUpdateInode;
}

export interface PromotionLeaseTransfer {
  readonly descriptor: number;
  readonly identity: InstalledUpdateInode;
  /** Confirm this exact descriptor still owns the exclusive promotion lease. */
  verify(): Promise<boolean>;
  /** One shot: close the parent's descriptor only. Never LOCK_UN the shared lock. */
  release(): Promise<void>;
}

export type InstalledAppLocation = "shared" | "legacy";

export interface InstalledUpdateFields {
  readonly installLocation?: InstalledAppLocation;
  readonly operationId: string;
  readonly source: AcceptedInstalledBuild;
  readonly target: AcceptedInstalledBuild;
  /** Lead has reconciled all active work and the existing promotion obligations. */
  readonly drain: {
    readonly status: "reconciled";
    readonly acceptedSource: string;
    readonly acceptedTarget: string;
  };
  readonly pid: number;
  readonly processStart: string;
  readonly waitSeconds: number;
  readonly relaunch: boolean;
  /** Closed presentation selection from the trusted desktop, never renderer data. */
  readonly relaunchPresentation?: "sidecar-only";
}

export type InstalledUpdateRequest = InstalledUpdateFields &
  (
    | Readonly<{
        action: "apply" | "recover" | "rollback";
        predecessor?: never;
      }>
    | Readonly<{
        action: "apply";
        predecessor: ConfirmedClosedPredecessor;
      }>
    | Readonly<{
        action: "rollback";
        relaunch: false;
        predecessor: ConfirmedClosedPredecessor;
      }>
  );

export function validInode(value: InstalledUpdateInode): boolean {
  return (
    !!value &&
    [value.device, value.inode].every(
      (part) =>
        typeof part === "string" && /^(0|[1-9][0-9]{0,29})$/u.test(part),
    )
  );
}

export function assertInput(input: InstalledUpdateRequest): void {
  const validBuild = (value: AcceptedInstalledBuild): boolean =>
    !!value &&
    value.version.length <= 128 &&
    sha.test(value.digest) &&
    sha.test(value.buildId) &&
    /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(value.version);
  if (
    ("relaunchPresentation" in input &&
      (input.relaunchPresentation !== "sidecar-only" ||
        !input.relaunch ||
        "predecessor" in input)) ||
    ("installLocation" in input &&
      !["shared", "legacy"].includes(input.installLocation as string)) ||
    !["apply", "recover", "rollback"].includes(input.action) ||
    !/^[0-9a-f]{32}$/u.test(input.operationId) ||
    !validBuild(input.source) ||
    !validBuild(input.target) ||
    input.source.digest === input.target.digest ||
    input.drain?.status !== "reconciled" ||
    input.drain.acceptedSource !== input.source.buildId ||
    input.drain.acceptedTarget !== input.target.buildId ||
    !Number.isSafeInteger(input.pid) ||
    input.pid <= 1 ||
    typeof input.processStart !== "string" ||
    !input.processStart.trim() ||
    input.processStart.length > 128 ||
    !Number.isSafeInteger(input.waitSeconds) ||
    input.waitSeconds < 1 ||
    input.waitSeconds > 120 ||
    typeof input.relaunch !== "boolean"
  ) {
    throw new Error("INSTALLED_UPDATE_INPUT_INVALID");
  }
  if (
    "predecessor" in input &&
    (!input.predecessor ||
      !["apply", "rollback"].includes(input.action) ||
      (input.action === "rollback" && input.relaunch !== false) ||
      input.predecessor.kind !== "confirmed_closed" ||
      !sha.test(input.predecessor.lastQuitSha256) ||
      typeof input.predecessor.startedAt !== "string" ||
      input.predecessor.startedAt.length > 64 ||
      !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/u.test(
        input.predecessor.startedAt,
      ) ||
      !Number.isFinite(Date.parse(input.predecessor.startedAt)) ||
      !validInode(input.predecessor.stateIdentity))
  )
    throw new Error("INSTALLED_UPDATE_INPUT_INVALID");
  if (
    input.action === "rollback" &&
    legacyPredecessorRequiresStateRecovery(
      input.source.version,
      input.target.version,
    )
  )
    throw new Error("INSTALLED_UPDATE_PREDECESSOR_STATE_UNQUALIFIED");
}
