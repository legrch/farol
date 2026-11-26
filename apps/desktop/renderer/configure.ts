import type { ReadConversationView } from "../../../src/pkg/product-settings/chat-conversation";
import {
  ProductConfigurationCommandSchema,
  type ProductConfigurationCommand,
  type ProductConfigurationEvidence,
} from "../../../src/pkg/product-settings/contract";
import {
  configurationEffectOutcome,
  type ConfigurationOutcome,
} from "../../../src/ui/configuration-outcome";
import {
  workspaceReadbackBinding,
  type WorkspaceReadbackBinding,
} from "../../../src/ui/guided-workspace-access";
import type {
  Destination,
  Intent,
  WindowSnapshot,
} from "../../../src/ui/renderer/contract";
import { credentialRecoveryMatches } from "../../../src/ui/renderer/command-eligibility";
import type { EditOwner } from "./edits";

/*
 * The pure decisions the controller makes around a configuration command:
 * what is sent, what is refused before the bridge is called, and which reply
 * is trustworthy enough to become a receipt. Every function here reads only
 * its arguments. The controller keeps each `patch`, revision counter, await,
 * bridge call and the dedupe fingerprint maps, and calls these where the
 * inline code stood.
 */

type Evidence = ProductConfigurationEvidence | undefined;
type Answered = Exclude<ConfigurationOutcome, { kind: "unconfirmed" }>;

const refusal = (id: string, code: string): Intent => ({
  id,
  state: "refused",
  code,
});
const unknown = (id: string, code: string): Intent => ({
  id,
  state: "unknown",
  code,
});

// ---------------------------------------------------------------------------
// Admission: validate, then route.

/** Where a validated command goes next; a refusal carries its final intent. */
export type ConfigureAdmission =
  | Readonly<{ route: "refuse"; intent: Intent }>
  | Readonly<{ route: "present-browser" }>
  | Readonly<{ route: "dispatch"; command: ProductConfigurationCommand }>;

/**
 * Parse an unknown boundary value and route it. The parsed copy is what the
 * controller sends, so a caller mutating its own object after the call cannot
 * change the original operation or its receipt correlation.
 */
export function admitConfiguration(
  value: ProductConfigurationCommand,
  intention: string,
): ConfigureAdmission {
  const parsed = ProductConfigurationCommandSchema.safeParse(value);
  if (!parsed.success)
    return {
      route: "refuse",
      intent: refusal(intention, "SETTINGS_INPUT_INVALID"),
    };
  const command = parsed.data;
  if (command.kind === "chatgpt.observe-sign-in")
    return {
      route: "refuse",
      intent: refusal(intention, "SIGN_IN_OBSERVATION_WINDOW_OWNED"),
    };
  if (command.kind === "chatgpt.present-browser")
    return { route: "present-browser" };
  return { route: "dispatch", command };
}

// ---------------------------------------------------------------------------
// Pre-dispatch sign-in hooks.

/** True when the destination is the setup sign-in step. */
export function onSetupSignIn(destination: Destination): boolean {
  return destination.area === "setup" && destination.setupStep === "signin";
}

/**
 * An owner sign-in attempt made from the setup sign-in step. It supersedes
 * the previous document's authenticated observation and verification.
 */
export function startsSignInAttempt(
  command: ProductConfigurationCommand,
  destination: Destination,
): boolean {
  return (
    (command.kind === "chatgpt.open-sign-in" ||
      command.kind === "chatgpt.open-browser") &&
    onSetupSignIn(destination)
  );
}

/**
 * The automatic-check key a fresh sign-in attempt must forget: the previous
 * check, only while it still belongs to this build and its verification was
 * applied. Null when nothing is stale.
 */
export function staleAutomaticSignInCheck(
  state: WindowSnapshot,
): string | null {
  const prior = state.setupSignInCheck;
  if (
    prior &&
    prior.buildId === state.buildId &&
    state.intents["settings:chatgpt.verify:"]?.state === "applied"
  )
    return `${prior.buildId}:${prior.binding.documentGeneration}`;
  return null;
}

/** Commands that can reveal a native surface, so navigation commits first. */
export function opensNativeSurface(
  command: ProductConfigurationCommand,
): boolean {
  return (
    command.kind === "chatgpt.open-sign-in" ||
    command.kind === "chatgpt.open-browser" ||
    command.kind === "connector.verify-app" ||
    command.kind === "connector.verify-separate-app"
  );
}

