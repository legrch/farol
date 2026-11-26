import {
  SavedChatFollowUpActionSchema,
  SavedChatFollowUpRequestSchema,
  SavedChatFollowUpResultSchema,
  savedChatFollowUpScript,
  type SavedChatFollowUpCode,
  type SavedChatFollowUpResult,
  type SavedChatPhysicalBinding,
} from "../../../src/apps/desktop/saved-chat-page-scripts";
import { boundedProbe, type ProbeClock } from "./bounded";

// The saved-chat page actions of the ChatGPT route: the guarded follow-up
// (prepare, submit, observe) and the restricted probes the saved-chat browser
// uses. The route keeps the window, the physical view generations and the
// binding; this file keeps only what is decided from them. Nothing here
// retries, and nothing turns an unknown outcome into a known one.

// The follow-up -----------------------------------------------------------

// One surface the follow-up acts on, captured once after the request has been
// admitted. `isCurrent` says whether it is still the route's own window.
export type SavedChatFollowUpPage = Readonly<{
  execute: (script: string, gesture: boolean) => Promise<unknown>;
  isCurrent: () => boolean;
}>;

export type SavedChatFollowUpPorts = Readonly<{
  // The public-output profile that qualifies the page scripts is selected.
  qualified: () => boolean;
  // The app the route is bound to, when it is bound to one.
  requiredAppName: () => string | undefined;
  // The route's current physical binding of the saved chat, or null.
  binding: () => SavedChatPhysicalBinding | null;
  acquire: () => SavedChatFollowUpPage;
}>;

export type SavedChatFollowUp = (
  candidate: unknown,
  action: "prepare" | "submit" | "observe",
  stillBound: (binding: SavedChatPhysicalBinding) => boolean,
) => Promise<SavedChatFollowUpResult>;

/**
 * Internal adapter seam, never a wire grant. The trusted Chat caller must
 * recheck its original operation, Go lease/profile/partition and authority.
 * Literal selection values and physical DTOs supply evidence only.
 *
 * One in-memory physical dispatch fuse and one in-flight flag live in the
 * returned function. The fuse survives transport loss: the Go caller still owns
 * durable settlement, and a new route or process cannot recover it here.
 */
export function createSavedChatFollowUp(
  ports: SavedChatFollowUpPorts,
): SavedChatFollowUp {
  let mutationInFlight = false;
  let submitFuse: Readonly<{
    operationId: string;
    previousUserId: string;
  }> | null = null;
  return async (candidate, action, stillBound) => {
    const parsed = SavedChatFollowUpRequestSchema.safeParse(candidate);
    const refused = (code: SavedChatFollowUpCode): SavedChatFollowUpResult => ({
      state: action === "observe" ? "awaiting-owner" : "not-sent",
      code,
    });
    if (
      !parsed.success ||
      !SavedChatFollowUpActionSchema.safeParse(action).success
    )
      return refused("SAVED_CHAT_INVALID");
    if (!ports.qualified())
      return {
        state: "awaiting-owner",
        code: "SAVED_CHAT_BINDING_UNQUALIFIED",
      };
    const input = parsed.data;
    const binding = ports.binding();
    const authorized = () => {
      try {
        return (
          typeof stillBound === "function" &&
          stillBound(Object.freeze({ ...input.binding })) === true
        );
      } catch {
        return false;
      }
    };
    if (!binding || JSON.stringify(binding) !== JSON.stringify(input.binding))
      return refused("SAVED_CHAT_BINDING_STALE");
    if (!authorized())
      return {
        state: "awaiting-owner",
        code: "SAVED_CHAT_BINDING_UNQUALIFIED",
      };
    const requiredAppName = ports.requiredAppName();
    if (requiredAppName && requiredAppName !== input.selection.connector.label)
      return refused("SAVED_CHAT_SELECTION_MISMATCH");
    if (mutationInFlight && action !== "observe")
      return refused("SAVED_CHAT_OPERATION_UNSETTLED");
    if (action !== "observe" && input.operation.state !== "not-sent")
      return refused("SAVED_CHAT_OPERATION_UNSETTLED");
    if (
      action === "submit" &&
      submitFuse !== null &&
      (submitFuse.operationId === input.operation.id ||
        submitFuse.previousUserId === input.previous.userId)
    )
      return refused("SAVED_CHAT_OPERATION_UNSETTLED");
    const page = ports.acquire();
    if (action !== "observe") mutationInFlight = true;
    const lost = () =>
      !page.isCurrent() ||
      JSON.stringify(ports.binding()) !== JSON.stringify(binding) ||
      !authorized();
    if (action === "submit")
      submitFuse = {
        operationId: input.operation.id,
        previousUserId: input.previous.userId,
      };
    try {
      const result: unknown = await page.execute(
        savedChatFollowUpScript(input, action),
        true,
      );
      if (lost())
        return action === "submit"
          ? { state: "unknown", code: "SAVED_CHAT_SEND_UNKNOWN" }
          : refused("SAVED_CHAT_BINDING_STALE");
      const response = SavedChatFollowUpResultSchema.safeParse(result);
      if (!response.success)
        return action === "submit"
          ? { state: "unknown", code: "SAVED_CHAT_SEND_UNKNOWN" }
          : { state: "awaiting-owner", code: "SAVED_CHAT_SOURCE_UNSUPPORTED" };
      const responseState = response.data.state;
      const expectedState =
        action === "prepare"
          ? "prepared"
          : action === "submit"
            ? "submitted"
            : "observed";
      if (
        ["prepared", "submitted", "observed"].includes(responseState) &&
        responseState !== expectedState
      )
        return action === "submit"
          ? { state: "unknown", code: "SAVED_CHAT_SEND_UNKNOWN" }
          : { state: "awaiting-owner", code: "SAVED_CHAT_SOURCE_UNSUPPORTED" };
      if (
        (response.data.state === "prepared" ||
          response.data.state === "submitted") &&
        JSON.stringify(response.data.selection) !==
          JSON.stringify(input.selection)
      )
        return action === "submit"
          ? { state: "unknown", code: "SAVED_CHAT_SEND_UNKNOWN" }
          : { state: "awaiting-owner", code: "SAVED_CHAT_SOURCE_UNSUPPORTED" };
      if (
        response.data.state === "submitted" &&
        response.data.evidenceId !== input.evidenceId
      )
        return { state: "unknown", code: "SAVED_CHAT_SEND_UNKNOWN" };
      if (
        response.data.state === "observed" &&
        (response.data.frame.userId !== response.data.userId ||
          response.data.userId === input.previous.userId ||
          response.data.assistantId === input.previous.assistantId ||
          response.data.frame.messages.some(
            (message) => message.id === input.previous.assistantId,
          ) ||
          (input.correlation !== null &&
            (input.correlation.userId !== response.data.userId ||
              (input.correlation.assistantId !== null &&
                input.correlation.assistantId !== response.data.assistantId))))
      )
        return {
          state: "awaiting-owner",
          code: "SAVED_CHAT_CORRELATION_UNAVAILABLE",
        };
      if (action === "submit" && response.data.state === "not-sent")
        submitFuse = null;
      return response.data;
    } catch {
      return action === "submit"
        ? { state: "unknown", code: "SAVED_CHAT_SEND_UNKNOWN" }
        : { state: "awaiting-owner", code: "SAVED_CHAT_SOURCE_UNSUPPORTED" };
    } finally {
      if (action !== "observe") mutationInFlight = false;
    }
  };
}

