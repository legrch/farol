import { createHash } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { inspectPreservedRecoveryChild } from "./preserved-inspection-child";
import {
  preparePreservedRecoveryChild,
  type ExactPreservedRecoverySelection,
  type PreservedRecoverySelectionInput,
} from "./preserved-recovery-child";
import {
  closedRecoveryHostMechanics as host,
  emptyRecoveryIntent,
  unacknowledgedDevQuitScope,
  type ClosedEmptyChatRecoveryInput,
} from "../../../src/apps/desktop/closed-empty-chat-recovery";
import {
  acquirePromotionLease,
  promotionLeasePath,
  releasePromotionLease,
  verifyPromotionLease,
  type PromotionLeaseHandle,
} from "../../../src/apps/desktop/promotion-lease";
import {
  MAX_RUN_MARKER_BYTES,
  RunMarkerSchema,
} from "../../../src/apps/desktop/run-marker";
import { QuitReceiptSchema } from "../../../src/apps/desktop/quit-receipt";
import { retainEmptyChatForArchival } from "../../../src/apps/desktop/retained-empty-archive";
import { PrivateExecutionFence } from "../../../src/modules/computer/infra/mcp/execution-fence";
import { PrivateMcpLifecycle } from "../../../src/modules/computer/infra/mcp/private-mcp-lifecycle";
import { assertClosedConnectorDurableWork } from "../../../src/apps/desktop/closed-computer-recovery";
import {
  assertStartupLegacyPreparation,
  type StartupLegacyPreparation,
} from "../recovery/legacy-preparation";

export type ClosedPreservedRecoveryInput = Omit<
  ClosedEmptyChatRecoveryInput,
  "selectionInput" | "exact"
> & {
  readonly selectionInput: PreservedRecoverySelectionInput;
  readonly exact: ExactPreservedRecoverySelection;
  readonly expectedQuitSha256?: string;
};
export type StartupPreservedRecoveryInput = ClosedPreservedRecoveryInput & {
  readonly startup: Readonly<{
    lease: PromotionLeaseHandle;
    // The original startup verifier also fences an installed replacement.
    verify: () => Promise<boolean>;
    // Trusted enclosing host/owned-child proof, never renderer or CLI data.
    assertCurrent: () => Promise<void>;
    legacyPreparation?: StartupLegacyPreparation;
  }>;
};
type PreservedRecoveryResult = Readonly<{
  phase: "prepared_for_cold_start";
  archive: string;
  operationId: string;
}>;
type PreservedRecoveryAdmission =
  | Readonly<{ kind: "closed-dev" }>
  | Readonly<{
      kind: "startup";
      lease: PromotionLeaseHandle;
      verify: () => Promise<boolean>;
      assertCurrent: () => Promise<void>;
      legacyPreparation?: StartupLegacyPreparation;
    }>;
const sum = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

// Compare the two known children as a set without changing the original
// receipt/projection order or its byte/hash custody. All schema checks still
// belong to the existing classifier; duplicate/additional children stay refused.
function quitForScopeComparison(quit: unknown): unknown {
  if (typeof quit !== "object" || quit === null || Array.isArray(quit))
    return quit;
  const unconfirmed = (quit as Record<string, unknown>).unconfirmed;
  if (
    !Array.isArray(unconfirmed) ||
    unconfirmed.length !== 2 ||
    !unconfirmed.includes("go-core") ||
    !unconfirmed.includes("connector")
  )
    return quit;
  return { ...quit, unconfirmed: ["go-core", "connector"] };
}

// The Desktop drain can leave only its connector unconfirmed. Recognizing
// that exact failure scope preserves the original receipt; canonical Go
// inspection, process exclusion and durable-work proof still own admission.
function preservedQuitScope(
  run: unknown,
  quit: unknown,
): "current-unconfirmed" | "previous-confirmed" {
  const marker = RunMarkerSchema.safeParse(run);
  const receipt = QuitReceiptSchema.safeParse(quit);
  if (
    marker.success &&
    receipt.success &&
    !receipt.data.drained &&
    isDeepStrictEqual(receipt.data.unconfirmed, ["connector"])
  )
    return "current-unconfirmed";
  return unacknowledgedDevQuitScope(run, quitForScopeComparison(quit));
}