/**
 * The setup sign-in return a surface-opening command should record, or null
 * when it records none. The controller keeps an earlier return if one exists.
 */
export function signInReturnTarget(
  command: ProductConfigurationCommand,
  requested: Destination,
): Destination | null {
  if (command.kind === "chatgpt.open-sign-in" || onSetupSignIn(requested))
    return {
      ...requested,
      area: "setup",
      page: "general",
      setupStep: "signin",
    } as Destination;
  return null;
}

// ---------------------------------------------------------------------------
// In-flight pre-send decisions.

/** A connector setup bound to another build is refused before the bridge. */
export function connectorSetupRefusal(
  command: ProductConfigurationCommand,
  buildId: string | null,
  intention: string,
): Intent | null {
  return command.kind === "connector.save-and-connect" &&
    command.buildId !== buildId
    ? refusal(intention, "CONNECTOR_SETUP_BINDING_CHANGED")
    : null;
}

/**
 * The intents after a credential retry settled. A save-and-connect that main
 * accepted over its retained recovery completed the change the earlier
 * attempts began, so their uncertain receipts are rewritten as applied, the
 * way an acknowledged edit settles its Apply. Null when nothing is rewritten:
 * another command, a result that is not applied, or a window whose flag did not
 * name the fenced document when the retry was sent.
 */
export function settledRecoveryAttempts(
  command: ProductConfigurationCommand,
  result: Intent,
  before: WindowSnapshot,
  current: WindowSnapshot,
): WindowSnapshot["intents"] | null {
  if (
    command.kind !== "connector.save-and-connect" ||
    result.state !== "applied" ||
    !credentialRecoveryMatches(before)
  )
    return null;
  const earlier = Object.values(current.intents).filter(
    (intent) =>
      intent.id !== result.id &&
      intent.id.startsWith("settings:connector.save-and-connect:") &&
      (intent.state === "unknown" || intent.code === "SETTINGS_WRITE_FAILED"),
  );
  if (earlier.length === 0) return null;
  return {
    ...current.intents,
    ...Object.fromEntries(
      earlier.map((intent): [string, Intent] => [
        intent.id,
        { id: intent.id, state: "applied", code: null },
      ]),
    ),
  };
}

/** A workspace edit that was already consumed cannot be applied twice. */
export function workspaceEditConsumedRefusal(intention: string): Intent {
  return refusal(intention, "WORKSPACE_EDIT_ALREADY_CONSUMED");
}

/**
 * The readback binding a workspace verification or folder check must record
 * before it is sent, or null when the snapshot cannot supply one.
 */
export function workspaceReadbackFor(
  command: ProductConfigurationCommand,
  before: WindowSnapshot,
): WorkspaceReadbackBinding | null {
  if (
    (command.kind === "computer.verify-workspace" ||
      command.kind === "computer.check-folder") &&
    before.configuration?.status === "ready" &&
    before.buildId
  )
    return workspaceReadbackBinding(
      before.configuration.settings,
      before.buildId,
      command,
    );
  return null;
}

// ---------------------------------------------------------------------------
// Receipts: which reply is trustworthy.

/**
 * Evidence or a connector receipt that does not answer the command it was
 * sent for. Success without the matching proof is unknown, never applied.
 */
export function unconfirmedReceipt(
  command: ProductConfigurationCommand,
  result: Answered["result"],
  intention: string,
  before: WindowSnapshot,
  current: WindowSnapshot,
): Intent | null {
  if (
    command.kind === "chatgpt.run-deep-test" &&
    result.ok &&
    (result.evidence?.kind !== "chatgpt.deep-test-result" ||
      result.evidence.operationId !== command.operationId)
  )
    return unknown(intention, "CHATGPT_CONVERSATION_UNCONFIRMED");
  if (
    command.kind === "connector.test-connection" &&
    result.ok &&
    (result.evidence?.kind !== "connector.connection-check" ||
      result.evidence.operationId !== command.operationId)
  )
    return unknown(intention, "CONNECTION_CHECK_UNCONFIRMED");
  if (command.kind === "connector.save-and-connect") {
    const receipt = result.connectorSetup;
    if (
      !receipt ||
      receipt.operationId !== command.operationId ||
      receipt.buildId !== command.buildId ||
      receipt.buildId !== before.buildId ||
      current.buildId !== before.buildId ||
      current.status === "incompatible"
    )
      return outcomeUnknown(intention);
  }
  return null;
}

