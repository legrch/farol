import { isDeepStrictEqual } from "node:util";
import type {
  EmptyRecoveryChildResult,
  EmptyRecoveryPublication,
  ExactEmptyRecoverySelection,
} from "../bridge/empty-recovery-child";
import { validate } from "../bridge/wire";

export interface KnownEmptyRecoveryFailure {
  readonly sourceCommit: string;
  readonly originalHostExitCode: number;
  readonly originalDiagnostic: string;
  readonly originalOperationId: string;
  readonly originalBuildId: string;
  readonly originalChildClose: {
    readonly exitCode: "0";
    readonly signal: "";
    readonly forced: false;
  };
  readonly recorderStarted: false;
  readonly receiptSha256: string;
  readonly pendingSha256: string;
  readonly completionOperationId: string;
}

export interface PreparedEmptyRecoveryObservation {
  readonly publication: EmptyRecoveryPublication;
  readonly acknowledgement: EmptyRecoveryChildResult["acknowledgement"];
  readonly archiveDigest: string;
}

// The trusted private launcher owns original execution-receipt authentication.
// This exception is ONLY the unique known failure in the frozen affected source,
// never a claim supplied by IPC/MCP or a substitute for an unknown child outcome.
export function knownEmptyRecoveryChild(
  exact: ExactEmptyRecoverySelection,
  failure: KnownEmptyRecoveryFailure,
  observed: PreparedEmptyRecoveryObservation,
  newChat: { dev: number; ino: number },
): EmptyRecoveryChildResult {
  const hash = (v: string) => /^[a-f0-9]{64}$/u.test(v);
  if (
    failure.sourceCommit !== "4dbeef4523241326c7d674a57dca1fc6e0bee30c" ||
    failure.originalHostExitCode !== 1 ||
    failure.originalDiagnostic !== "EMPTY_CHAT_RECOVERY_INTENT_CHANGED" ||
    failure.originalOperationId !== exact.operationId ||
    failure.originalBuildId !== exact.buildId ||
    !isDeepStrictEqual(failure.originalChildClose, {
      exitCode: "0",
      signal: "",
      forced: false,
    }) ||
    failure.recorderStarted !== false ||
    ![
      failure.receiptSha256,
      failure.pendingSha256,
      observed.archiveDigest,
    ].every(hash) ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(
      failure.completionOperationId,
    ) ||
    failure.completionOperationId === exact.operationId ||
    ![newChat.dev, newChat.ino].every((v) => Number.isSafeInteger(v) && v > 0)
  )
    throw Error("EMPTY_CHAT_KNOWN_COMPLETION_REFUSED");
  const expectedBinding = {
    ...exact.current,
    BackendGeneration: exact.backendGeneration,
    BuildID: exact.buildId,
    HostLifetimeID: exact.hostLifetimeId,
    ChildLaunchID: exact.childLaunchId,
    ChatRoot: {
      ...exact.current.ChatRoot,
      Device: newChat.dev,
      Inode: newChat.ino,
    },
  };
  const { publication, acknowledgement } = observed;
  if (
    newChat.dev !== exact.current.ChatRoot.Device ||
    newChat.ino === exact.current.ChatRoot.Inode ||
    !isDeepStrictEqual(publication.Binding, expectedBinding) ||
    publication.HandoffID !== exact.operationId ||
    !Array.isArray(publication.ReceiptDigest) ||
    publication.ReceiptDigest.length !== 32 ||
    !publication.ReceiptDigest.every(
      (v) => Number.isInteger(v) && v >= 0 && v <= 255,
    ) ||
    !publication.ReceiptDigest.some((v) => v !== 0) ||
    !validate("CoreRetirementAcknowledged", acknowledgement) ||
    acknowledgement.handoffId !== exact.operationId ||
    acknowledgement.receiptDigest !==
      Buffer.from(publication.ReceiptDigest).toString("hex")
  )
    throw Error("EMPTY_CHAT_KNOWN_COMPLETION_REFUSED");
  const terminal = {
    ...acknowledgement,
    backendGeneration: exact.backendGeneration,
    hostLifetimeId: exact.hostLifetimeId,
    childLaunchId: exact.childLaunchId,
    ...failure.originalChildClose,
  };
  if (!validate("CoreTerminalObservation", terminal))
    throw Error("EMPTY_CHAT_KNOWN_COMPLETION_REFUSED");
  return structuredClone({ publication, acknowledgement, terminal });
}
