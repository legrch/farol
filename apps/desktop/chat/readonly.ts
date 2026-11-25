import type { ReadAccountConfirmation } from "../read-account-confirmation";
import type {
  ApprovedProductWorkspace,
  ProductSettings,
} from "../../../src/pkg/product-settings/contract";
import { MAX_CHATGPT_CONTEXT_CHARACTERS } from "../../../src/apps/desktop/chatgpt-readonly-task";
import { identityBoundWorkspaces } from "../../../src/apps/desktop/identity-bound-workspaces";
import type { ChatComputerAdmissionResponse } from "../bridge/wire";
import type {
  PendingChatGptAttachmentTask,
  PendingChatGptReadonlyTask,
} from "../configuration/chatgpt";
import type { VerificationWorkspaceAction } from "../configuration/computer";
import type { DesktopGoCore } from "../go-core-host";

// The two pending ChatGPT tasks the owner can still send, as the preview each
// one shows, how a read-only preview is withdrawn from Go and discarded, and
// the one read-only action that runs a verification command in an approved
// workspace. Main keeps the pending read-only task as a `let`: the getter reads
// it afresh and the setter clears it, so a change made while a withdrawal waits
// is seen at the next read. The confirmations are main's own WeakMap, lent by
// reference: it is keyed by the pending task's identity, so a copy would never
// find the task. Only a discard is remembered here, per pending task, so a
// repeated request is the first attempt's own answer and never a second try.
// The authority types belong to the computer module, so the constructors and
// the one native workspace arrive as ports and nothing here imports that module.

type Capability =
  | "workspace.list"
  | "workspace.read"
  | "workspace.search"
  | "verification.run"
  | "workspace.write";

type BoundWorkspace = ReturnType<typeof identityBoundWorkspaces>[number];

type VerificationApproval = Readonly<{
  ownerId: string;
  computerId: string;
  generation: number;
  workspaces: readonly Readonly<{
    workspaceId: string;
    root: string;
    access: BoundWorkspace["access"];
    rootIdentity: BoundWorkspace["rootIdentity"];
    gitMetadata?: NonNullable<BoundWorkspace["gitMetadata"]>;
  }>[];
  excludedPaths: readonly Readonly<{ workspaceId: string; path: string }>[];
  capabilities: readonly Capability[];
  network: "none";
  commands: "verification" | "workspace";
  expiresAt: number;
}>;

type VerificationAdmission = Readonly<{
  authorityId: string;
  ownerId: string;
  sessionId: string;
  taskId: string;
  taskEpoch: number;
  computerId: string;
  computerGeneration: number;
  workspaces: readonly Readonly<{
    workspaceId: string;
    mode: "subtree";
    root: string;
    access: "read";
  }>[];
  excludedPaths: readonly Readonly<{ workspaceId: string; path: string }>[];
  capabilities: readonly Capability[];
  network: "none";
  commands: "verification" | "workspace";
  expiresAt: number;
}>;

type AuthorityOutcome<Value> =
  Readonly<{ ok: true; value: Value }> | Readonly<{ ok: false }>;

export type ReadonlyHostPorts<
  Grant,
  Participant,
  AuthorityRepository,
  ApprovalRepository,
  Workspace,
> = Readonly<{
  goChatStartupProfile: () => object | null;
  desktopGoCore: () => Pick<DesktopGoCore, "withdrawReadIntent"> | null;
  readonlyAccountConfirmations: Pick<
    WeakMap<
      PendingChatGptReadonlyTask,
      Pick<ReadAccountConfirmation, "projection">
    >,
    "get"
  >;
  pendingChatGptReadonlyTask: () => PendingChatGptReadonlyTask | null;
  setPendingChatGptReadonlyTask: (
    value: PendingChatGptReadonlyTask | null,
  ) => void;
  discardPreparedChatGptTask: (operationId: string) => Promise<boolean>;
  nativeWorkspace: Workspace;
  deriveTaskGrant: (
    approval: VerificationApproval,
    admission: VerificationAdmission,
    now: number,
  ) => AuthorityOutcome<Grant>;
  createParticipantAuthority: (
    grant: Grant,
    admission: Readonly<{
      participantId: string;
      role: "main";
      mutationOwnership: "none";
    }>,
  ) => AuthorityOutcome<Participant>;
  InMemoryAuthorityRepository: new (
    initial: readonly Participant[],
  ) => AuthorityRepository;
  InMemoryComputerApprovalRepository: new (
    initial: readonly VerificationApproval[],
  ) => ApprovalRepository;
  RunReadonlyComputerAction: new (
    authorities: AuthorityRepository,
    approvals: ApprovalRepository,
    workspace: Workspace,
    clock: Readonly<{ now: () => number }>,
  ) => VerificationWorkspaceAction;
}>;

