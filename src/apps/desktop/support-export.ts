import {
  OperationsSnapshotSchema,
  type OperationsSnapshot,
} from "../../../apps/desktop/renderer/operations-contract";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import type { BuildIdentity } from "../../pkg/build-info/identity";
import type { ProductConfigurationSnapshot } from "../../pkg/product-settings/contract";

const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
// A support report is a small content-free summary; anything larger means
// something that does not belong in it was added.
const MAX_SUPPORT_EXPORT_BYTES = 64 * 1024;
const MAX_SUPPORT_WITH_OPERATIONS_BYTES = 12 * 1024 * 1024;
const CLOSE_ON_EXEC =
  (fsConstants as typeof fsConstants & { O_CLOEXEC?: number }).O_CLOEXEC ?? 0;

export type SupportRuntimeErrorCode =
  | "process_exited"
  | "process_failed"
  | "start_timeout"
  | "manifest_mismatch"
  | "startup_failed"
  | "other";

type SupportExportInput = Readonly<{
  operations?: OperationsSnapshot;
  generatedAt: string;
  build: BuildIdentity;
  configuration: ProductConfigurationSnapshot;
  runtime: Readonly<{
    state: "starting" | "ready" | "offline" | "failed";
    errorCode: SupportRuntimeErrorCode | null;
    identity: string | null;
  }>;
  capabilities: Readonly<{
    nativeFilesystem: boolean;
    nativeAgent: boolean;
    liveProvider: boolean;
  }>;
  // The runtime this report was made by, as the shell shows it.
  embedded: Readonly<{
    node: string;
    electron: string | null;
    chrome: string | null;
  }>;
  tasks: Readonly<{
    total: number;
    running: number;
    waiting: number;
    failed: number;
    // After a runtime exit the live counters are cleared, so the report
    // uses the counts taken just before it, or says they are unavailable.
    countsFrom: "current" | "before_runtime_exit" | "unavailable";
  }>;
}>;

function exactKeys(value: unknown, keys: readonly string[]): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...keys].sort())
  );
}

// Only these shapes may reach a report: an extra field, such as a provider's
// raw diagnostics, is refused rather than written out.
function assertKnownInput(input: SupportExportInput): void {
  if (
    !exactKeys(input, [
      ...(input.operations === undefined ? [] : ["operations"]),
      "generatedAt",
      "build",
      "configuration",
      "runtime",
      "capabilities",
      "embedded",
      "tasks",
    ]) ||
    !exactKeys(input.runtime, ["state", "errorCode", "identity"]) ||
    !exactKeys(input.capabilities, [
      "nativeFilesystem",
      "nativeAgent",
      "liveProvider",
    ]) ||
    !exactKeys(input.embedded, ["node", "electron", "chrome"]) ||
    !exactKeys(input.tasks, [
      "total",
      "running",
      "waiting",
      "failed",
      "countsFrom",
    ])
  ) {
    throw new Error("SUPPORT_EXPORT_INPUT_INVALID");
  }
}

function setupReadiness(
  readiness: Extract<
    ProductConfigurationSnapshot,
    { status: "ready" }
  >["settings"]["setup"]["chatgpt"],
) {
  return {
    visited: readiness.visited,
    skipped: readiness.skipped,
    configured: readiness.configured,
    reachable: readiness.reachable,
    verified: readiness.verified !== null,
    outcomeUnknown: readiness.outcomeUnknown,
  } as const;
}

function nativeAgentVerification(configuration: ProductConfigurationSnapshot) {
  if (configuration.status === "error") {
    return { status: "settings_unavailable" as const, evidence: null };
  }
  const settings = configuration.settings;
  const readiness = settings.setup.verify;
  const proof = settings.nativeHosts.codex?.agentVerification ?? null;
  const status = proof
    ? proof.workspaceEnforcement === "verified" &&
      proof.parentDelivery === "acknowledged" &&
      proof.resultRetention === "durable"
      ? ("verified" as const)
      : ("partial" as const)
    : readiness.outcomeUnknown
      ? ("outcome_unknown" as const)
      : readiness.unavailable !== null
        ? ("unavailable" as const)
        : readiness.needsAction !== null
          ? ("needs_action" as const)
          : ("not_configured" as const);
  return {
    status,
    evidence: proof
      ? {
          model: proof.model,
          transport: proof.transport,
          authorityRole: proof.authorityRole,
          lineage: "verified" as const,
          taskGrantContinuity: "verified" as const,
          boundedRunning: proof.boundedRunning,
          modelTurnsSubmitted: proof.modelTurnsSubmitted,
          fallbackAllowed: proof.fallbackAllowed,
          descendantCount: proof.descendantCount,
          resultRefProtocol: proof.resultRefProtocol,
          resultRetention: proof.resultRetention,
          parentDelivery: proof.parentDelivery,
          workspaceEnforcement: proof.workspaceEnforcement,
          verifiedAt: proof.verifiedAt,
        }
      : null,
  };
}

