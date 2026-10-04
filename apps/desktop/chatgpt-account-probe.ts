import { z } from "zod";

const observation = z.discriminatedUnion("state", [
  z
    .strictObject({
      state: z.literal("observed"),
      source: z.literal("provider-session-v1"),
      accountKey: z
        .string()
        .length(64)
        .regex(/^[a-f0-9]+$/u),
      observedAtMillis: z
        .number()
        .int()
        .nonnegative()
        .max(Number.MAX_SAFE_INTEGER),
      expiresAtMillis: z
        .number()
        .int()
        .nonnegative()
        .max(Number.MAX_SAFE_INTEGER),
      documentUrl: z
        .string()
        .min(1)
        .max(4096)
        .regex(/^[^\u0000-\u001f\u007f-\u009f]+$/u)
        .refine((value) => {
          try {
            const url = new URL(value);
            return (
              !url.username &&
              !url.password &&
              !value.includes("?") &&
              !value.includes("#")
            );
          } catch {
            return false;
          }
        }),
    })
    .refine((value) => value.expiresAtMillis > value.observedAtMillis),
  z.strictObject({
    state: z.literal("unavailable"),
    code: z.enum([
      "origin_refused",
      "document_changed",
      "request_failed",
      "response_refused",
      "body_limit",
      "body_failed",
      "session_refused",
      "hash_failed",
      "timeout",
      "page_unavailable",
    ]),
  }),
]);

/** Closed host boundary: reject accessors without invoking them or retaining input. */
export const ChatGptAccountObservationSchema = z.preprocess((input) => {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input))
      return null;
    const copy: Record<string, unknown> = Object.create(null);
    const keys = [
      "state",
      "source",
      "accountKey",
      "observedAtMillis",
      "expiresAtMillis",
      "documentUrl",
      "code",
    ];
    for (const key of Reflect.ownKeys(input)) {
      if (typeof key !== "string" || !keys.includes(key)) return null;
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
        return null;
      copy[key] = descriptor.value;
    }
    return copy;
  } catch {
    return null;
  }
}, observation);

export type ChatGptAccountObservation = z.infer<
  typeof ChatGptAccountObservationSchema
>;

/**
 * Page mechanics only; intentionally unwired. The endpoint is not live-qualified
 * and may not identify the active workspace/account used by Send. No entitlement,
 * model, billing, organization or owner-approval inference is made here.
 * The host must independently bind the physical view/document/partition and
 * generation. Page globals are not an authority boundary against hostile code.
 * Keep every executable dependency inside this function for toString transport.
 */
