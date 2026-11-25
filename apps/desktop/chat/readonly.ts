import type { ReadAccountConfirmation } from "../read-account-confirmation";
import { MAX_CHATGPT_CONTEXT_CHARACTERS } from "../../../src/apps/desktop/chatgpt-readonly-task";
import type { ChatComputerAdmissionResponse } from "../bridge/wire";
import type {
  PendingChatGptAttachmentTask,
  PendingChatGptReadonlyTask,
} from "../configuration/chatgpt";
import type { DesktopGoCore } from "../go-core-host";

// The two pending ChatGPT tasks the owner can still send, as the preview each
// one shows, and how a read-only preview is withdrawn from Go and discarded.
// Main keeps the pending read-only task as a `let`: the getter reads it afresh
// and the setter clears it, so a change made while a withdrawal waits is seen
// at the next read. The confirmations and the discard attempts are main's own
// WeakMaps, lent by reference: each is keyed by the pending task's identity, so
// a copy would never find the task, and the one discard attempt per task is
// what makes a repeated request the first attempt's own answer and never a
// second try.

export type ReadonlyHostPorts = Readonly<{
  goChatStartupProfile: () => object | null;
  desktopGoCore: () => Pick<DesktopGoCore, "withdrawReadIntent"> | null;
  readonlyAccountConfirmations: Pick<
    WeakMap<
      PendingChatGptReadonlyTask,
      Pick<ReadAccountConfirmation, "projection">
    >,
    "get"
  >;
  readonlyDiscardAttempts: Pick<
    WeakMap<PendingChatGptReadonlyTask, Promise<boolean>>,
    "get" | "set"
  >;
  pendingChatGptReadonlyTask: () => PendingChatGptReadonlyTask | null;
  setPendingChatGptReadonlyTask: (
    value: PendingChatGptReadonlyTask | null,
  ) => void;
  discardPreparedChatGptTask: (operationId: string) => Promise<boolean>;
}>;

export function createReadonlyHost(ports: ReadonlyHostPorts) {
  const {
    goChatStartupProfile,
    desktopGoCore,
    readonlyAccountConfirmations,
    readonlyDiscardAttempts,
    pendingChatGptReadonlyTask,
    setPendingChatGptReadonlyTask,
    discardPreparedChatGptTask,
  } = ports;

  function chatGptReadonlyTaskPreview(
    pending: PendingChatGptReadonlyTask,
  ): Readonly<Record<string, unknown>> {
    const account = readonlyAccountConfirmations.get(pending)?.projection();
    return {
      kind: "chatgpt.readonly-task-preview",
      sendAvailable: Boolean(pending.goAdmission && goChatStartupProfile()),
      operationId: pending.operationId,
      workspaceId: pending.workspaceId,
      workspaceLabel: pending.workspaceLabel,
      relativePath: pending.relativePath,
      bytes: pending.bytes,
      contextCharacters: pending.contextCharacters,
      contextLimit: MAX_CHATGPT_CONTEXT_CHARACTERS,
      contextTruncated: pending.contextTruncated,
      excludedPaths: pending.excludedPaths,
      expiresAt: new Date(pending.expiresAt).toISOString(),
      ...(account ? { account } : {}),
    };
  }

  function chatGptAttachmentTaskPreview(
    pending: PendingChatGptAttachmentTask,
  ): Readonly<Record<string, unknown>> {
    return {
      kind: "chatgpt.attachment-task-preview",
      operationId: pending.operationId,
      attachments: pending.attachments.attachments.map(
        ({ stagedPath: _stagedPath, ...attachment }) => attachment,
      ),
      totalBytes: pending.attachments.attachments.reduce(
        (total, attachment) => total + attachment.bytes,
        0,
      ),
      expiresAt: new Date(pending.expiresAt).toISOString(),
    };
  }

  async function withdrawGoReadonlyAdmission(
    admission: ChatComputerAdmissionResponse | undefined,
  ): Promise<boolean> {
    if (!admission) return true;
    const core = desktopGoCore();
    if (!core) return false;
    try {
      await core.withdrawReadIntent(admission);
      return true;
    } catch {
      return false;
    }
  }

  function discardPreparedReadonlyTask(
    pending: PendingChatGptReadonlyTask,
  ): Promise<boolean> {
    const previous = readonlyDiscardAttempts.get(pending);
    if (previous) return previous;
    // The selected Go owner confirms its own cancellation/ACK. Only a legacy
    // preview owns a legacy journal entry; never create or clear a Go mirror.
    // Retain either failure; UI repetition is not a retry.
    const result = Promise.resolve().then(async () => {
      if (!(await withdrawGoReadonlyAdmission(pending.goAdmission)))
        return false;
      if (
        pending.goAdmission === undefined &&
        !(await discardPreparedChatGptTask(pending.operationId))
      )
        return false;
      if (pendingChatGptReadonlyTask() === pending)
        setPendingChatGptReadonlyTask(null);
      return true;
    });
    readonlyDiscardAttempts.set(pending, result);
    return result;
  }

  return {
    chatGptReadonlyTaskPreview,
    chatGptAttachmentTaskPreview,
    withdrawGoReadonlyAdmission,
    discardPreparedReadonlyTask,
  };
}