/** The unknown intent for a reply that could not be confirmed. */
export function outcomeUnknown(intention: string): Intent {
  return unknown(intention, "CONFIGURATION_OUTCOME_UNKNOWN");
}

/** The five commands whose replies feed the read-only conversation view. */
export type ReadConversationCommand = Extract<
  ProductConfigurationCommand,
  {
    kind:
      | "chatgpt.submit-readonly-task"
      | "chatgpt.start-conversation"
      | "chatgpt.observe-readonly-conversation"
      | "chatgpt.ack-readonly-conversation"
      | "chatgpt.follow-readonly-conversation";
  }
>;

export function isReadConversationCommand(
  command: ProductConfigurationCommand,
): command is ReadConversationCommand {
  return (
    command.kind === "chatgpt.submit-readonly-task" ||
    command.kind === "chatgpt.start-conversation" ||
    command.kind === "chatgpt.observe-readonly-conversation" ||
    command.kind === "chatgpt.ack-readonly-conversation" ||
    command.kind === "chatgpt.follow-readonly-conversation"
  );
}

/** The input `adoptReadConversation` takes; this module only builds it. */
export type ReadConversationInput = Readonly<{
  action: "start" | "typed-start" | "progress" | "ack" | "follow";
  sessionId?: string;
  operationId: string;
  handleId?: string;
  cursor?: string;
  resultId?: string;
  buildId: string;
  revision: number;
}>;

/**
 * The adoption a conversation reply is eligible for, or null. An independent
 * refresh may win configuration snapshot ordering, so correlation uses the
 * exact current revision, build and retained owner, never the older snapshot.
 * A start must find the very preview it was sent from, by reference.
 */
export function readConversationAdoption(
  command: ReadConversationCommand,
  value: Evidence,
  before: WindowSnapshot,
  current: WindowSnapshot,
  revision: number | null,
): Readonly<{
  view: ReadConversationView;
  input: ReadConversationInput;
}> | null {
  const start = command.kind === "chatgpt.submit-readonly-task";
  const typedStart = command.kind === "chatgpt.start-conversation";
  const inspected = before.directChatPreview;
  const exactTypedStart =
    typedStart &&
    inspected &&
    inspected.value.operationId === command.operationId &&
    inspected.value.confirmationId === command.confirmationId &&
    inspected.buildId === before.buildId &&
    inspected.revision === revision &&
    current.directChatPreview === inspected;
  const first = before.readPreview;
  const exactStart =
    start &&
    first &&
    first.value.operationId === command.operationId &&
    first.value.account?.state === "approved" &&
    first.buildId === before.buildId &&
    first.revision === revision &&
    current.readPreview === first;
  if (
    value?.kind !== "chatgpt.readonly-conversation" ||
    current.status !== "current" ||
    !before.buildId ||
    before.buildId !== current.buildId ||
    revision === null ||
    (start && !exactStart) ||
    (typedStart && !exactTypedStart) ||
    before.readConversation !== current.readConversation
  )
    return null;
  return {
    view: value,
    input: {
      action: typedStart
        ? "typed-start"
        : start
          ? "start"
          : command.kind === "chatgpt.observe-readonly-conversation"
            ? "progress"
            : command.kind === "chatgpt.ack-readonly-conversation"
              ? "ack"
              : "follow",
      operationId: command.operationId,
      ...(typedStart && inspected
        ? { sessionId: inspected.value.sessionId }
        : {}),
      ...("handleId" in command ? { handleId: command.handleId } : {}),
      ...("cursor" in command ? { cursor: command.cursor } : {}),
      ...("resultId" in command ? { resultId: command.resultId } : {}),
      buildId: before.buildId,
      revision,
    },
  };
}

/** Whether a reply may be kept, or the unknown intent that replaces it. */
export type ReceiptDecision<T> =
  | Readonly<{ kind: "retain"; receipt: T }>
  | Readonly<{ kind: "unconfirmed"; intent: Intent }>;

type DirectChatPreview = NonNullable<WindowSnapshot["directChatPreview"]>;
type ReadPreview = NonNullable<WindowSnapshot["readPreview"]>;

