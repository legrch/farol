import type { ProductConfigurationCommand } from "../../pkg/product-settings/contract";
import type { Intent, WindowSnapshot } from "./contract";

/**
 * Only a digest survives an uncertain result; never retain credentials or
 * private command bodies in the intention map.
 */
export async function fingerprint(payload: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Publish one intention's current result, keeping every other intention. */
export function intentPatch(
  state: WindowSnapshot,
  key: string,
  result: Intent,
): Partial<WindowSnapshot> {
  return { intents: { ...state.intents, [key]: result } };
}

/**
 * The patch installed with a new latch. A settings intention also records its
 * check order; `sequence` is that order, or null for any other key.
 */
export function pendingPatch(
  state: WindowSnapshot,
  key: string,
  sequence: number | null,
): Partial<WindowSnapshot> {
  return {
    intents: {
      ...state.intents,
      [key]: { id: key, state: "pending", code: null, inFlight: true },
    },
    ...(sequence !== null
      ? { setupCheckOrder: { ...state.setupCheckOrder, [key]: sequence } }
      : {}),
  };
}

/** Whether a dispatched key joins the setup-check ordering. */
export function ordersSetupCheck(key: string): boolean {
  return key.startsWith("settings:");
}

/** The code of a task Cancel whose click may have run, unconfirmed. */
export const TASK_CANCEL_UNCONFIRMED = "TASK_CANCEL_FAILED";

/**
 * The result to record for a key once a command settles. A refused task Cancel
 * touched nothing on the page: the main process answers a click it ran with a
 * success or `TASK_CANCEL_FAILED`, never a refusal, whatever happens to its
 * save afterwards. So a refusal never replaces the retained unknown result of
 * an unconfirmed Cancel: that click may have run, and only a verified answer
 * may resolve it. `earlier` is the key's intent as it stood before the command.
 */
export function keepsUnconfirmedCancel(
  earlier: Intent | undefined,
  result: Intent,
): Intent {
  return earlier?.state === "unknown" &&
    earlier.code === TASK_CANCEL_UNCONFIRMED &&
    result.state === "refused"
    ? { id: earlier.id, state: earlier.state, code: earlier.code }
    : result;
}

/**
 * A settled result keeps its latch only while its outcome is unknown, except
 * for a Cancel whose click is unconfirmed: the main process admits a repeat
 * only while the task's turn is still in flight and refuses it otherwise
 * without touching the page, so a repeat is safe to dispatch. The result
 * itself stays unknown and retained either way.
 */
export function releasesLatch(
  result: Intent,
  retainSettlement: boolean,
): boolean {
  if (retainSettlement) return false;
  return result.state !== "unknown" || result.code === TASK_CANCEL_UNCONFIRMED;
}

/**
 * Remember which fence a retry named, by its own receipt id, so that only that
 * retry can later outgrow the attempt it recovered. Never replaces an identity
 * already recorded for the intention; null when nothing is to be recorded.
 */
export function recoveryRetryPatch(
  state: WindowSnapshot,
  command: ProductConfigurationCommand,
  intention: string,
): Partial<WindowSnapshot> | null {
  if (
    command.kind === "connector.save-and-connect" &&
    command.recovery &&
    state.recoveryRetries?.[intention] === undefined
  )
    return {
      recoveryRetries: {
        ...state.recoveryRetries,
        [intention]: command.recovery,
      },
    };
  return null;
}

/** The unknown intent an acknowledged edit restores for its original submit. */
export function settledOriginalPatch(
  state: WindowSnapshot,
  acknowledged: {
    submitted: { intention: string };
    state: Intent["state"];
    code: string | null;
  },
): Partial<WindowSnapshot> | null {
  const original = state.intents[acknowledged.submitted.intention];
  if (original?.state !== "unknown") return null;
  return {
    intents: {
      ...state.intents,
      [original.id]: {
        id: original.id,
        state: acknowledged.state,
        code: acknowledged.code,
      },
    },
  };
}

/** The unknown intent for a deep test whose conversation is unconfirmed. */
export function deepTestUnconfirmedPatch(
  state: WindowSnapshot,
  operationId: string,
): Partial<WindowSnapshot> | null {
  const key = `deep-test:run:${operationId}`;
  const current = state.intents[key];
  if (current && current.state !== "pending" && current.state !== "unknown")
    return null;
  return {
    intents: {
      ...state.intents,
      [key]: {
        id: key,
        state: "unknown",
        code: "CHATGPT_CONVERSATION_UNCONFIRMED",
      },
    },
  };
}
