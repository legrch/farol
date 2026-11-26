import type { ChatGptAccountObservation } from "../chatgpt-account-probe";
import type {
  ChatGptPhysicalApi,
  PhysicalBinding,
  PhysicalCorrelation,
  PhysicalFailure,
  PhysicalFrame,
  PhysicalPrevious,
  PhysicalObservedSelection,
  PhysicalSelection,
} from "../chatgpt-physical-api";

export type PhysicalPageRequiredControls =
  PhysicalSelection["requiredControls"];
export type PhysicalPageSelection = PhysicalSelection;
export type PhysicalPageObservedSelection = PhysicalObservedSelection;
export type PhysicalPagePolicy = Readonly<{
  e2eOrigin: string | null;
  accountObservationProfile?: "provider-session-v1";
  // Selected by the host route, never inferred from provider markup.
  contentProfile?: PhysicalPageContentProfile;
}>;

export type VerifyInput = Parameters<ChatGptPhysicalApi["verifySend"]>[0];
export type PhysicalPageSendInput = Parameters<ChatGptPhysicalApi["send"]>[0];
export type SendInput = PhysicalPageSendInput;

/** PRIVATE page DTOs. The host retains these; never persist prompt or page state. */
export type PhysicalPageVerifyResponse =
  | PhysicalFailure
  | Readonly<{
      state: "witnessed";
      binding: PhysicalBinding;
      operationId: string;
      evidenceId: string;
      intentDigest: string;
      previous: PhysicalPrevious;
      observed: PhysicalPageObservedSelection;
      sourceProfile: "message-anchors-v1";
      baselineUserIds: readonly string[];
      account?: ChatGptAccountObservation | undefined;
    }>;
export type PhysicalPageSubmission = Readonly<{
  originBinding: PhysicalBinding;
  operationId: string;
  evidenceId: string;
  intentDigest: string;
  promptDigest: string;
  baselineUserIds: readonly string[];
  previous: PhysicalPrevious;
  selection: PhysicalPageSelection;
}>;
export type PhysicalPageSendResponse = Awaited<
  ReturnType<ChatGptPhysicalApi["send"]>
>;
export type PhysicalPageObservation = Readonly<{
  binding: PhysicalBinding; // Actual host-guarded current view/document.
  operationId: string;
  deadlineMillis: number;
  submission: PhysicalPageSubmission;
  correlation: PhysicalCorrelation;
}>;
export type PhysicalPageContentProfile =
  "message-anchors-v1" | "farol-controlled-settled-segments-v1";
export type PhysicalPageObserveResponse =
  | PhysicalFailure
  | Readonly<{
      state: "observed";
      originBinding: PhysicalBinding;
      binding: PhysicalBinding;
      correlation: PhysicalCorrelation;
      frame: PhysicalFrame | null;
      observed: PhysicalPageObservedSelection;
      sourceProfile: "message-anchors-v1";
    }>;
export type PhysicalPageCancelResponse = Awaited<
  ReturnType<ChatGptPhysicalApi["cancel"]>
>;
export type PhysicalPagePrepareResponse =
  | PhysicalFailure
  | Readonly<{
      readiness:
        "ready" | "sign-in-required" | "awaiting-owner" | "unavailable";
    }>;

// The page receives only public controls and mechanics. Declaration provenance,
// config, account and grant pins never cross this serialization boundary.
// An explicit account observation profile also supplies a mechanical deadline.
export type PageVerify = Pick<
  VerifyInput,
  "binding" | "operationId" | "previous" | "intentDigest"
> & {
  controls: PhysicalPageSelection["controls"];
  requiredControls: PhysicalPageRequiredControls;
  accountDeadlineMillis?: number | undefined;
};
export type PageWitness = PageVerify & {
  account?: ChatGptAccountObservation | undefined;
  evidenceId: string;
  observed: PhysicalPageObservedSelection;
  sourceProfile: "message-anchors-v1";
};
export type PageSend = Pick<
  SendInput,
  "binding" | "operationId" | "intentDigest" | "prompt"
> & { witness: PageWitness; accountDeadlineMillis?: number | undefined };
export type PageSubmission = Omit<PhysicalPageSubmission, "selection"> & {
  controls: PhysicalPageSelection["controls"];
  requiredControls: PhysicalPageRequiredControls;
};
export type PageObservation = Omit<
  PhysicalPageObservation,
  "deadlineMillis" | "submission"
> & { submission: PageSubmission };
export type Request =
  | { action: "prepare"; binding: PhysicalBinding }
  | { action: "verify"; input: PageVerify }
  | { action: "send"; input: PageSend }
  | {
      action: "observe" | "cancel";
      input: PageObservation;
      contentProfile: PhysicalPageContentProfile;
    };
export type Response =
  | PhysicalPagePrepareResponse
  | PhysicalPageVerifyResponse
  | PhysicalPageSendResponse
  | PhysicalPageObserveResponse
  | PhysicalPageCancelResponse;
