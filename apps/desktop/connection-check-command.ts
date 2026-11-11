import { createHash } from "node:crypto";
import { BridgeError } from "./bridge/client.ts";
import type { ConnectionCheckBridge } from "./bridge/connection-check.ts";
import type { ComputerCheckPrepareRequest } from "./bridge/wire.ts";
import type { ChatGptTaskObserver } from "../../src/apps/desktop/chatgpt-route.ts";

export type ExplicitConnectionCheck = Readonly<{
  kind: "connector.test-connection";
  operationId: string;
  taskId: string;
}>;
export type ConnectionCheckCode =
  | "CONNECTION_CHECK_PREREQUISITES_REQUIRED"
  | "CONNECTION_CHECK_PENDING"
  | "CONNECTION_CHECK_BLOCKED"
  | "CONNECTION_CHECK_OUTCOME_UNKNOWN"
  | "CONNECTION_CHECK_ALREADY_ATTEMPTED"
  | "CONNECTION_CHECK_OWNER_CHANGED"
  | "CHATGPT_COMPOSER_DRAFT_PRESENT"
  | "CHATGPT_TEMPORARY_CHAT_REQUIRED"
  | "CHATGPT_INSTANT_MODEL_REQUIRED"
  | "CHATGPT_APP_SELECTION_MISSING"
  | "CHATGPT_APP_SELECTION_AMBIGUOUS"
  | "CHATGPT_APP_SELECTION_CONFLICT"
  | "CHATGPT_APP_SELECTION_LOST";
export class ConnectionCheckRefusal extends Error {
  constructor(readonly code: ConnectionCheckCode) {
    super(code);
  }
}
export type ConnectionCheckCommandResult =
  | Readonly<{
      state: "verified";
      operationId: string;
      receiptDigest: string;
      retained: boolean;
    }>
  | Readonly<{
      state: "refused" | "unknown";
      operationId: string;
      code: ConnectionCheckCode;
    }>;
export type ConnectionCheckDocument = Readonly<{
  documentDigest: string;
  current(): boolean;
}>;
export type ConnectionCheckBrowser = Readonly<{
  selection: Omit<
    ComputerCheckPrepareRequest,
    "operationId" | "documentDigest"
  >;
  current(): boolean;
  prepareDocument(): Promise<ConnectionCheckDocument>;
  send(
    prompt: string,
    observer: ChatGptTaskObserver & {
      connectionCheck: true;
      readConnectorReceipt(): Promise<boolean>;
    },
  ): Promise<Readonly<{ state: string; code: string | null }>>;
}>;
type GoOwner = Pick<
  ConnectionCheckBridge,
  "claim" | "prepare" | "advance" | "observe"
>;
export const connectionCheckDigest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