// The restricted probes ----------------------------------------------------

// The route window as one reading of it, taken synchronously: its identity, and
// the facts the probes compare before and after one page script. `execute` and
// `load` act on exactly this window.
export type SavedChatSurfaceSnapshot = Readonly<{
  surface: object;
  destroyed: boolean;
  loaded: boolean;
  // Read only when asked, after `destroyed` and `loaded` allowed it: a destroyed
  // window may throw on access.
  url: () => string;
  documentGeneration: number;
  execute: (script: string, gesture: boolean) => Promise<unknown>;
  load: (url: string) => Promise<void>;
}>;

export type SavedChatProbePorts = Readonly<{
  // The route window now, or null when there is none.
  snapshot: () => SavedChatSurfaceSnapshot | null;
  // The canonical saved-chat URL of `url`, or null when it is not one.
  canonicalConversationUrl: (url: string) => string | null;
  // Bounds a read that is given a budget. Without it every script is awaited
  // as before.
  clock?: ProbeClock;
}>;

export class SavedChatReadTimeout extends Error {
  constructor() {
    super("Saved-chat page read timed out");
    this.name = "SavedChatReadTimeout";
  }
}

export type SavedChatProbes = Readonly<{
  // One restricted page script on the route's own isolated page. Yields null
  // unless the page stayed the same document at the expected address; a send
  // may navigate (`allowNavigation`) and then keeps only the window identity.
  // With `budgetMs` a page that has not answered by then, or answers later,
  // rejects with SavedChatReadTimeout: never a positive answer and never the
  // unreadable-page null, which is evidence about page content.
  run: (
    script: string,
    expectedUrl: string,
    allowNavigation?: boolean,
    budgetMs?: number,
  ) => Promise<unknown>;
  load: (conversationUrl: string) => Promise<boolean>;
}>;

export function createSavedChatProbes(
  ports: SavedChatProbePorts,
): SavedChatProbes {
  return {
    run: async (script, expectedUrl, allowNavigation = false, budgetMs) => {
      const before = ports.snapshot();
      if (
        !before ||
        before.destroyed ||
        !before.loaded ||
        before.url() !== expectedUrl
      )
        return null;
      try {
        let result: unknown;
        if (budgetMs !== undefined && ports.clock) {
          const read = await boundedProbe(
            ports.clock,
            () => before.execute(script, true),
            ports.clock.now() + budgetMs,
          );
          // A stalled read says nothing about the page: it is a classified
          // timeout the caller must not turn into a page-content answer.
          if (read.status === "timeout") throw new SavedChatReadTimeout();
          result = read.value;
        } else {
          result = await before.execute(script, true);
        }
        const after = ports.snapshot();
        if (!after || after.surface !== before.surface || after.destroyed)
          return null;
        if (
          !allowNavigation &&
          (after.url() !== expectedUrl ||
            after.documentGeneration !== before.documentGeneration ||
            !after.loaded)
        )
          return null;
        return result;
      } catch (error) {
        if (error instanceof SavedChatReadTimeout) throw error;
        return null;
      }
    },
    load: async (conversationUrl) => {
      if (ports.canonicalConversationUrl(conversationUrl) !== conversationUrl)
        return false;
      const before = ports.snapshot();
      if (!before || before.destroyed || !before.loaded) return false;
      try {
        await before.load(conversationUrl);
        const after = ports.snapshot();
        return (
          after !== null &&
          after.surface === before.surface &&
          !after.destroyed &&
          after.loaded &&
          after.url() === conversationUrl
        );
      } catch {
        return false;
      }
    },
  };
}