export function createSupportExport(input: SupportExportInput) {
  assertKnownInput(input);
  const configuration =
    input.configuration.status === "error"
      ? {
          status: "error" as const,
          error: input.configuration.error,
        }
      : {
          status: "ready" as const,
          revision: input.configuration.settings.revision,
          general: {
            openAtLaunch: input.configuration.settings.general.openAtLaunch,
            sidebarDefault: input.configuration.settings.general.sidebarDefault,
            activityDetail: input.configuration.settings.general.activityDetail,
          },
          computer: {
            generation: input.configuration.settings.computer.generation,
            workspaceCount:
              input.configuration.settings.computer.workspaces.length,
            readWorkspaceCount:
              input.configuration.settings.computer.workspaces.filter(
                (workspace) => workspace.access === "read",
              ).length,
            writeWorkspaceCount:
              input.configuration.settings.computer.workspaces.filter(
                (workspace) => workspace.access === "write",
              ).length,
            exclusionCount:
              input.configuration.settings.computer.workspaces.reduce(
                (count, workspace) => count + workspace.excludedPaths.length,
                0,
              ),
          },
          setup: {
            chatgpt: setupReadiness(input.configuration.settings.setup.chatgpt),
            computer: setupReadiness(
              input.configuration.settings.setup.computer,
            ),
            connect: setupReadiness(input.configuration.settings.setup.connect),
            hosts: setupReadiness(input.configuration.settings.setup.hosts),
            verify: setupReadiness(input.configuration.settings.setup.verify),
          },
        };

  return {
    ...(input.operations === undefined
      ? {}
      : { operations: OperationsSnapshotSchema.parse(input.operations) }),
    schema: 2 as const,
    kind: "farol_support" as const,
    generatedAt: input.generatedAt,
    build: input.build,
    runtime: input.runtime,
    capabilities: input.capabilities,
    embedded: input.embedded,
    configuration,
    nativeAgentVerification: nativeAgentVerification(input.configuration),
    tasks: input.tasks,
  };
}

function assertReplaceableTarget(info: Stats): void {
  const effectiveUser = process.geteuid?.();
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    (effectiveUser !== undefined && info.uid !== effectiveUser)
  ) {
    throw new Error("SUPPORT_EXPORT_UNSAFE");
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(
    directory,
    fsConstants.O_RDONLY |
      (fsConstants.O_DIRECTORY ?? 0) |
      NO_FOLLOW |
      CLOSE_ON_EXEC,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function writeSupportExport(target: string, report: unknown) {
  if (!path.isAbsolute(target) || target.includes("\0")) {
    throw new Error("SUPPORT_EXPORT_UNSAFE");
  }
  const fileName = path.basename(target);
  if (fileName === "." || fileName === ".." || fileName.length === 0) {
    throw new Error("SUPPORT_EXPORT_UNSAFE");
  }
  const parent = await fs.realpath(path.dirname(target));
  const parentInfo = await fs.lstat(parent);
  const effectiveUser = process.geteuid?.();
  if (
    !parentInfo.isDirectory() ||
    parentInfo.isSymbolicLink() ||
    (effectiveUser !== undefined && parentInfo.uid !== effectiveUser)
  ) {
    throw new Error("SUPPORT_EXPORT_UNSAFE");
  }
  const canonicalTarget = path.join(parent, fileName);
  try {
    assertReplaceableTarget(await fs.lstat(canonicalTarget));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const hasOperations =
    report !== null && typeof report === "object" && "operations" in report;
  if (hasOperations) {
    const reportRecord = report as Record<string, unknown>;
    const operations = OperationsSnapshotSchema.safeParse(
      reportRecord.operations,
    );
    if (!operations.success) throw new Error("SUPPORT_EXPORT_INVALID");
    report = { ...reportRecord, operations: operations.data };
  }
  let serialized: string;
  try {
    serialized = `${JSON.stringify(report, null, 2)}\n`;
  } catch {
    throw new Error("SUPPORT_EXPORT_INVALID");
  }
  if (serialized === "undefined\n") {
    throw new Error("SUPPORT_EXPORT_INVALID");
  }
  const bytes = Buffer.byteLength(serialized);
  let permittedBytes = MAX_SUPPORT_EXPORT_BYTES;
  if (hasOperations) {
    const reportRecord = report as Record<string, unknown>;
    const otherBytes = Buffer.byteLength(
      JSON.stringify({ ...reportRecord, operations: undefined }, null, 2),
    );
    if (otherBytes > MAX_SUPPORT_EXPORT_BYTES)
      throw new Error("SUPPORT_EXPORT_TOO_LARGE");
    permittedBytes = MAX_SUPPORT_WITH_OPERATIONS_BYTES;
  }
  if (bytes > permittedBytes) {
    throw new Error("SUPPORT_EXPORT_TOO_LARGE");
  }
  const sha256 = createHash("sha256").update(serialized).digest("hex");
  const temporary = path.join(parent, `.${fileName}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(
      temporary,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        NO_FOLLOW |
        CLOSE_ON_EXEC,
      0o600,
    );
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, canonicalTarget);
    await fs.chmod(canonicalTarget, 0o600);
    await syncDirectory(parent);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
  return { fileName, bytes, sha256 } as const;
}