// Mechanical Desktop adapter only: Go retains identity, mode, nonce, phases and
// receipts. No TS journal, authority owner, restart, repair or Send retry exists.
// capture runs ONLY after a confirmed FIRST claim; duplicate IDs observe before
// resolving today's runtime, app, selected browser document or settings scope.
export async function runExplicitConnectionCheck(
  command: ExplicitConnectionCheck,
  go: GoOwner,
  capture: () => Promise<ConnectionCheckBrowser>,
): Promise<ConnectionCheckCommandResult> {
  const operationId = command.operationId;
  const unknown = (): ConnectionCheckCommandResult => ({
    state: "unknown",
    operationId,
    code: "CONNECTION_CHECK_OUTCOME_UNKNOWN",
  });
  const refused = (
    code: ConnectionCheckCode,
  ): ConnectionCheckCommandResult => ({ state: "refused", operationId, code });
  const fingerprint = connectionCheckDigest(
    JSON.stringify({
      schema: 1,
      kind: command.kind,
      operationId,
      taskId: command.taskId,
    }),
  );
  let first: boolean;
  try {
    first = (await go.claim({ operationId, fingerprint })).first;
  } catch (error) {
    if (error instanceof BridgeError && error.state === "refused")
      return refused(
        error.code === "computer_connection_check_pending"
          ? "CONNECTION_CHECK_PENDING"
          : "CONNECTION_CHECK_BLOCKED",
      );
    return unknown();
  }
  if (!first) {
    try {
      const prior = await go.observe(operationId);
      if (prior.phase === "verified" && prior.receiptDigest)
        return {
          state: "verified",
          operationId,
          receiptDigest: prior.receiptDigest,
          retained: true,
        };
      return prior.phase === "refused_before_send"
        ? refused("CONNECTION_CHECK_BLOCKED")
        : unknown();
    } catch {
      return unknown();
    }
  }
  let rpcUncertain = false;
  let dispatchRequested = false;
  let authorized = false;
  let sendAcknowledged = false;
  const advance = async (
    stage: "dispatch" | "sent" | "confirm" | "unknown" | "refuse",
  ) => {
    try {
      return await go.advance({ operationId, stage });
    } catch (error) {
      rpcUncertain = true;
      throw error;
    }
  };
  const refuseBeforeDispatch = async (code: ConnectionCheckCode) => {
    if (dispatchRequested || rpcUncertain) return unknown();
    try {
      await advance("refuse");
      return refused(code);
    } catch {
      return unknown();
    }
  };
  let browser: ConnectionCheckBrowser;
  let document: ConnectionCheckDocument;
  try {
    browser = await capture();
    if (!browser.current())
      throw new ConnectionCheckRefusal("CONNECTION_CHECK_OWNER_CHANGED");
    document = await browser.prepareDocument();
    if (!browser.current() || !document.current())
      throw new ConnectionCheckRefusal("CONNECTION_CHECK_OWNER_CHANGED");
  } catch (error) {
    return refuseBeforeDispatch(
      error instanceof ConnectionCheckRefusal
        ? error.code
        : "CONNECTION_CHECK_PREREQUISITES_REQUIRED",
    );
  }
  let prepared: Awaited<ReturnType<GoOwner["prepare"]>>;
  try {
    prepared = await go.prepare({
      ...browser.selection,
      operationId,
      documentDigest: document.documentDigest,
    });
  } catch {
    return unknown();
  } // A possibly published preparation is observation-only.
  const current = () => browser.current() && document.current();
  const receiptAvailable = async () => {
    if (!authorized || rpcUncertain || !browser.current()) return false;
    const value = await go.observe(operationId);
    if (
      value.operationId !== operationId ||
      value.mode !== prepared.mode ||
      value.checkId !== prepared.checkId
    )
      throw new BridgeError("unknown", "connection_check_crossed_observation");
    return (
      browser.current() &&
      value.receiptAvailable &&
      (value.phase === "dispatch_intent" || value.phase === "send_acknowledged")
    );
  };
  let result: Readonly<{ state: string; code: string | null }>;
  try {
    if (!current())
      return refuseBeforeDispatch("CONNECTION_CHECK_OWNER_CHANGED");
    result = await browser.send(prepared.prompt, {
      connectionCheck: true,
      beforeSend: () => authorized && !rpcUncertain && current(),
      onDispatchIntent: async () => {
        // This guard is consumed BEFORE the first RPC await. Neither a browser
        // callback repeated by a layout race nor a lost RPC reply can re-arm.
        if (dispatchRequested || !current())
          throw new ConnectionCheckRefusal("CONNECTION_CHECK_OWNER_CHANGED");
        dispatchRequested = true;
        const permit = await advance("dispatch");
        if (!permit.sendAuthorized || permit.phase !== "dispatch_intent")
          throw new BridgeError("unknown", "connection_check_no_permit");
        authorized = true;
      },
      onSendAcknowledged: async () => {
        if (!authorized || sendAcknowledged || rpcUncertain)
          throw new BridgeError("unknown", "connection_check_crossed_send_ack");
        sendAcknowledged = true;
        await advance("sent");
      },
      readConnectorReceipt: receiptAvailable,
    });
  } catch {
    return unknown();
  }
  if (
    !dispatchRequested &&
    (result.state === "failed_before_submit" ||
      result.state === "not_authenticated")
  ) {
    const known: readonly ConnectionCheckCode[] = [
      "CHATGPT_COMPOSER_DRAFT_PRESENT",
      "CHATGPT_TEMPORARY_CHAT_REQUIRED",
      "CHATGPT_INSTANT_MODEL_REQUIRED",
      "CHATGPT_APP_SELECTION_MISSING",
      "CHATGPT_APP_SELECTION_AMBIGUOUS",
      "CHATGPT_APP_SELECTION_CONFLICT",
      "CHATGPT_APP_SELECTION_LOST",
    ];
    return refuseBeforeDispatch(
      known.includes(result.code as ConnectionCheckCode)
        ? (result.code as ConnectionCheckCode)
        : "CONNECTION_CHECK_PREREQUISITES_REQUIRED",
    );
  }
  if (!authorized || rpcUncertain) return unknown();
  try {
    // A lost browser acknowledgement may still have an exact original Go
    // receipt. Observe it; never activate the browser a second time to learn.
    if (browser.current() && (await receiptAvailable())) {
      const confirmed = await advance("confirm");
      if (confirmed.phase === "verified" && confirmed.receiptDigest)
        return {
          state: "verified",
          operationId,
          receiptDigest: confirmed.receiptDigest,
          retained: false,
        };
      return unknown();
    }
    // Waiting ended, not custody. This is one monotonic UNKNOWN publication,
    // not a second Send or a replacement operation after an uncertain RPC.
    await advance("unknown");
  } catch {
    /* Preserve the original record and never replay any phase RPC. */
  }
  return unknown();
}