/** The direct chat account preview a `chatgpt.inspect-chat-account` earns. */
export function directChatPreviewReceipt(
  command: Extract<
    ProductConfigurationCommand,
    { kind: "chatgpt.inspect-chat-account" }
  >,
  intention: string,
  value: Evidence,
  before: WindowSnapshot,
  current: WindowSnapshot,
  revision: number | null,
): ReceiptDecision<DirectChatPreview> {
  if (
    revision === null ||
    before.configuration?.status !== "ready" ||
    revision !== before.configuration.settings.revision ||
    !before.buildId ||
    before.buildId !== current.buildId ||
    current.status !== "current" ||
    current.directChatPreview !== null ||
    before.readConversation !== null ||
    value?.kind !== "chatgpt.chat-account-preview" ||
    value.operationId !== command.operationId
  )
    return {
      kind: "unconfirmed",
      intent: unknown(intention, "CHAT_ACCOUNT_UNCONFIRMED"),
    };
  return {
    kind: "retain",
    receipt: { intention, buildId: before.buildId, revision, value },
  };
}

/** The read-only task preview a `chatgpt.prepare-readonly-task` earns. */
export function readPreviewReceipt(
  command: Extract<
    ProductConfigurationCommand,
    { kind: "chatgpt.prepare-readonly-task" }
  >,
  intention: string,
  value: Evidence,
  retained: WindowSnapshot["readPreview"],
  before: WindowSnapshot,
  current: WindowSnapshot,
  revision: number | null,
): ReceiptDecision<ReadPreview> {
  if (
    revision === null ||
    before.configuration?.status !== "ready" ||
    revision !== before.configuration.settings.revision ||
    !before.buildId ||
    before.buildId !== current.buildId ||
    value?.kind !== "chatgpt.readonly-task-preview" ||
    value.workspaceId !== command.workspaceId ||
    value.account !== undefined ||
    retained !== null
  )
    return {
      kind: "unconfirmed",
      intent: unknown(intention, "READ_PREVIEW_UNCONFIRMED"),
    };
  return {
    kind: "retain",
    receipt: {
      prepareIntention: intention,
      evidenceIntention: intention,
      buildId: before.buildId,
      revision,
      value,
    },
  };
}

/** The account step a read-only preview earns from inspect or approve. */
export function readAccountReceipt(
  command: Extract<
    ProductConfigurationCommand,
    {
      kind:
        "chatgpt.inspect-readonly-account" | "chatgpt.approve-readonly-account";
    }
  >,
  intention: string,
  value: Evidence,
  retained: WindowSnapshot["readPreview"],
  before: WindowSnapshot,
  current: WindowSnapshot,
  revision: number | null,
): ReceiptDecision<ReadPreview> {
  const sameMetadata =
    retained &&
    value?.kind === "chatgpt.readonly-task-preview" &&
    JSON.stringify({ ...retained.value, account: undefined }) ===
      JSON.stringify({ ...value, account: undefined });
  if (
    !retained ||
    before.readPreview !== retained ||
    retained.value.operationId !== command.operationId ||
    retained.buildId !== current.buildId ||
    revision !== retained.revision ||
    !sameMetadata ||
    value?.kind !== "chatgpt.readonly-task-preview" ||
    !value.account ||
    (retained.value.account &&
      retained.value.account.confirmationId !== value.account.confirmationId) ||
    (retained.value.account?.state === "approved" &&
      value.account.state !== "approved") ||
    (command.kind === "chatgpt.inspect-readonly-account" &&
      value.account.state !== "observed") ||
    (command.kind === "chatgpt.approve-readonly-account" &&
      (!retained.value.account ||
        retained.value.account.confirmationId !== command.confirmationId ||
        value.account.confirmationId !== command.confirmationId ||
        value.account.state !== "approved"))
  )
    return {
      kind: "unconfirmed",
      intent: unknown(intention, "READ_ACCOUNT_UNCONFIRMED"),
    };
  return {
    kind: "retain",
    receipt: { ...retained, evidenceIntention: intention, value },
  };
}

/**
 * The intent an answered reply settles to. A valid refusal can still describe
 * an effect whose acknowledgement was lost, so the state comes from the
 * outcome classifier, not from `ok`.
 */
export function configurationIntent(
  intention: string,
  command: ProductConfigurationCommand,
  outcome: Answered,
): Intent {
  const result = outcome.result;
  return {
    id: intention,
    state: configurationEffectOutcome(outcome),
    code: result.ok
      ? result.evidence?.kind === "chatgpt.deep-test-result"
        ? result.evidence.code
        : null
      : result.error,
    ...(result.connectorSetup ? { connectorSetup: result.connectorSetup } : {}),
    ...(command.kind === "chatgpt.verify" &&
    result.ok &&
    result.evidence?.kind === "chatgpt.readiness"
      ? { chatGptReadiness: result.evidence }
      : {}),
    ...(!result.ok && result.connectorAttempt
      ? { connectorAttempt: result.connectorAttempt }
      : {}),
  };
}

