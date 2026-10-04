import { isDeepStrictEqual } from "node:util";
import {
  ChatGptAccountObservationSchema,
  type ChatGptAccountObservation,
} from "./chatgpt-account-probe.ts";
import type { PhysicalBinding } from "./chatgpt-physical-api.ts";
import type { PhysicalSurface } from "./chatgpt-physical-host-port.ts";

export type BoundChatGptAccountObservation = Readonly<{
  binding: PhysicalBinding;
  account: Extract<ChatGptAccountObservation, { state: "observed" }>;
}>;

// One read of an already open physical surface. This is browser mechanics,
// not approval, account entitlement or permission to send. No navigation,
// replacement view, automatic retry or account refresh is performed here.
export async function observeBoundChatGptAccount(
  input: Readonly<{
    e2eOrigin: string | null;
    snapshot(): PhysicalSurface | null;
    read(surface: PhysicalSurface): Promise<unknown>;
    now?: () => number;
  }>,
): Promise<BoundChatGptAccountObservation | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const now = input.now ?? Date.now;
    const started = now();
    const origin = input.e2eOrigin ?? "https://chatgpt.com";
    if (
      !Number.isSafeInteger(started) ||
      started <= 0 ||
      (input.e2eOrigin !== null &&
        !/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}$/u.test(
          origin,
        ))
    )
      return null;
    const first = input.snapshot();
    if (
      !first ||
      first.isDestroyed() ||
      new URL(first.binding.url).origin !== origin
    )
      return null;
    const binding = structuredClone(first.binding);
    const raw = await Promise.race([
      Promise.resolve().then(() => input.read(first)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("account_observation_timeout")),
          5_000,
        );
      }),
    ]);
    const parsed = ChatGptAccountObservationSchema.safeParse(raw);
    if (!parsed.success || parsed.data.state !== "observed") return null;
    const account = parsed.data;
    const ended = now();
    const current = input.snapshot();
    if (
      !Number.isSafeInteger(ended) ||
      ended < started ||
      ended - started >= 5_000 ||
      account.observedAtMillis < started ||
      account.observedAtMillis > ended ||
      account.expiresAtMillis <= ended ||
      account.documentUrl !== binding.url ||
      !current ||
      current.handle !== first.handle ||
      current.isDestroyed() ||
      first.isDestroyed() ||
      !isDeepStrictEqual(current.binding, binding)
    )
      return null;
    return { binding, account: structuredClone(account) };
  } catch {
    // Provider/native exceptions and rejected page payloads never escape into
    // renderer diagnostics, logs or a positive observation.
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
