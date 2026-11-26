import type { CodexThreadRuntime } from "./codex-thread-runtime";
import type {
  LatestProjectPreference,
  ProjectPreferenceRecord,
} from "./codex-project-preference";

export type HandoffModelBinding = Readonly<{
  selection: Readonly<{
    harness: string;
    modelAlias: string;
    model: string;
    effort?: string | undefined;
  }>;
  configSha256: string;
}>;

export type HandoffRequest = Readonly<{
  key: string;
  workspaceId: string;
  projectId: string;
  message: string;
  model: string;
  reasoningEffort?: string | undefined;
  modelBinding?: HandoffModelBinding | undefined;
}>;

export type HandoffMessage = Readonly<{
  key: string;
  dispatchId: string;
  workspaceId: string;
  projectId: string;
  message: string;
  model: string;
  reasoningEffort?: string | undefined;
}>;

export type HandoffContinue = Readonly<{
  key: string;
  dispatchId: string;
  message: string;
}>;
export type HandoffTitleRequest = Readonly<{
  key: string;
  dispatchId: string;
  workspaceId: string;
  projectId: string;
  expectedTitle: string | null;
  title: string;
}>;
export type HandoffTitleResult =
  | Readonly<{
      status: "renamed";
      dispatchId: string;
      title: string;
      proof: "readback";
    }>
  | Readonly<{
      status: "recorded";
      dispatchId: string;
      title: string;
      proof: "historical";
    }>
  | Readonly<{
      status: "title_changed";
      dispatchId: string;
      title: string | null;
    }>
  | Readonly<{ status: "outcome_unknown"; dispatchId: string }>
  | Readonly<{ status: "refused"; code: string }>;

export type HandoffAdopt = Readonly<{
  threadId: string;
  turnId: string;
  workspaceId: string;
  projectId: string;
}>;

export type HandoffMessageResult =
  | Readonly<{ status: "steered"; dispatchId: string; turnId: string }>
  | Readonly<{ status: "outcome_unknown"; dispatchId: string }>
  | Readonly<{ status: "refused"; code: string }>;

export type HandoffWorkspace = Readonly<{
  root: string;
  device: string;
  inode: string;
  gitCommonDirectory: string;
  project: Readonly<{
    root: string;
    device: string;
    inode: string;
    gitCommonDirectory: string;
  }>;
  execution: Readonly<{
    sandbox: "read-only" | "workspace-write";
    approvalPolicy: "untrusted" | "on-request";
  }>;
}>;

export type HandoffRecord = Readonly<{
  requestDigest: string;
  dispatchProtocol?: 1 | undefined;
  modelCatalogue?:
    | Readonly<{ modelId: string; observedAt: number; scope: string }>
    | undefined;
  adopted?: true | undefined;
  model?: string;
  reasoningEffort?: string | undefined;
  modelBinding?: HandoffModelBinding | undefined;
  continuedFrom?: string | undefined;
  continuationVerified?: boolean | undefined;
  workspaceId: string;
  workspace: HandoffWorkspace;
  projectId: string;
  threadId?: string;
  turnId?: string;
  threadIntent: boolean;
  turnIntent: boolean;
}>;

export interface HandoffJournal {
  readLatestProjectPreference?(
    project: ProjectPreferenceRecord["project"],
  ): Promise<LatestProjectPreference | null>;
  readProjectPreference?(key: string): Promise<ProjectPreferenceRecord | null>;
  rememberProjectPreference?(
    key: string,
    record: ProjectPreferenceRecord,
  ): Promise<ProjectPreferenceRecord>;
  hasUnconfirmedTitle?(dispatchId: string): Promise<boolean>;
  claimTitle?(
    dispatchId: string,
    key: string,
    digest: string,
  ): Promise<"claimed" | "existing" | "conflict">;
  readTitle?(
    dispatchId: string,
    key: string,
  ): Promise<Readonly<{ digest: string; threadId: string | null }> | null>;
  recordTitle?(
    dispatchId: string,
    key: string,
    threadId: string,
  ): Promise<void>;
  reserve(key: string, record: HandoffRecord): Promise<HandoffRecord>;
  claimThread(key: string): Promise<boolean>;
  claimDispatchAttempt?(key: string, initial: boolean): Promise<number | null>;
  recordPreEffectRefusal?(
    key: string,
    attempt: number,
    canPublish: () => boolean,
  ): Promise<void>;
  recordThread(key: string, threadId: string): Promise<void>;
  claimTurn(key: string): Promise<boolean>;
  recordTurn(key: string, turnId: string): Promise<void>;
  claimContinuation?(
    parentKey: string,
    parentTurnId: string,
    key: string,
  ): Promise<boolean>;
  confirmContinuation?(key: string, turnId: string): Promise<void>;
  hasUnconfirmedMessage?(dispatchId: string): Promise<boolean>;
  read(key: string): Promise<HandoffRecord | null>;
  claimMessage(
    dispatchId: string,
    key: string,
    digest: string,
  ): Promise<"claimed" | "existing" | "conflict">;
  readMessage(
    dispatchId: string,
    key: string,
  ): Promise<Readonly<{ digest: string; turnId: string | null }> | null>;
  recordMessage(dispatchId: string, key: string, turnId: string): Promise<void>;
}

export interface HandoffAuthority {
  // The caller supplies only an ID. The owner-approved Computer binding is
  // resolved by the trusted host, including its current physical root.
  resolve(workspaceId: string): Promise<HandoffWorkspace | null>;
}

export type HandoffReadContext = Readonly<{
  signal?: AbortSignal | undefined;
  deadlineAt?: number | undefined;
}>;

export interface HandoffHost {
  modelCatalogueScope?(): string;
  request(
    method: string,
    params: unknown,
    deadlineAt?: number,
  ): Promise<unknown>;
}

export interface HandoffRequestDigester {
  digestTitle?(request: HandoffTitleRequest): string;
  digest(request: HandoffRequest): string;
  digestMessage(request: HandoffMessage): string;
  digestContinue?(request: HandoffContinue): string;
  digestAdopt?(request: HandoffAdopt): string;
}

export interface HandoffMutationGate {
  run<T>(
    preflight: () => Promise<void>,
    effect: () => Promise<T>,
    safeToReleaseError: (error: unknown) => boolean,
  ): Promise<T>;
}

export type HandoffCreateResult =
  | Readonly<{
      status: "dispatched";
      dispatchId: string;
      threadId: string;
      turnId: string;
    }>
  | Readonly<{ status: "outcome_unknown"; dispatchId: string }>
  | Readonly<{ status: "refused"; code: string }>;

export type HandoffStatusResult =
  | Readonly<{ status: "unknown" }>
  | Readonly<{ status: "outcome_unknown"; dispatchId: string }>
  | Readonly<{
      status: "known";
      dispatchId: string;
      threadId: string;
      turnId: string;
      turnStatus: string;
      threadRuntime: CodexThreadRuntime;
    }>;

export type HandoffResult =
  | Readonly<{ status: "unknown" }>
  | Readonly<{ status: "outcome_unknown"; dispatchId: string }>
  | Readonly<{
      status: "running";
      threadRuntime: CodexThreadRuntime;
      dispatchId: string;
      threadId: string;
      turnId: string;
    }>
  | Readonly<{
      status: "failed" | "interrupted";
      dispatchId: string;
      threadId: string;
      turnId: string;
    }>
  | Readonly<{
      status: "completed";
      dispatchId: string;
      threadId: string;
      turnId: string;
      finalItemId: string;
      text: string;
    }>;
