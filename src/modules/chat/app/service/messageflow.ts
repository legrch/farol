import type {
  HandoffMessage,
  HandoffMessageResult,
  HandoffRecord,
  HandoffJournal,
  HandoffStatusResult,
} from "../port/handoff";
import { exactProject } from "./exactproject";
import { HandoffNotSubmittedError, type HandoffFlowDeps } from "./handoffdeps";
import {
  isDigest,
  object,
  sameWorkspace,
  validMessage,
  validWorkspace,
} from "./handoffvalidation";
import { messageBindingChanged, messageReplay } from "./recordbinding";
import { threadBound, threadModelBound } from "./threadbinding";
import { steerParams, threadReadParams } from "./turnrequest";

export async function runMessage(
  deps: HandoffFlowDeps,
  readStatus: (dispatchId: string) => Promise<HandoffStatusResult>,
  request: HandoffMessage,
): Promise<HandoffMessageResult> {
  if (!validMessage(request))
    return { status: "refused", code: "HANDOFF_INPUT_INVALID" };
  if (deps.now() >= deps.mutationExpiresAt)
    return { status: "refused", code: "HANDOFF_TASK_ADMISSION_DENIED" };
  const digest = deps.digester.digestMessage(request);
  if (!isDigest(digest))
    return { status: "refused", code: "HANDOFF_DIGEST_INVALID" };
  let record: HandoffRecord | null;
  let prior: Awaited<ReturnType<HandoffJournal["readMessage"]>>;
  try {
    record = await deps.journal.read(request.dispatchId);
    if (!record?.threadId || !record.turnId)
      return { status: "refused", code: "HANDOFF_DISPATCH_UNKNOWN" };
    if (record.adopted)
      return { status: "refused", code: "HANDOFF_ADOPTED_READ_ONLY" };
    if (record.continuedFrom && record.continuationVerified !== true)
      return { status: "outcome_unknown", dispatchId: request.dispatchId };
    if (
      deps.journal.hasUnconfirmedTitle &&
      (await deps.journal.hasUnconfirmedTitle(request.dispatchId))
    )
      return { status: "outcome_unknown", dispatchId: request.dispatchId };
    prior = await deps.journal.readMessage(request.dispatchId, request.key);
  } catch {
    return { status: "outcome_unknown", dispatchId: request.dispatchId };
  }
  if (prior) return messageReplay(prior, digest, record, request.dispatchId);
  if (messageBindingChanged(record, request))
    return { status: "refused", code: "HANDOFF_DISPATCH_BINDING_CHANGED" };
  const turnId = record.turnId;
  const workspace = await deps.authority.resolve(record.workspaceId);
  if (!validWorkspace(workspace) || !sameWorkspace(workspace, record.workspace))
    return { status: "refused", code: "HANDOFF_WORKSPACE_CHANGED" };
  try {
    if (
      !(await exactProject(deps.host, record.projectId, workspace.project.root))
    )
      return {
        status: "refused",
        code: "HANDOFF_PROJECT_AMBIGUOUS_OR_MISSING",
      };
    const response = object(
      await deps.host.request("thread/read", threadReadParams(record.threadId)),
    );
    const thread = object(response?.thread);
    if (
      !record.model ||
      !threadBound(thread, record.threadId, record.projectId, workspace.root) ||
      !threadModelBound(thread, record.model)
    )
      return { status: "outcome_unknown", dispatchId: request.dispatchId };
    const status = await readStatus(request.dispatchId);
    if (status.status !== "known")
      return { status: "outcome_unknown", dispatchId: request.dispatchId };
    if (status.turnId !== turnId || status.turnStatus !== "inProgress")
      return { status: "refused", code: "HANDOFF_TURN_NOT_ACTIVE" };
    const stillApproved = await deps.authority.resolve(record.workspaceId);
    if (
      !validWorkspace(stillApproved) ||
      !sameWorkspace(stillApproved, workspace)
    )
      return { status: "refused", code: "HANDOFF_WORKSPACE_CHANGED" };
  } catch {
    return { status: "outcome_unknown", dispatchId: request.dispatchId };
  }
  let claim: "claimed" | "existing" | "conflict";
  try {
    claim = await deps.journal.claimMessage(
      request.dispatchId,
      request.key,
      digest,
    );
  } catch {
    return { status: "outcome_unknown", dispatchId: request.dispatchId };
  }
  if (claim === "conflict")
    return { status: "refused", code: "HANDOFF_KEY_CONFLICT" };
  if (claim !== "claimed")
    return { status: "outcome_unknown", dispatchId: request.dispatchId };
  // The durable intent precedes the only host side effect. A lost response
  // or failed receipt never permits a replay with the same or a new key.
  try {
    const atSend = await deps.authority.resolve(record.workspaceId);
    if (
      deps.now() >= deps.mutationExpiresAt ||
      !validWorkspace(atSend) ||
      !sameWorkspace(atSend, workspace)
    )
      return { status: "outcome_unknown", dispatchId: request.dispatchId };
    await deps.mutationGate.run(
      async () => {
        if (
          deps.journal.hasUnconfirmedTitle &&
          (await deps.journal.hasUnconfirmedTitle(request.dispatchId))
        )
          throw new Error("HANDOFF_TITLE_UNCONFIRMED");
        const stillCurrent = await deps.authority.resolve(record.workspaceId);
        if (
          deps.now() >= deps.mutationExpiresAt ||
          !validWorkspace(stillCurrent) ||
          !sameWorkspace(stillCurrent, workspace)
        )
          throw new Error("HANDOFF_PREFLIGHT_DENIED");
      },
      async () => {
        if (deps.now() >= deps.mutationExpiresAt)
          throw new HandoffNotSubmittedError("HANDOFF_TASK_ADMISSION_DENIED");
        const response = object(
          await deps.host.request(
            "turn/steer",
            steerParams(record.threadId, turnId, request.message, request.key),
            deps.mutationExpiresAt,
          ),
        );
        if (response?.turnId !== turnId)
          throw new Error("HANDOFF_STEER_UNVERIFIED");
      },
      (error) => error instanceof HandoffNotSubmittedError,
    );
    await deps.journal.recordMessage(request.dispatchId, request.key, turnId);
    return {
      status: "steered",
      dispatchId: request.dispatchId,
      turnId,
    };
  } catch {
    return { status: "outcome_unknown", dispatchId: request.dispatchId };
  }
}
