import type { ProductConfigurationEvidence } from "../../../src/pkg/product-settings/contract";
import type { WindowSnapshot } from "../../../src/ui/renderer/contract";
import type { EditReceipt, ObservedEdit, SubmittedEdit } from "./snapshot";

/** Who an edit preview belongs to: one build, one computer, one generation. */
export type EditOwner = Pick<
  EditReceipt,
  "buildId" | "computerId" | "generation"
>;

/** The reply fields the observation decision reads; nothing else is trusted. */
export type EditReply = Readonly<{
  state: "pending" | "applied" | "refused" | "unknown";
  code: string | null;
}>;

/** True when `current` is a live snapshot of the receipt's owner. */
export function sameEditOwner(
  receipt: EditReceipt,
  current: WindowSnapshot,
): boolean {
  return (
    current.status === "current" &&
    current.buildId === receipt.buildId &&
    current.configuration?.status === "ready" &&
    current.configuration.settings.computer.computerId === receipt.computerId &&
    current.configuration.settings.computer.generation === receipt.generation
  );
}

/** True when `current` is the owner and its pending edit is the receipt's. */
export function samePendingEdit(
  receipt: EditReceipt,
  current: WindowSnapshot,
): boolean {
  const pending =
    current.configuration?.status === "ready"
      ? current.configuration.settings.computer.pendingEdit
      : null;
  return (
    sameEditOwner(receipt, current) &&
    pending?.operationId === receipt.preview.operationId &&
    pending.workspaceId === receipt.preview.workspaceId &&
    pending.relativePath === receipt.preview.relativePath &&
    pending.computerGeneration === receipt.generation
  );
}

/**
 * True when `snapshot` still shows exactly the configuration and preview the
 * receipt recorded, by reference, and belongs to the receipt's owner.
 */
export function receiptMatchesSnapshot(
  receipt: EditReceipt,
  snapshot: WindowSnapshot,
): boolean {
  return (
    snapshot.configuration === receipt.configuration &&
    snapshot.evidence?.value === receipt.preview &&
    sameEditOwner(receipt, snapshot)
  );
}

/**
 * The settlement a reply proves for the receipt's preview, or null: a refusal
 * always settles; an applied reply only as the matching workspace edit
 * mutation.
 */
export function settledEditState(
  receipt: EditReceipt,
  result: EditReply,
  value: ProductConfigurationEvidence | null | undefined,
): "applied" | "refused" | null {
  if (result.state === "refused") return "refused";
  if (
    result.state === "applied" &&
    value?.kind === "computer.workspace-mutation" &&
    value.operation === "edit" &&
    value.operationId === receipt.preview.operationId &&
    value.workspaceId === receipt.preview.workspaceId &&
    value.relativePath === receipt.preview.relativePath &&
    value.beforeSha256 === receipt.preview.beforeSha256
  )
    return "applied";
  return null;
}

/**
 * Whether an acknowledgement may settle the observed edit: the observation is
 * still the one the window shows, the edit is still pending for its owner
 * before the reply and gone after it, and the settings revision advanced.
 */
export function settlesAcknowledgedEdit(
  acknowledged: ObservedEdit | undefined,
  operationId: string,
  before: WindowSnapshot,
  current: WindowSnapshot,
): acknowledged is ObservedEdit {
  return (
    acknowledged?.submitted.receipt != null &&
    before.workspaceEditDelivery === operationId &&
    before.configuration === acknowledged.configuration &&
    before.evidence === acknowledged.evidence &&
    samePendingEdit(acknowledged.submitted.receipt, before) &&
    sameEditOwner(acknowledged.submitted.receipt, current) &&
    before.configuration?.status === "ready" &&
    current.configuration?.status === "ready" &&
    current.configuration.settings.revision >
      before.configuration.settings.revision &&
    current.configuration.settings.computer.pendingEdit === null
  );
}

export type EditRegistryPorts = Readonly<{
  /** The window's snapshot at the moment of the call. */
  snapshot: () => WindowSnapshot;
}>;

export type ObservationInput = Readonly<{
  /** The snapshot captured before the command was sent. */
  before: WindowSnapshot;
  /** Operation the reply delivered for acknowledgement, if any. */
  delivery: string | null;
  /** The reply carries a current, latest-ordered configuration revision. */
  settled: boolean;
  result: EditReply;
  value: ProductConfigurationEvidence | null | undefined;
}>;

/**
 * Window-local provenance and permanent consumption of workspace edits, never
 * backend authority. Owns the three receipt maps; the caller owns every
 * revision counter and bridge call.
 */
export type EditRegistry = Readonly<{
  /** Retained preview receipt for an operation, if any. */
  preview: (operationId: string) => EditReceipt | undefined;
  /** Observed settlement awaiting acknowledgement, if any. */
  observed: (operationId: string) => ObservedEdit | undefined;
  /**
   * Retain a preview for its owner. A different preview already retained for
   * the same operation is never replaced: `unconfirmed`.
   */
  retainPreview: (
    preview: EditReceipt["preview"],
    owner: EditOwner,
  ) => "retained" | "unconfirmed";
  /**
   * Consume an operation ID for its single Apply. A second Apply is
   * `consumed`. The submission keeps the retained receipt only while `before`
   * still matches it; otherwise it is recorded without provenance.
   */
  submit: (
    operationId: string,
    intention: string,
    before: WindowSnapshot,
  ) => "submitted" | "consumed";
  /**
   * Supersede any earlier observation of the operation and keep a new one only
   * when the reply is settlement evidence for the submitted receipt.
   */
  observe: (operationId: string, input: ObservationInput) => boolean;
  /** Drop the observation of an operation. The submission stays consumed. */
  forgetObserved: (operationId: string) => void;
}>;

export function createEditRegistry(ports: EditRegistryPorts): EditRegistry {
  const previews = new Map<string, EditReceipt>();
  const submitted = new Map<string, SubmittedEdit>();
  const observed = new Map<string, ObservedEdit>();
  return {
    preview: (operationId) => previews.get(operationId),
    observed: (operationId) => observed.get(operationId),
    retainPreview(preview, owner) {
      const retained = previews.get(preview.operationId);
      if (
        retained &&
        (retained.buildId !== owner.buildId ||
          retained.computerId !== owner.computerId ||
          retained.generation !== owner.generation ||
          JSON.stringify(retained.preview) !== JSON.stringify(preview))
      )
        return "unconfirmed";
      previews.set(preview.operationId, {
        preview,
        configuration: ports.snapshot().configuration,
        buildId: owner.buildId,
        computerId: owner.computerId,
        generation: owner.generation,
      });
      return "retained";
    },
    submit(operationId, intention, before) {
      if (submitted.has(operationId)) return "consumed";
      const receipt = previews.get(operationId);
      submitted.set(operationId, {
        intention,
        receipt:
          receipt && receiptMatchesSnapshot(receipt, before) ? receipt : null,
      });
      return "submitted";
    },
    observe(operationId, input) {
      observed.delete(operationId);
      const entry = submitted.get(operationId);
      const receipt = entry?.receipt;
      const current = ports.snapshot();
      if (
        !entry ||
        !receipt ||
        input.delivery !== operationId ||
        !input.settled ||
        !samePendingEdit(receipt, input.before) ||
        !samePendingEdit(receipt, current)
      )
        return false;
      const state = settledEditState(receipt, input.result, input.value);
      if (state === null) return false;
      observed.set(operationId, {
        submitted: entry,
        configuration: current.configuration,
        evidence: current.evidence,
        state,
        code: input.result.code,
      });
      return true;
    },
    forgetObserved: (operationId) => {
      observed.delete(operationId);
    },
  };
}
