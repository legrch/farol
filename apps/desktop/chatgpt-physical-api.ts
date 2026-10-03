import type { z } from "zod";
import type { PublicTurnFrameSchema } from "../../src/apps/desktop/chatgpt-public-turn";

// Physical browser contract only. Go owns leases, resolution, admission,
// intent, queue, results and ACK. The host implements this on one dedicated
// route and binds every call to the full original Go lease/operation.
export type PhysicalFrame = z.infer<typeof PublicTurnFrameSchema>;
export type PhysicalPartition =
  "persist:farol-next-chatgpt" | "persist:farol-dev-chatgpt";
export type PhysicalView = Readonly<{
  viewId: string;
  viewGeneration: number;
  documentGeneration: number;
  partition: PhysicalPartition;
}>;
export type PhysicalBinding = PhysicalView &
  (
    | Readonly<{ phase: "home"; url: string; conversationId: null }>
    | Readonly<{ phase: "conversation"; url: string; conversationId: string }>
  );
export type PhysicalPrevious = Readonly<{
  userTurnId: string;
  replyId: string;
}> | null;
export type PhysicalDeclaration = Readonly<{
  provider: string;
  alias: string;
  accountId: string;
  modelId: string;
  effort: string;
  mode: string;
  connectorId: string;
  connectorGrantId: string;
  toolsEnabled: boolean;
}>;
export type PhysicalSelection = Readonly<{
  // Caller declarations retain their provenance; they are never observed facts.
  requested: PhysicalDeclaration;
  admitted: PhysicalDeclaration;
  resolved: Readonly<{
    selection: PhysicalDeclaration;
    configSHA256: string;
    translationId: string;
  }>;
  controls: Readonly<{
    modelLabel: string;
    effortLabel: string | null;
    modeLabel: string | null;
    connector: Readonly<{ id: string; label: string }> | null;
  }>;
  requiredControls: Readonly<{
    model: true;
    effort: boolean;
    mode: boolean;
    connector: boolean;
  }>;
}>;
export type PhysicalFact<T> =
  | Readonly<{ state: "observed"; source: "public-dom"; value: T }>
  | Readonly<{ state: "unknown"; code: "not-exposed" | "unqualified" }>;
// Physical facts are actual public literals. The canonical adapter owns qualified
// label-to-ID translation; configured identity/account/grant pins are not DOM facts.
export type PhysicalObservedSelection = Readonly<{
  modelLabel: PhysicalFact<string>;
  effortLabel: PhysicalFact<string>;
  modeLabel: PhysicalFact<string>;
  connectorLabel: PhysicalFact<string>;
}>;
export type PhysicalSelectionEvidence = Readonly<{
  declared: PhysicalSelection;
  observed: PhysicalObservedSelection;
  observedAtMillis: number;
  sourceProfile: "message-anchors-v1";
}>;
export type PhysicalFailure = Readonly<{
  state: "refused" | "awaiting-owner" | "unknown";
  code: string; // Classified content-free code, never page/prompt/auth text.
}>;
// Mandatory trusted callback, never a renderer grant or a slot-only lookup.
// It covers exact original lease/profile/operation, deadline and the permitted
// binding transition for this operation, before and after each awaited effect.
// Prepare permits one navigation on the assigned view with a new document epoch.
// Disposal post-check validates the logical original lease after native teardown.
export type PhysicalGuard = (binding: PhysicalBinding) => boolean;
type BoundOperation = Readonly<{
  operationId: string;
  binding: PhysicalBinding;
  deadlineMillis: number;
}>;
export type PhysicalWitness = BoundOperation &
  Readonly<{
    evidenceId: string;
    intentDigest: string; // Opaque Go envelope digest; NOT normalized prompt SHA.
    previous: PhysicalPrevious;
    selection: PhysicalSelectionEvidence;
  }>;
export type PhysicalCorrelation = Readonly<{
  userTurnId: string | null;
  replyId: string | null;
}>;
export type PhysicalTerminalProof = Readonly<{
  binding: PhysicalBinding;
  correlation: Readonly<{ userTurnId: string; replyId: string }>;
  frame: PhysicalFrame;
}>;

export interface ChatGptPhysicalApi {
  // Existing dedicated route only: one controlled navigation, no Send,
  // prompt insertion, allocation, default partition or model/account mutation.
  prepare(
    input: Readonly<{
      operationId: string;
      target:
        | Readonly<{ kind: "new-saved" }>
        | Readonly<{ kind: "owned-saved"; conversationId: string }>;
      deadlineMillis: number;
    }>,
    stillBound: PhysicalGuard,
  ): Promise<
    | Readonly<{
        state: "prepared";
        binding: PhysicalBinding;
        readiness:
          "ready" | "sign-in-required" | "awaiting-owner" | "unavailable";
      }>
    | PhysicalFailure
  >;

  // Read-only. No prompt, text insertion, focus, selection change or Send.
  // "witnessed" is bounded physical evidence, not full Go verification/admission.
  verifySend(
    input: BoundOperation &
      Readonly<{
        previous: PhysicalPrevious;
        intentDigest: string;
        selection: PhysicalSelection;
      }>,
    stillBound: PhysicalGuard,
  ): Promise<
    Readonly<{ state: "witnessed"; witness: PhysicalWitness }> | PhysicalFailure
  >;

  // Consume the exact locally minted witness once. Prompt is transient and only
  // present here. Hash text separately; fresh final checks, insertion and one
  // click share one physical dispatch. Unknown/refused effects are never replayed.
  send(
    input: BoundOperation &
      Readonly<{
        witness: PhysicalWitness;
        intentDigest: string;
        prompt: string;
      }>,
    stillBound: PhysicalGuard,
  ): Promise<
    | Readonly<{
        state: "submitted" | "not-sent" | "unknown";
        binding: PhysicalBinding;
        operationId: string;
        evidenceId: string;
        code: string;
      }>
    | PhysicalFailure
  >;

  // Resolve the original host-held submission by exact operation, never prompt
  // replay or latest-turn guessing. Provider IDs remain null until DOM evidence.
  // Helper maps the semantic frame to bounded wire sequencing/paging; no Task
  // engine, Go results, persistence, ACK or replay queue belongs to this API.
  observe(
    input: BoundOperation,
    stillBound: PhysicalGuard,
  ): Promise<
    | Readonly<{
        state: "observed";
        originBinding: PhysicalBinding;
        binding: PhysicalBinding;
        correlation: PhysicalCorrelation;
        selection: PhysicalSelectionEvidence;
        frame: PhysicalFrame | null;
      }>
    | PhysicalFailure
  >;

  // One scoped stop attempt. Missing Stop is not terminal evidence. The two
  // terminal states require a correlated full-reply proof for this exact view.
  cancel(
    input: BoundOperation,
    stillBound: PhysicalGuard,
  ): Promise<
    | Readonly<{
        state: "requested" | "unknown";
        binding: PhysicalBinding;
        code: string;
      }>
    | Readonly<{
        state: "confirmed-terminal" | "already-terminal";
        proof: PhysicalTerminalProof;
      }>
    | PhysicalFailure
  >;

  // Capture the exact assigned view before destroying it. Confirmation requires
  // that same owned WebContents to be observed destroyed; null binding/void
  // disposal never suffice. No changed view or repeated destruction fallback.
  dispose(
    input: BoundOperation,
    stillBound: PhysicalGuard,
  ): Promise<
    | Readonly<{
        state: "destroyed";
        view: PhysicalView;
        destroyedWebContentsId: string;
      }>
    | Readonly<{ state: "unconfirmed"; view: PhysicalView; code: string }>
    | PhysicalFailure
  >;
}