export async function readChatGptAccount(
  e2eOrigin: string | null = null,
): Promise<ChatGptAccountObservation> {
  type Code = Extract<
    ChatGptAccountObservation,
    { state: "unavailable" }
  >["code"];
  let code: Code = "page_unavailable";
  let controller: AbortController | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let body: ReadableStream<Uint8Array> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let abortStarted = false;
  let cancellationStarted = false;
  const unavailable = (failure: Code): ChatGptAccountObservation => ({
    state: "unavailable",
    code: failure,
  });
  function refuse(failure: Code): never {
    code = failure;
    throw null;
  }
  const release = () => {
    const acquired = reader;
    reader = null;
    try {
      acquired?.releaseLock();
    } catch {
      /* A timed-out read may still be pending. */
    }
  };
  // Cancellation is best effort and never awaited: a broken stream's cancel()
  // must not extend the deadline. The abort signal and stopped fence also apply.
  const cancel = () => {
    if (!abortStarted) {
      abortStarted = true;
      try {
        controller?.abort();
      } catch {
        /* Content-free failure. */
      }
    }
    // A fetch double may ignore abort and settle late. Cancel its newly acquired
    // body too, without restarting the request or waiting for cancellation.
    if (cancellationStarted || !body) return;
    cancellationStarted = true;
    try {
      const pending = reader ? reader.cancel() : body?.cancel();
      if (pending) void pending.catch(() => {});
    } catch {
      /* Content-free failure. */
    }
  };
  try {
    let origin = "https://chatgpt.com";
    if (e2eOrigin !== null) {
      if (typeof e2eOrigin !== "string") refuse("origin_refused");
      const match =
        /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})$/u.exec(
          e2eOrigin,
        );
      if (
        !match ||
        Number(match[1]) > 65535 ||
        new URL(e2eOrigin).origin !== e2eOrigin
      )
        refuse("origin_refused");
      origin = e2eOrigin;
    }
    const documentAtStart = document;
    if (typeof documentAtStart !== "object" || documentAtStart === null)
      refuse("page_unavailable");
    const documentUrl = location.href;
    if (
      typeof documentUrl !== "string" ||
      documentUrl.length === 0 ||
      documentUrl.length > 4096 ||
      /[\u0000-\u001f\u007f-\u009f]/u.test(documentUrl)
    )
      refuse("origin_refused");
    code = "origin_refused";
    const url = new URL(documentUrl);
    if (
      url.origin !== origin ||
      url.username ||
      url.password ||
      documentUrl.includes("?") ||
      documentUrl.includes("#")
    )
      refuse("origin_refused");
    code = "page_unavailable";
    const started = performance.now();
    if (!Number.isFinite(started)) refuse("page_unavailable");
    const now = () => {
      const value = Date.now();
      if (!Number.isSafeInteger(value) || value < 0) refuse("session_refused");
      return value;
    };
    const wallAtStart = now();
    let expiryFence: number | null = null;
    const check = () => {
      if (stopped) refuse("timeout");
      const elapsed = performance.now() - started;
      if (!Number.isFinite(elapsed) || elapsed < 0) refuse("page_unavailable");
      if (elapsed >= 5000) refuse("timeout");
      if (document !== documentAtStart || location.href !== documentUrl)
        refuse("document_changed");
      const value = Date.now();
      if (
        !Number.isSafeInteger(value) ||
        value < wallAtStart ||
        (expiryFence !== null && value >= expiryFence)
      )
        refuse("session_refused");
    };
    controller = new AbortController();
    const remaining = 5000 - (performance.now() - started);
    if (!Number.isFinite(remaining) || remaining <= 0 || remaining > 5000)
      refuse("timeout");
    const deadline = new Promise<ChatGptAccountObservation>((resolve) => {
      timer = setTimeout(() => {
        stopped = true;
        cancel();
        resolve(unavailable("timeout"));
      }, remaining);
    });
    const work = async (): Promise<ChatGptAccountObservation> => {
      try {
        check();
        code = "request_failed";
        // Exactly one request, with no retry, redirect following, or credential extraction.
        const response = await fetch(`${origin}/api/auth/session`, {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
          signal: controller!.signal,
        });
        code = "response_refused";
        body = response.body;
        check();
        const finalUrl = new URL(response.url);
        if (
          response.type !== "basic" ||
          response.redirected !== false ||
          finalUrl.origin !== origin ||
          finalUrl.pathname !== "/api/auth/session" ||
          finalUrl.search ||
          finalUrl.hash ||
          finalUrl.username ||
          finalUrl.password ||
          response.status !== 200
        )
          refuse("response_refused");
        const contentType = response.headers.get("content-type");
        if (
          typeof contentType !== "string" ||
          !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/iu.test(
            contentType,
          )
        )
          refuse("response_refused");
        if (!body) refuse("body_failed");
        code = "body_failed";
        reader = body.getReader();
        const bytes = new Uint8Array(65536);
        let size = 0;
        while (true) {
          const chunk = await reader.read();
          check();
          if (chunk.done === true) break;
          if (chunk.done !== false || !(chunk.value instanceof Uint8Array))
            refuse("body_failed");
          if (chunk.value.byteLength > bytes.length - size)
            refuse("body_limit");
          bytes.set(chunk.value, size);
          size += chunk.value.byteLength;
        }
        // Reject BOM as well as ill-formed UTF-8. Never call response.json/text,
        // which would allocate an unbounded body before validation.
        if (
          size >= 3 &&
          bytes[0] === 0xef &&
          bytes[1] === 0xbb &&
          bytes[2] === 0xbf
        )
          refuse("session_refused");
        code = "session_refused";
        const session: unknown = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            bytes.subarray(0, size),
          ),
        );
        const own = (object: unknown, key: string): unknown => {
          if (
            typeof object !== "object" ||
            object === null ||
            Array.isArray(object)
          )
            refuse("session_refused");
          const property = Object.getOwnPropertyDescriptor(object, key);
          if (property && !("value" in property)) refuse("session_refused");
          return property?.value;
        };
        const scalar = (value: unknown): string => {
          if (
            typeof value !== "string" ||
            value.length === 0 ||
            value.length > 512 ||
            !value.trim() ||
            /[\u0000-\u001f\u007f-\u009f]/u.test(value)
          )
            refuse("session_refused");
          for (let index = 0; index < value.length; index++) {
            const unit = value.charCodeAt(index);
            if (unit >= 0xd800 && unit <= 0xdbff) {
              const next = value.charCodeAt(++index);
              if (!(next >= 0xdc00 && next <= 0xdfff))
                refuse("session_refused");
            } else if (unit >= 0xdc00 && unit <= 0xdfff)
              refuse("session_refused");
          }
          return value;
        };
        const error = own(session, "error");
        if (error !== undefined && error !== null && error !== "")
          refuse("session_refused");
        const userId = scalar(own(own(session, "user"), "id"));
        const accountId = scalar(own(own(session, "account"), "id"));
        const expires = own(session, "expires");
        // Session-v1 accepts strict UTC ISO timestamps, with optional millisecond precision.
        if (
          typeof expires !== "string" ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(expires)
        )
          refuse("session_refused");
        const expiresAtMillis = Date.parse(expires);
        // Date this session snapshot at identity extraction, before asynchronous
        // hashing. Later freshness checks do not create a new account observation.
        const observedAtMillis = now();
        if (
          !Number.isSafeInteger(expiresAtMillis) ||
          expiresAtMillis < 0 ||
          new Date(expiresAtMillis).toISOString() !==
            expires.replace(
              /(?:\.(\d{1,3}))?Z$/u,
              (_match, fraction: string | undefined) =>
                `.${(fraction ?? "").padEnd(3, "0")}Z`,
            ) ||
          expiresAtMillis <= observedAtMillis
        )
          refuse("session_refused");
        expiryFence = expiresAtMillis;
        check();
        code = "hash_failed";
        // Ordered JSON strings are unambiguous, including embedded delimiters and Unicode.
        // V1 identity is (user.id, account.id), never plan or active-organization state.
        const canonical = JSON.stringify([
          "farol/chatgpt-account/provider-session-v1",
          userId,
          accountId,
        ]);
        const digest = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(canonical),
        );
        check();
        code = "hash_failed";
        if (!(digest instanceof ArrayBuffer) || digest.byteLength !== 32)
          refuse("hash_failed");
        const accountKey = Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
        if (expiresAtMillis <= now()) refuse("session_refused");
        check();
        return {
          state: "observed",
          source: "provider-session-v1",
          accountKey,
          observedAtMillis,
          expiresAtMillis,
          documentUrl,
        };
      } catch {
        cancel();
        release();
        return unavailable(stopped ? "timeout" : code);
      }
    };
    const result = await Promise.race([work(), deadline]);
    if (result.state === "observed") {
      // Promise.race itself adds an awaited boundary; fence that final gap too.
      check();
      if (result.expiresAtMillis <= now()) refuse("session_refused");
      check();
      return result;
    }
    cancel();
    return result;
  } catch {
    cancel();
    return unavailable(code);
  } finally {
    stopped = true;
    if (timer !== undefined) {
      try {
        clearTimeout(timer);
      } catch {
        /* Never expose page exceptions during cleanup. */
      }
    }
    release();
  }
}

/** Trusted constructor input only; no environment/window-selected fixture policy. */
export function chatGptAccountProbeScript(
  e2eOrigin: string | null = null,
): string {
  if (e2eOrigin !== null) {
    const match =
      typeof e2eOrigin === "string"
        ? /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})$/u.exec(
            e2eOrigin,
          )
        : null;
    if (
      !match ||
      Number(match[1]) > 65535 ||
      new URL(e2eOrigin).origin !== e2eOrigin
    ) {
      throw new Error("Account probe fixture origin refused");
    }
  }
  return `(${readChatGptAccount.toString()})(${JSON.stringify(e2eOrigin)})`;
}
