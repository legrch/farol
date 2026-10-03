import { isDeepStrictEqual } from "node:util";
import { BridgeError } from "./bridge/client.ts";
import type { BrowserDriver } from "./bridge/browser.ts";
import {
  validate,
  type BrowserLease,
  type BrowserPrepare,
  type Context,
} from "./bridge/wire.ts";
import type {
  ChatGptPhysicalApi,
  PhysicalPartition,
} from "./chatgpt-physical-api.ts";
import type { AssignedChatBrowser } from "./go-chat-browser.ts";
import type { DesktopBrowserConnection } from "./go-core-host.ts";

type Slot = {
  lease: BrowserLease;
  api: ChatGptPhysicalApi | undefined;
  busy: boolean;
  settled: boolean;
  destroyed: boolean;
  uncertain: boolean;
};
export type DesktopChatBrowserPorts = Readonly<{
  context: Readonly<Context>;
  partition: PhysicalPartition;
  // Creates one dedicated hidden route for the exact Go-assigned target.
  // No sign-in/default view or legacy Task executor may be returned.
  create: (input: BrowserPrepare) => Promise<ChatGptPhysicalApi>;
  driver: (
    lookup: (lease: BrowserLease) => AssignedChatBrowser | undefined,
  ) => BrowserDriver;
  nowMillis?: () => number;
}>;

// Physical assignment table only. Go owns the five-worker queue and every
// generation change. A new generation cannot replace an unsettled native view.
// There is no waiting queue, admission, retry, journal or result ownership here.
export function createDesktopChatBrowser(
  ports: DesktopChatBrowserPorts,
): DesktopBrowserConnection {
  const slots = new Map<number, Slot>();
  const context = structuredClone(ports.context);
  const now = ports.nowMillis ?? Date.now;
  let active = true;
  const refuse = (code: string): never => {
    throw new BridgeError("refused", code);
  };
  const scoped = (lease: BrowserLease) =>
    active &&
    validate("BrowserLease", lease) &&
    lease.identity.profileId === context.profileId &&
    lease.backendGeneration === context.backendGeneration;
  const lookup = (lease: BrowserLease): AssignedChatBrowser | undefined => {
    const slot = slots.get(lease.slotOrdinal);
    return scoped(lease) && slot?.api && isDeepStrictEqual(slot.lease, lease)
      ? {
          lease: structuredClone(slot.lease),
          api: slot.api,
          partition: ports.partition,
        }
      : undefined;
  };
  const delegate = ports.driver(lookup);
  const current = (lease: BrowserLease): Slot => {
    const slot = slots.get(lease.slotOrdinal);
    if (!scoped(lease) || !slot || !isDeepStrictEqual(slot.lease, lease))
      return refuse("host_browser_assignment_mismatch");
    return slot;
  };
  const run = async <T>(
    lease: BrowserLease,
    action: (slot: Slot) => Promise<T>,
  ): Promise<T> => {
    const slot = current(lease);
    if (slot.busy) return refuse("host_browser_call_in_flight");
    slot.busy = true;
    try {
      return await action(slot);
    } catch (error) {
      slot.uncertain = true;
      throw error;
    } finally {
      slot.busy = false;
    }
  };
  const driver: BrowserDriver = {
    async prepare(input) {
      if (!validate("BrowserPrepare", input))
        return refuse("host_browser_prepare_invalid");
      const deadline = Number(input.deadlineMillis),
        started = now();
      if (
        !scoped(input.lease) ||
        !Number.isSafeInteger(started) ||
        !Number.isSafeInteger(deadline) ||
        deadline <= started ||
        deadline - started > 15000
      )
        return refuse("host_browser_prepare_invalid");
      const old = slots.get(input.lease.slotOrdinal);
      if (
        old &&
        (old.busy ||
          old.uncertain ||
          (!old.settled && !old.destroyed) ||
          BigInt(input.lease.slotGeneration) <=
            BigInt(old.lease.slotGeneration))
      )
        return refuse("host_browser_slot_unsettled");
      const slot: Slot = {
        lease: structuredClone(input.lease),
        api: old?.destroyed ? undefined : old?.api,
        busy: false,
        settled: false,
        destroyed: false,
        uncertain: false,
      };
      slots.set(input.lease.slotOrdinal, slot);
      return run(slot.lease, async () => {
        if (!slot.api) slot.api = await ports.create(structuredClone(input));
        if (!scoped(slot.lease) || now() >= deadline)
          throw new BridgeError("unknown", "host_browser_creation_unconfirmed");
        return delegate.prepare(input);
      });
    },
    verifySend: (input) =>
      run(input.binding.lease, () => delegate.verifySend(input)),
    send: (input) =>
      run(input.binding.lease, async (slot) => {
        const reply = await delegate.send(input);
        if (reply.status === "unknown") slot.uncertain = true;
        return reply;
      }),
    observe: (input) =>
      run(input.binding.lease, async (slot) => {
        const reply = await delegate.observe(input);
        if (
          validate("BrowserObserved", reply) &&
          reply.events.some(
            (event) =>
              event.kind === "quiescent" &&
              isDeepStrictEqual(event.binding.lease, slot.lease),
          )
        )
          slot.settled = true;
        return reply;
      }),
    cancel: (input) =>
      run(input.binding.lease, async (slot) => {
        const reply = await delegate.cancel(input);
        if (
          validate("BrowserCancelled", reply) &&
          isDeepStrictEqual(reply.binding.lease, slot.lease) &&
          (reply.status === "confirmed-terminal" ||
            reply.status === "already-terminal")
        )
          slot.settled = true;
        else if (reply.status === "unknown") slot.uncertain = true;
        return reply;
      }),
    dispose: (input) =>
      run(input.lease, async (slot) => {
        const reply = await delegate.dispose(input);
        if (
          validate("BrowserDisposed", reply) &&
          reply.confirmed &&
          isDeepStrictEqual(reply.lease, slot.lease)
        )
          slot.destroyed = true;
        else slot.uncertain = true;
        return reply;
      }),
  };
  return {
    driver,
    withdraw: () => {
      active = false;
    },
  };
}
