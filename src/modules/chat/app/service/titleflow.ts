import type { HandoffTitleRequest, HandoffTitleResult } from "../port/handoff";
import { mutationAdmitted } from "./admission";
import { HandoffNotSubmittedError, type HandoffFlowDeps } from "./handoffdeps";
import {
  isDigest,
  object,
  sameWorkspace,
  validTitle,
  validWorkspace,
} from "./handoffvalidation";
import { titleBindingChanged, titleReplay } from "./recordbinding";
import { resolveCodexProjectCatalogue } from "./resolve-codex-project-catalogue";
import { boundTitleName } from "./threadbinding";
import { threadReadParams } from "./turnrequest";

export async function runTitle(
  deps: HandoffFlowDeps,
  request: HandoffTitleRequest,
  context: Readonly<{ signal?: AbortSignal | undefined }> = {},
): Promise<HandoffTitleResult> {
  const unknown: HandoffTitleResult = {
    status: "outcome_unknown",
    dispatchId: request.dispatchId,
  };
  if (!validTitle(request))
    return { status: "refused", code: "HANDOFF_TITLE_INPUT_INVALID" };
  const admitted = () =>
    mutationAdmitted(context.signal, deps.now, deps.mutationExpiresAt);
  if (!admitted())
    return { status: "refused", code: "HANDOFF_TASK_ADMISSION_DENIED" };
  if (
    !deps.journal.claimTitle ||
    !deps.journal.readTitle ||
    !deps.journal.recordTitle ||
    !deps.digester.digestTitle
  )
    return { status: "refused", code: "HANDOFF_TITLE_UNAVAILABLE" };
  const digest = deps.digester.digestTitle(request);
  if (!isDigest(digest))
    return { status: "refused", code: "HANDOFF_DIGEST_INVALID" };
  try {
    const record = await deps.journal.read(request.dispatchId);
    if (!record?.threadId || !record.turnId)
      return { status: "refused", code: "HANDOFF_DISPATCH_UNKNOWN" };
    if (record.adopted)
      return { status: "refused", code: "HANDOFF_ADOPTED_READ_ONLY" };
    if (record.continuedFrom && record.continuationVerified !== true)
      return unknown;
    if (titleBindingChanged(record, request))
      return { status: "refused", code: "HANDOFF_DISPATCH_BINDING_CHANGED" };
    const workspace = await deps.authority.resolve(record.workspaceId);
    if (
      !validWorkspace(workspace) ||
      !sameWorkspace(workspace, record.workspace)
    )
      return { status: "refused", code: "HANDOFF_WORKSPACE_CHANGED" };
    if (!admitted())
      return { status: "refused", code: "HANDOFF_TASK_ADMISSION_DENIED" };
    const prior = await deps.journal.readTitle(request.dispatchId, request.key);
    if (!admitted())
      return { status: "refused", code: "HANDOFF_TASK_ADMISSION_DENIED" };
    if (prior) return titleReplay(prior, digest, record, request, unknown);
    if (
      deps.journal.hasUnconfirmedMessage &&
      (await deps.journal.hasUnconfirmedMessage(request.dispatchId))
    )
      return unknown;
    const catalogue = await resolveCodexProjectCatalogue(
      deps.host,
      workspace.project.root,
      record.projectId,
      deps.mutationExpiresAt,
      admitted,
    );
    if (!admitted())
      return { status: "refused", code: "HANDOFF_TASK_ADMISSION_DENIED" };
    if (catalogue.status === "unavailable") return unknown;
    if (
      catalogue.status !== "resolved" ||
      catalogue.selectedProjectId !== record.projectId
    )
      return {
        status: "refused",
        code: "HANDOFF_PROJECT_AMBIGUOUS_OR_MISSING",
      };
    const readName = async () => {
      if (!admitted())
        throw new HandoffNotSubmittedError("HANDOFF_TASK_ADMISSION_DENIED");
      const response = object(
        await deps.host.request(
          "thread/read",
          threadReadParams(record.threadId),
          deps.mutationExpiresAt,
        ),
      );
      const name = boundTitleName(object(response?.thread), {
        threadId: record.threadId!,
        projectId: record.projectId,
        root: workspace.root,
        model: record.model,
      });
      if (name === undefined)
        throw new Error("HANDOFF_TITLE_THREAD_UNVERIFIED");
      if (!admitted())
        throw new HandoffNotSubmittedError("HANDOFF_TASK_ADMISSION_DENIED");
      return name;
    };
    const currentName = await readName();
    const current = await deps.authority.resolve(record.workspaceId);
    if (!validWorkspace(current) || !sameWorkspace(current, workspace))
      return { status: "refused", code: "HANDOFF_WORKSPACE_CHANGED" };
    if (!admitted())
      return { status: "refused", code: "HANDOFF_TASK_ADMISSION_DENIED" };
    if (currentName !== request.expectedTitle)
      return {
        status: "title_changed",
        dispatchId: request.dispatchId,
        title: currentName,
      };
    const claim = await deps.journal.claimTitle(
      request.dispatchId,
      request.key,
      digest,
    );
    if (claim === "conflict")
      return { status: "refused", code: "HANDOFF_KEY_CONFLICT" };
    if (claim !== "claimed") return unknown;
    // One durable dispatch-scoped intent, before the only provider mutation.
    // An uncertain acknowledgement/readback/publication can never be resent.
    await deps.mutationGate.run(
      async () => {
        if ((await readName()) !== request.expectedTitle)
          throw new HandoffNotSubmittedError("HANDOFF_TITLE_CHANGED");
        if (
          deps.journal.hasUnconfirmedMessage &&
          (await deps.journal.hasUnconfirmedMessage(request.dispatchId))
        )
          throw new HandoffNotSubmittedError("HANDOFF_MESSAGE_UNCONFIRMED");
        const atSend = await deps.authority.resolve(record.workspaceId);
        if (
          !admitted() ||
          !validWorkspace(atSend) ||
          !sameWorkspace(atSend, workspace)
        )
          throw new HandoffNotSubmittedError("HANDOFF_TITLE_PREFLIGHT_DENIED");
      },
      async () => {
        if (!admitted())
          throw new HandoffNotSubmittedError("HANDOFF_TASK_ADMISSION_DENIED");
        if (
          !object(
            await deps.host.request(
              "thread/name/set",
              { threadId: record.threadId, name: request.title },
              deps.mutationExpiresAt,
            ),
          )
        )
          throw new Error("HANDOFF_TITLE_ACK_UNVERIFIED");
        try {
          if ((await readName()) !== request.title)
            throw new Error("HANDOFF_TITLE_READBACK_CHANGED");
          const after = await deps.authority.resolve(record.workspaceId);
          if (
            !admitted() ||
            !validWorkspace(after) ||
            !sameWorkspace(after, workspace)
          )
            throw new Error("HANDOFF_TITLE_READBACK_REVOKED");
          await deps.journal.recordTitle!(
            request.dispatchId,
            request.key,
            record.threadId!,
          );
          const published = await deps.authority.resolve(record.workspaceId);
          if (
            !admitted() ||
            !validWorkspace(published) ||
            !sameWorkspace(published, workspace)
          )
            throw new Error("HANDOFF_TITLE_RECEIPT_ADMISSION_EXPIRED");
        } catch {
          // The mutation has been acknowledged. A later read/publication failure
          // is not a no-submit error, even if the read deadline then expires.
          throw new Error("HANDOFF_TITLE_POST_MUTATION_UNVERIFIED");
        }
      },
      (error) => error instanceof HandoffNotSubmittedError,
    );
    return {
      status: "renamed",
      dispatchId: request.dispatchId,
      title: request.title,
      proof: "readback",
    };
  } catch {
    return unknown;
  }
}
