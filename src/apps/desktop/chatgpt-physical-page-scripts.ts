import { z } from "zod";
import { readChatGptAccount } from "../../../apps/desktop/chatgpt-account-probe";
import type { PhysicalBinding } from "../../../apps/desktop/chatgpt-physical-api";
import {
  readPublicAssistantMessages,
  publicContentVisible,
} from "./chatgpt-public-turn";
import { publicMarkdownBlock } from "./chatgpt-public-markdown";
import {
  bindingSchema,
  idSchema,
  observationSchema,
  policySchema,
  sendSchema,
  verifySchema,
} from "../../../apps/desktop/physical/schema";
import { physicalComposerDraft } from "../../../apps/desktop/physical/draft";
import type {
  PageObservation,
  PhysicalPageContentProfile,
  PhysicalPageObservation,
  PhysicalPagePolicy,
  Request,
  SendInput,
  VerifyInput,
} from "../../../apps/desktop/physical/model";
import { physicalPage } from "../../../apps/desktop/physical/page";

export { physicalComposerDraft };

export type {
  PhysicalPageCancelResponse,
  PhysicalPageContentProfile,
  PhysicalPageObservation,
  PhysicalPageObservedSelection,
  PhysicalPageObserveResponse,
  PhysicalPagePolicy,
  PhysicalPagePrepareResponse,
  PhysicalPageRequiredControls,
  PhysicalPageSelection,
  PhysicalPageSendInput,
  PhysicalPageSendResponse,
  PhysicalPageSubmission,
  PhysicalPageVerifyResponse,
} from "../../../apps/desktop/physical/model";
const productionPolicy: PhysicalPagePolicy = { e2eOrigin: null };

function script(request: Request, policy: PhysicalPagePolicy): string {
  const parsed = policySchema.safeParse(policy);
  if (
    !parsed.success ||
    ("contentProfile" in request &&
      parsed.data.contentProfile !== undefined &&
      request.contentProfile !== parsed.data.contentProfile)
  ) {
    const failure = {
      state: request.action === "send" ? "not-sent" : "refused",
      code: "PHYSICAL_POLICY_INVALID",
      ...(request.action === "send"
        ? {
            binding: request.input.binding,
            operationId: request.input.operationId,
            evidenceId: request.input.witness.evidenceId,
          }
        : {}),
    };
    return `(${JSON.stringify(failure)})`;
  }
  const contentProfile =
    "contentProfile" in request
      ? request.contentProfile
      : (parsed.data.contentProfile ?? "message-anchors-v1");
  return `(${physicalPage.toString()})(${JSON.stringify(request)},${readPublicAssistantMessages.toString()},${publicMarkdownBlock.toString()},${publicContentVisible.toString()},${JSON.stringify(parsed.data.e2eOrigin)},${JSON.stringify(parsed.data.accountObservationProfile ?? null)},${parsed.data.accountObservationProfile ? readChatGptAccount.toString() : "null"},${JSON.stringify(contentProfile)},${physicalComposerDraft.toString()})`;
}
const invalid = '({state:"refused",code:"PHYSICAL_INPUT_INVALID"})';
export function physicalPrepareProbeScript(
  binding: PhysicalBinding,
  policy: PhysicalPagePolicy = productionPolicy,
): string {
  const parsed = bindingSchema.safeParse(binding);
  return parsed.success
    ? script({ action: "prepare", binding: parsed.data }, policy)
    : invalid;
}
export function physicalVerifySendScript(
  input: VerifyInput,
  policy: PhysicalPagePolicy = productionPolicy,
): string {
  const physicalSelection = input.selection;
  const parsed = verifySchema.safeParse({
    binding: input.binding,
    operationId: input.operationId,
    previous: input.previous,
    intentDigest: input.intentDigest,
    controls: physicalSelection?.controls,
    requiredControls: physicalSelection?.requiredControls,
    ...(policy.accountObservationProfile
      ? { accountDeadlineMillis: input.deadlineMillis }
      : {}),
  });
  return parsed.success
    ? script({ action: "verify", input: parsed.data }, policy)
    : invalid;
}
export function physicalSendScript(
  input: SendInput,
  policy: PhysicalPagePolicy = productionPolicy,
): string {
  const witness = input.witness;
  const physicalSelection = witness.selection.declared;
  const parsed = sendSchema.safeParse({
    binding: input.binding,
    operationId: input.operationId,
    intentDigest: input.intentDigest,
    prompt: input.prompt,
    ...(policy.accountObservationProfile
      ? { accountDeadlineMillis: input.deadlineMillis }
      : {}),
    witness: {
      binding: witness.binding,
      operationId: witness.operationId,
      evidenceId: witness.evidenceId,
      intentDigest: witness.intentDigest,
      previous: witness.previous,
      controls: physicalSelection?.controls,
      requiredControls: physicalSelection?.requiredControls,
      observed: witness.selection.observed,
      sourceProfile: witness.selection.sourceProfile,
      ...(witness.account
        ? {
            account: witness.account,
            accountDeadlineMillis: witness.deadlineMillis,
          }
        : {}),
    },
  });
  if (parsed.success)
    return script({ action: "send", input: parsed.data }, policy);
  const bound = z
    .strictObject({
      binding: bindingSchema,
      operationId: idSchema,
      evidenceId: idSchema,
    })
    .safeParse({
      binding: input.binding,
      operationId: input.operationId,
      evidenceId: witness.evidenceId,
    });
  return bound.success
    ? `(${JSON.stringify({ ...bound.data, state: "not-sent", code: "PHYSICAL_INPUT_INVALID" })})`
    : invalid;
}
export function physicalObserveScript(
  input: PhysicalPageObservation,
  contentProfile: PhysicalPageContentProfile | undefined = undefined,
  policy: PhysicalPagePolicy = productionPolicy,
): string {
  const selectedProfile =
    contentProfile ?? policy.contentProfile ?? "message-anchors-v1";
  const parsed = observationSchema.safeParse(projectObservation(input));
  return parsed.success &&
    ["message-anchors-v1", "farol-controlled-settled-segments-v1"].includes(
      selectedProfile,
    )
    ? script(
        {
          action: "observe",
          input: parsed.data,
          contentProfile: selectedProfile,
        },
        policy,
      )
    : invalid;
}
export function physicalCancelScript(
  input: PhysicalPageObservation,
  contentProfile: PhysicalPageContentProfile | undefined = undefined,
  policy: PhysicalPagePolicy = productionPolicy,
): string {
  const selectedProfile =
    contentProfile ?? policy.contentProfile ?? "message-anchors-v1";
  const parsed = observationSchema.safeParse(projectObservation(input));
  return parsed.success &&
    ["message-anchors-v1", "farol-controlled-settled-segments-v1"].includes(
      selectedProfile,
    )
    ? script(
        {
          action: "cancel",
          input: parsed.data,
          contentProfile: selectedProfile,
        },
        policy,
      )
    : invalid;
}

function projectObservation(input: PhysicalPageObservation): PageObservation {
  const submission = input.submission;
  return {
    binding: input.binding,
    operationId: input.operationId,
    correlation: input.correlation,
    submission: {
      originBinding: submission.originBinding,
      operationId: submission.operationId,
      evidenceId: submission.evidenceId,
      intentDigest: submission.intentDigest,
      promptDigest: submission.promptDigest,
      baselineUserIds: submission.baselineUserIds,
      previous: submission.previous,
      controls: submission.selection.controls,
      requiredControls: submission.selection.requiredControls,
    },
  };
}