/**
 * The sign-in check a settled verification may retain: only an applied,
 * authenticated readiness that matches an authenticated, settled observation
 * of this very build. Null retains nothing.
 */
export function signInCheckToRetain(
  command: ProductConfigurationCommand,
  result: Intent,
  observed: WindowSnapshot["signInObservation"],
  buildId: string | null,
): NonNullable<WindowSnapshot["setupSignInCheck"]> | null {
  if (
    command.kind === "chatgpt.verify" &&
    result.state === "applied" &&
    result.chatGptReadiness?.state === "authenticated" &&
    observed?.state === "authenticated" &&
    !observed.pending &&
    observed.binding !== null &&
    observed.buildId === buildId
  )
    return { buildId: observed.buildId, binding: observed.binding };
  return null;
}

/**
 * The owner a prepared workspace edit preview may be retained under, with the
 * preview it came from, or null when the reply no longer owns the window.
 */
export function workspaceEditPreviewOwner(
  command: ProductConfigurationCommand,
  value: Evidence,
  before: WindowSnapshot,
  current: WindowSnapshot,
  revision: number | null,
  latest: boolean,
): Readonly<{
  preview: Extract<
    ProductConfigurationEvidence,
    { kind: "computer.workspace-edit-preview" }
  >;
  owner: EditOwner;
}> | null {
  if (
    command.kind === "computer.prepare-workspace-edit" &&
    value?.kind === "computer.workspace-edit-preview" &&
    value.workspaceId === command.workspaceId &&
    before.configuration?.status === "ready" &&
    current.configuration?.status === "ready" &&
    latest &&
    revision === before.configuration.settings.revision &&
    before.buildId &&
    before.buildId === current.buildId &&
    before.configuration.settings.computer.computerId ===
      current.configuration.settings.computer.computerId &&
    before.configuration.settings.computer.generation ===
      current.configuration.settings.computer.generation &&
    current.status === "current"
  )
    return {
      preview: value,
      owner: {
        buildId: before.buildId,
        computerId: before.configuration.settings.computer.computerId,
        generation: before.configuration.settings.computer.generation,
      },
    };
  return null;
}

/** The unknown intent for a preview the edit registry could not retain. */
export function workspaceEditPreviewUnconfirmed(intention: string): Intent {
  return unknown(intention, "WORKSPACE_EDIT_PREVIEW_UNCONFIRMED");
}

// ---------------------------------------------------------------------------
// Dispatch: idempotency and admission.

const connectorVerifyKey =
  /^settings:connector\.(?:verify-app|verify-separate-app):(?:[a-f0-9]{64})?$/u;

/** A Settings connector check, which never replays and rereads on success. */
export function isConnectorVerifyKey(key: string): boolean {
  return connectorVerifyKey.test(key);
}

/** An intention whose applied result can complete the guided setup. */
export function completesSetupKey(key: string): boolean {
  return key === "settings:chatgpt.verify:" || isConnectorVerifyKey(key);
}

/**
 * A retained intention answered by a different payload is a conflict, never a
 * replay. Null means the digests match and the retained promise is the answer.
 */
export function payloadConflict(
  key: string,
  retainedDigest: string,
  digest: string,
): Intent | null {
  return retainedDigest === digest
    ? null
    : refusal(key, "INTENTION_PAYLOAD_CONFLICT");
}

/** The refusal for a command whose digest could not be computed. */
export function bindingUnavailable(key: string): Intent {
  return refusal(key, "COMMAND_BINDING_UNAVAILABLE");
}

/** A command arriving after disposal, or outside its admitting state. */
export function admissionRefusal(
  key: string,
  disposed: boolean,
  admitted: boolean,
): Intent | null {
  if (disposed) return refusal(key, "WINDOW_OBSERVATION_CLOSED");
  if (!admitted) return refusal(key, "CURRENT_STATE_REQUIRED");
  return null;
}

/** The refusal a command receives when its state changed before it ran. */
export function staleAdmissionRefusal(key: string): Intent {
  return refusal(key, "CURRENT_STATE_REQUIRED");
}