// Trusted closed Dev maintenance only. No installed route, old effect replay or
// startup caller is selected here. Canonical Go and actual process observations
// remain separate prerequisites; old ACK/terminal values stay unobserved.
export async function recoverClosedPreservedChat(
  input: ClosedPreservedRecoveryInput,
): Promise<PreservedRecoveryResult> {
  return recoverPreservedChat(input, { kind: "closed-dev" });
}

// Trusted startup may borrow only its actual held admission handle. The
// enclosing owner retains release and current-host/read-only-child settlement.
// The closed CLI route keeps its separate whole-app-absence contract.
export async function recoverStartupPreservedChat(
  input: StartupPreservedRecoveryInput,
): Promise<PreservedRecoveryResult> {
  const { lease, verify, assertCurrent, legacyPreparation } = input.startup;
  return recoverPreservedChat(input, {
    kind: "startup",
    lease,
    verify,
    assertCurrent,
    ...(legacyPreparation === undefined ? {} : { legacyPreparation }),
  });
}

async function recoverPreservedChat(
  input: ClosedPreservedRecoveryInput,
  admission: PreservedRecoveryAdmission,
): Promise<PreservedRecoveryResult> {
  const selected = structuredClone({
    userData: input.userData,
    executable: input.executable,
    profile: input.profile,
    exact: input.exact,
    selectionInput: input.selectionInput,
    expectedRunSha256: input.expectedRunSha256,
    expectedConfigSha256: input.expectedConfigSha256,
    expectedQuitSha256: input.expectedQuitSha256,
  });
  const { desktopState, processesAbsent, attest } = input;
  const { userData, executable, profile, exact } = selected;
  const state = path.join(userData, "farol-state");
  const legacyPreparation =
    admission.kind === "startup" ? admission.legacyPreparation : undefined;
  if (legacyPreparation !== undefined)
    assertStartupLegacyPreparation(legacyPreparation, userData);
  if (
    !path.isAbsolute(userData) ||
    (admission.kind === "closed-dev" &&
      !["Farol Dev", "Farol DEV"].includes(path.basename(userData))) ||
    profile.root !== path.join(state, "go-core") ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(exact.operationId) ||
    !z.string().uuid().safeParse(exact.operationId).success ||
    ![selected.expectedRunSha256, selected.expectedConfigSha256].every(
      (value) => /^[a-f0-9]{64}$/u.test(value),
    ) ||
    (selected.expectedQuitSha256 !== undefined &&
      !/^[a-f0-9]{64}$/u.test(selected.expectedQuitSha256))
  )
    throw Error("PRESERVED_RECOVERY_SELECTION_INVALID");
  await host.privateRoot(userData);
  await host.privateRoot(state);
  const parent = await host.privateRoot(profile.root);
  if (
    String(parent.dev) !== profile.device ||
    String(parent.ino) !== profile.inode
  )
    throw Error("PRESERVED_RECOVERY_ROOT_CHANGED");
  const root = path.join(state, "secure-mcp-connector", "computer-authority");
  await host.privateRoot(path.dirname(root));
  await host.privateRoot(root);
  const lease =
    admission.kind === "closed-dev"
      ? await acquirePromotionLease(
          userData,
          `preserved-chat-recovery-${exact.operationId}`,
          "promotion",
        )
      : admission.lease;
  if (!lease)
    throw Error(
      admission.kind === "closed-dev"
        ? "PRESERVED_RECOVERY_APP_ACTIVE"
        : "PRESERVED_RECOVERY_STARTUP_LEASE_INVALID",
    );
  const verifyLease = async (): Promise<boolean> => {
    if (
      admission.kind === "startup" &&
      (lease.file !== promotionLeasePath(userData) ||
        lease.record.role !== "admission" ||
        lease.record.generation !== exact.buildId)
    )
      throw Error("PRESERVED_RECOVERY_STARTUP_LEASE_INVALID");
    if (!(await verifyPromotionLease(lease))) return false;
    if (admission.kind === "startup") {
      if (!(await admission.verify())) return false;
      await admission.assertCurrent();
    }
    return true;
  };
  try {
    if (admission.kind === "startup" && !(await verifyLease()))
      throw Error("PROMOTION_LEASE_LOST");
    return await new PrivateExecutionFence({ root }).withClosedRecoveryDrain(
      async () => {
        const running = path.join(state, "running.json");
        const configuration = path.join(state, "config.json");
        const quit = path.join(state, "last-quit.json");
        const pending = path.join(state, "go-core.empty-recovery.pending");
        const archive = path.join(
          profile.root,
          `chat-retired-${exact.operationId}`,
        );
        const run = await host.snapshot(running, MAX_RUN_MARKER_BYTES);
        const config = await host.snapshot(configuration, 256 * 1024);
        const failedQuit =
          selected.expectedQuitSha256 === undefined
            ? undefined
            : await host.snapshot(quit, 16384);
        if (
          sum(run.bytes) !== selected.expectedRunSha256 ||
          sum(config.bytes) !== selected.expectedConfigSha256 ||
          (failedQuit && sum(failedQuit.bytes) !== selected.expectedQuitSha256)
        )
          throw Error("PRESERVED_RECOVERY_STATE_CHANGED");
        const runValue = JSON.parse(run.bytes.toString("utf8"));
        const quitValue = failedQuit
          ? JSON.parse(failedQuit.bytes.toString("utf8"))
          : undefined;
        const previousConfirmedQuit =
          failedQuit !== undefined &&
          preservedQuitScope(runValue, quitValue) === "previous-confirmed";
        if (
          failedQuit &&
          !previousConfirmedQuit &&
          Date.parse(quitValue.at) <= Date.parse(runValue.startedAt)
        )
          throw Error("PRESERVED_RECOVERY_QUIT_SCOPE_CHANGED");
        let preparedRoots:
          | {
              archive: { dev: number; ino: number };
              chat: { dev: number; ino: number };
            }
          | undefined;
        let noQuitLifecycle: PrivateMcpLifecycle | undefined;
        const proof = async () => {
          if (!isDeepStrictEqual(await host.privateRoot(profile.root), parent))
            throw Error("PRESERVED_RECOVERY_ROOT_CHANGED");
          if (
            preparedRoots &&
            (!isDeepStrictEqual(
              await host.privateRoot(archive),
              preparedRoots.archive,
            ) ||
              !isDeepStrictEqual(
                await host.privateRoot(path.join(profile.root, "chat")),
                preparedRoots.chat,
              ))
          )
            throw Error("PRESERVED_RECOVERY_ARCHIVE_CHANGED");
          await host.unchanged(running, run);
          await host.unchanged(configuration, config);
          if (failedQuit) await host.unchanged(quit, failedQuit);
          else await host.absent(quit);
          const desktop = await desktopState();
          await legacyPreparation?.verify();
          if (
            desktop.changed.length ||
            desktop.unreadable.length ||
            !isDeepStrictEqual(desktop.obligations, [
              ...(legacyPreparation === undefined
                ? []
                : ["CHATGPT_DISPATCH_PREPARED"]),
              ...(!failedQuit || previousConfirmedQuit
                ? ["QUIT_UNCONFIRMED:crash"]
                : [
                    `QUIT_UNCONFIRMED:${quitValue.unconfirmed.join(",")}`,
                    "QUIT_UNCONFIRMED:crash",
                  ]),
            ])
          )
            throw Error("PRESERVED_RECOVERY_WORK_PENDING");
          // The Go snapshot has its own Computer/Task namespace. Connector
          // mutation and delegation journals need their existing durable proof
          // too, including inside the native reconciliation lifetime claim.
          await assertClosedConnectorDurableWork(root);
          if (noQuitLifecycle) await noQuitLifecycle.waitForStop(0);
          processesAbsent();
          if (!(await verifyLease())) throw Error("PROMOTION_LEASE_LOST");
        };
        await host.absent(pending);
        await host.absent(archive);
        await attest();
        await proof();
        const movedArchive = await retainEmptyChatForArchival(
          path.join(profile.root, "chat"),
          archive,
        );
        const selectedMetadata = await inspectPreservedRecoveryChild(
          executable,
          profile,
          selected.selectionInput,
          exact,
        );
        await attest();
        await proof();
        if (!failedQuit) {
          // Canonical Go idle observation and the original promotion/Computer
          // exclusions precede this native reconciliation. Retain stale marker
          // custody under failed-run evidence before any Chat preparation;
          // no historical Quit or old stop acknowledgement is inferred.
          const lifecycle = new PrivateMcpLifecycle(root);
          await lifecycle.beginClosedRecoveryStop();
          await lifecycle.reconcileInactiveAfterCrash({
            operationId: exact.operationId,
            failedRunSha256: selected.expectedRunSha256,
            configSha256: selected.expectedConfigSha256,
            proveIdle: proof,
          });
          // Only this maintenance lifetime confirms its own stop. Assign after
          // the native proof callback so proof never recursively takes its lock.
          await lifecycle.confirmStop(0);
          noQuitLifecycle = lifecycle;
          await proof();
        }
        const child = await preparePreservedRecoveryChild(
          executable,
          profile,
          selectedMetadata,
          exact,
        );
        preparedRoots = {
          archive: await host.privateRoot(archive),
          chat: {
            dev: child.publication.Binding.ChatRoot.Device,
            ino: child.publication.Binding.ChatRoot.Inode,
          },
        };
        if (
          preparedRoots.archive.dev !== exact.current.ChatRoot.Device ||
          preparedRoots.archive.ino !== exact.current.ChatRoot.Inode
        )
          throw Error("PRESERVED_RECOVERY_ARCHIVE_CHANGED");
        const archivePin = await movedArchive();
        await proof();
        const intent = await host.snapshot(pending, 65536);
        if (
          !isDeepStrictEqual(
            JSON.parse(intent.bytes.toString("utf8")),
            emptyRecoveryIntent(selectedMetadata, profile),
          )
        )
          throw Error("PRESERVED_RECOVERY_INTENT_CHANGED");
        return host.finish({
          input: {
            executable,
            expectedRunSha256: selected.expectedRunSha256,
            expectedConfigSha256: selected.expectedConfigSha256,
            processesAbsent,
            attest,
            selectionInput: {},
          },
          child,
          exact,
          profile,
          state,
          archive,
          run,
          config,
          pending,
          intent,
          preparedRoots,
          lease,
          ...(admission.kind === "startup" ? { verifyLease } : {}),
          proof,
          ...(failedQuit ? { failedQuit } : {}),
          archivePin,
          ...(legacyPreparation === undefined ? {} : { legacyPreparation }),
          ...(previousConfirmedQuit ? { previousConfirmedQuit: true } : {}),
          preservedHistory: {
            scope: exact.current,
            originalACK: "unobserved",
            originalTerminal: "unobserved",
          },
          reconcileConnector: async () => {
            if (selected.expectedQuitSha256 === undefined) {
              if (!noQuitLifecycle)
                throw Error("PRESERVED_RECOVERY_MCP_IDLE_UNVERIFIED");
              await noQuitLifecycle.waitForStop(0);
              await proof();
              return;
            }
            const lifecycle = new PrivateMcpLifecycle(root);
            await lifecycle.beginClosedRecoveryStop();
            await lifecycle.reconcileInactive({
              operationId: exact.operationId,
              failedQuitSha256: selected.expectedQuitSha256,
              proveIdle: proof,
            });
            await proof();
          },
        });
      },
    );
  } finally {
    if (admission.kind === "closed-dev") await releasePromotionLease(lease);
  }
}