export function createReadonlyHost<
  Grant,
  Participant,
  AuthorityRepository,
  ApprovalRepository,
  Workspace,
>(
  ports: ReadonlyHostPorts<
    Grant,
    Participant,
    AuthorityRepository,
    ApprovalRepository,
    Workspace
  >,
) {
  const {
    goChatStartupProfile,
    desktopGoCore,
    readonlyAccountConfirmations,
    pendingChatGptReadonlyTask,
    setPendingChatGptReadonlyTask,
    discardPreparedChatGptTask,
    nativeWorkspace,
    deriveTaskGrant,
    createParticipantAuthority,
    InMemoryAuthorityRepository,
    InMemoryComputerApprovalRepository,
    RunReadonlyComputerAction,
  } = ports;

  const readonlyDiscardAttempts = new WeakMap<
    PendingChatGptReadonlyTask,
    Promise<boolean>
  >();

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

  function verificationWorkspaceAction(
    settings: ProductSettings,
    workspace: ApprovedProductWorkspace,
    expiresAt: number,
  ): VerificationWorkspaceAction | null {
    if (settings.computer.commands === "none") return null;
    const ownerId = "owner-desktop";
    const sessionId = "desktop-command-session";
    const taskId = "desktop-command-task";
    const participantId = "desktop-command-main";
    const approvalCapabilities: Capability[] = [
      "workspace.list",
      "workspace.read",
      "workspace.search",
      "verification.run",
      ...(settings.computer.workspaces.some(
        (candidate) => candidate.access === "write",
      )
        ? (["workspace.write"] as const)
        : []),
    ];
    const bound = identityBoundWorkspaces(settings.computer.workspaces);
    const approval: VerificationApproval = {
      ownerId,
      computerId: settings.computer.computerId,
      generation: settings.computer.generation,
      workspaces: bound.map((candidate) => ({
        workspaceId: candidate.workspaceId,
        root: candidate.root,
        access: candidate.access,
        rootIdentity: candidate.rootIdentity,
        ...(candidate.gitMetadata
          ? { gitMetadata: candidate.gitMetadata }
          : {}),
      })),
      excludedPaths: bound.flatMap((candidate) =>
        candidate.excludedPaths.map((excluded) => ({
          workspaceId: candidate.workspaceId,
          path: excluded,
        })),
      ),
      capabilities: approvalCapabilities,
      network: "none",
      commands: settings.computer.commands,
      expiresAt,
    };
    const admission: VerificationAdmission = {
      authorityId: `desktop-command-authority-${settings.computer.generation}`,
      ownerId,
      sessionId,
      taskId,
      taskEpoch: settings.computer.generation,
      computerId: settings.computer.computerId,
      computerGeneration: settings.computer.generation,
      workspaces: [
        {
          workspaceId: workspace.workspaceId,
          mode: "subtree",
          root: workspace.root,
          access: "read",
        },
      ],
      excludedPaths: workspace.excludedPaths.map((excluded) => ({
        workspaceId: workspace.workspaceId,
        path: excluded,
      })),
      capabilities: ["verification.run"],
      network: "none",
      commands: settings.computer.commands,
      expiresAt,
    };
    const grant = deriveTaskGrant(approval, admission, Date.now());
    if (!grant.ok) return null;
    const participant = createParticipantAuthority(grant.value, {
      participantId,
      role: "main",
      mutationOwnership: "none",
    });
    if (!participant.ok) return null;
    return new RunReadonlyComputerAction(
      new InMemoryAuthorityRepository([participant.value]),
      new InMemoryComputerApprovalRepository([approval]),
      nativeWorkspace,
      { now: () => Date.now() },
    );
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
    verificationWorkspaceAction,
    withdrawGoReadonlyAdmission,
    discardPreparedReadonlyTask,
  };
}
