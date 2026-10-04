import { createHash, webcrypto } from "node:crypto";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  ChatGptAccountObservationSchema,
  chatGptAccountProbeScript,
  readChatGptAccount,
  type ChatGptAccountObservation,
} from "../../apps/desktop/chatgpt-account-probe";

// CPU/VM doubles only. No browser, provider, network, native or production evidence.
const home = "https://chatgpt.com/c/fixture";
const endpoint = "https://chatgpt.com/api/auth/session";
const instant = Date.parse("2026-10-04T12:00:00Z");
const expiry = "2026-10-04T13:00:00.000Z";
const canaries = [
  "USER_CANARY",
  "ACCOUNT_CANARY",
  "TOKEN_CANARY",
  "COOKIE_CANARY",
  "EMAIL_CANARY",
  "NAME_CANARY",
  "PLAN_CANARY",
  "ERROR_CANARY",
];
const session = () => ({
  user: { id: canaries[0], email: canaries[4], name: canaries[5] },
  account: {
    id: canaries[1],
    plan: canaries[6],
    organization: "UNRELATED_ORG",
  },
  expires: expiry,
  accessToken: canaries[2],
  cookie: canaries[3],
});
const expectedKey = (user = canaries[0]!, account = canaries[1]!) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        "farol/chatgpt-account/provider-session-v1",
        user,
        account,
      ]),
    )
    .digest("hex");
const encoded = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value));

type Options = {
  href?: string;
  origin?: string | null;
  payload?: unknown;
  chunks?: Uint8Array[];
  response?: Record<string, unknown>;
  onFetch?: (() => void | Promise<void>) | undefined;
  onHash?: (() => void | Promise<void>) | undefined;
  stalledBody?: boolean;
  streamError?: boolean;
  brokenCancel?: boolean;
  globals?: Record<string, unknown>;
  rawFunction?: boolean;
};
function page(options: Options = {}) {
  let clock = instant;
  let elapsed = 0;
  let timer: (() => void) | undefined;
  let signal: AbortSignal | undefined;
  const context: Record<string, unknown> = {};
  const location = { href: options.href ?? home };
  const cancel = vi.fn(() =>
    options.brokenCancel ? new Promise<void>(() => {}) : undefined,
  );
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (options.stalledBody) return;
      if (options.streamError) {
        controller.error(new Error(canaries[7]));
        return;
      }
      for (const chunk of options.chunks ?? [
        encoded(options.payload ?? session()),
      ])
        controller.enqueue(chunk);
      controller.close();
    },
    cancel,
  });
  const fetch = vi.fn(
    async (
      _url: string,
      init: RequestInit,
    ): Promise<Record<string, unknown>> => {
      signal = init.signal ?? undefined;
      await options.onFetch?.();
      return {
        url: endpoint,
        type: "basic",
        redirected: false,
        status: 200,
        headers: new Headers({
          "content-type": "application/json; charset=utf-8",
        }),
        body,
        ...options.response,
      };
    },
  );
  const hash = vi.fn(async (algorithm: string, bytes: Uint8Array) => {
    await options.onHash?.();
    return webcrypto.subtle.digest(algorithm, bytes);
  });
  const setTimer = vi.fn((callback: () => void, delay: number) => {
    expect(delay).toBe(5000);
    timer = callback;
    return 1;
  });
  const clearTimer = vi.fn(() => {
    timer = undefined;
  });
  Object.assign(context, {
    document: {},
    location,
    fetch,
    crypto: { subtle: { digest: hash } },
    TextDecoder,
    TextEncoder,
    Uint8Array,
    ArrayBuffer,
    AbortController,
    URL,
    Date: class extends Date {
      static override now() {
        return clock;
      }
    },
    performance: { now: () => elapsed },
    setTimeout: setTimer,
    clearTimeout: clearTimer,
    ...options.globals,
  });
  const script = options.rawFunction
    ? `(${readChatGptAccount.toString()})(${JSON.stringify(options.origin ?? null)})`
    : chatGptAccountProbeScript(options.origin);
  return {
    context,
    location,
    fetch,
    hash,
    cancel,
    clearTimer,
    signal: () => signal,
    advance: (millis: number) => {
      clock += millis;
    },
    timeout: () => {
      elapsed = 5000;
      timer?.();
    },
    elapsed: (millis: number) => {
      elapsed = millis;
    },
    run: async () => {
      const raw: unknown = await vm.runInNewContext(script, context);
      const output = JSON.stringify(raw);
      for (const canary of canaries) expect(output).not.toContain(canary);
      const result = ChatGptAccountObservationSchema.parse(raw);
      expect(fetch.mock.calls.length).toBeLessThanOrEqual(1);
      return result;
    },
  };
}
function failure(result: ChatGptAccountObservation, code: string) {
  expect(result).toEqual({ state: "unavailable", code });
}
function observed(result: ChatGptAccountObservation) {
  expect(result.state).toBe("observed");
  if (result.state !== "observed") throw new Error("Expected observation");
  return result;
}

describe("read-only session identity mechanics", () => {
  it("makes one physical same-origin GET and returns only bounded hashed facts", async () => {
    const fixture = page();
    expect(await fixture.run()).toEqual({
      state: "observed",
      source: "provider-session-v1",
      accountKey: expectedKey(),
      observedAtMillis: instant,
      expiresAtMillis: Date.parse(expiry),
      documentUrl: home,
    });
    expect(fixture.fetch).toHaveBeenCalledExactlyOnceWith(endpoint, {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal: fixture.signal(),
    });
    expect(fixture.hash).toHaveBeenCalledTimes(1);
    expect(fixture.signal()?.aborted).toBe(false);
    expect(fixture.clearTimer).toHaveBeenCalledOnce();
  });

  it.each([
    "http://127.0.0.1:4317",
    "http://localhost:4317",
    "http://[::1]:4317",
  ])("accepts a trusted canonical loopback override: %s", async (origin) => {
    const fixture = page({
      origin,
      href: `${origin}/chatgpt`,
      response: { url: `${origin}/api/auth/session` },
    });
    expect(observed(await fixture.run()).documentUrl).toBe(`${origin}/chatgpt`);
    expect(fixture.fetch.mock.calls[0]?.[0]).toBe(`${origin}/api/auth/session`);
  });

  it.each(["https://chatgpt.com", "http://127.0.0.1:4317"])(
    "accepts supported canonical chat documents at %s",
    async (origin) => {
      const base = origin.startsWith("http:") ? "/chatgpt" : "";
      for (const path of [
        "/",
        "/c/12345678-1234-4123-8123-123456789abc",
        "/c/Az_09-",
        `/c/${"a".repeat(128)}`,
      ]) {
        const documentPath = path === "/" ? base || "/" : `${base}${path}`;
        const fixture = page({
          href: `${origin}${documentPath}`,
          origin: origin.startsWith("http:") ? origin : null,
          response: { url: `${origin}/api/auth/session` },
        });
        expect(observed(await fixture.run()).documentUrl).toBe(
          `${origin}${documentPath}`,
        );
        expect(fixture.fetch).toHaveBeenCalledOnce();
      }
    },
  );

  it.each(["https://chatgpt.com", "http://127.0.0.1:4317"])(
    "refuses unsupported/aliased paths before GET at %s",
    async (origin) => {
      const base = origin.startsWith("http:") ? "/chatgpt" : "";
      for (const path of [
        "/auth/TOKEN_CANARY",
        "/reset/USER_CANARY/TOKEN_CANARY",
        "/TOKEN_CANARY",
        "/g/custom-gpt",
        "/c/",
        "/c/fixture/",
        "/c/a/b",
        "/c/%66ixture",
        "/%63/fixture",
        "/c/%2e%2e/",
        "/c/./fixture",
        "/c/é",
        "/c/a.b",
        `/c/${"a".repeat(129)}`,
      ]) {
        const documentPath = path === "/" ? base || "/" : `${base}${path}`;
        const fixture = page({
          href: `${origin}${documentPath}`,
          origin: origin.startsWith("http:") ? origin : null,
        });
        failure(await fixture.run(), "origin_refused");
        expect(fixture.fetch).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    { origin: null, href: "https://chatgpt.com/chatgpt" },
    { origin: null, href: "https://chatgpt.com/chatgpt/c/fixture" },
    { origin: "http://127.0.0.1:4317", href: "http://127.0.0.1:4317/" },
    {
      origin: "http://127.0.0.1:4317",
      href: "http://127.0.0.1:4317/c/fixture",
    },
  ])(
    "keeps production and controlled-site paths separate: $href",
    async (input) => {
      const fixture = page(input);
      failure(await fixture.run(), "origin_refused");
      expect(fixture.fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    "https://example.com/",
    "http://chatgpt.com/",
    "https://chatgpt.com.evil/",
    "https://chatgpt.com:444/",
    "https://user:secret@chatgpt.com/",
    "https://USER_CANARY:COOKIE_CANARY@chatgpt.com/",
    "https://TOKEN_CANARY@chatgpt.com/",
    "https://:TOKEN_CANARY@chatgpt.com/",
    `${home}?access_token=TOKEN_CANARY&cookie=COOKIE_CANARY`,
    `${home}#token=TOKEN_CANARY`,
    `${home}?`,
    `${home}#`,
    "not a URL",
    "http://127.0.0.1:4317/",
    "https://chatgpt.com/" + "x".repeat(4097),
    "https://chatgpt.com/\nfixture",
  ])("refuses foreign or malformed page before fetch: %s", async (href) => {
    const fixture = page({ href });
    failure(await fixture.run(), "origin_refused");
    expect(fixture.fetch).not.toHaveBeenCalled();
  });

  it.each([
    "https://chatgpt.com",
    "http://example.com:4317",
    "http://127.1:4317",
    "http://2130706433:4317",
    "http://0x7f000001:4317",
    "http://127.0.0.2:4317",
    "http://localhost",
    "http://localhost:80",
    "http://localhost:0",
    "http://localhost:65536",
    "http://localhost:04317",
    "http://LOCALHOST:4317",
    "http://localhost.:4317",
    "http://localhost:4317/",
    "http://localhost:4317?x",
    "http://localhost:4317#x",
    "http://user@localhost:4317",
    "https://localhost:4317",
    " http://localhost:4317",
    "http://[0:0:0:0:0:0:0:1]:4317",
    "http://localhost:4317\n",
    'http://localhost:4317");throw "CANARY";//',
  ])("refuses ambiguous or invalid fixture origin: %s", async (origin) => {
    expect(() => chatGptAccountProbeScript(origin)).toThrow(
      "Account probe fixture origin refused",
    );
    const fixture = page({ origin, rawFunction: true });
    failure(await fixture.run(), "origin_refused");
    expect(fixture.fetch).not.toHaveBeenCalled();
  });

  it("ignores window/environment/test-side policy and answers", async () => {
    const fixture = page({
      href: "http://127.0.0.1:4317/",
      globals: {
        window: { e2eOrigin: "http://127.0.0.1:4317", account: session() },
        process: { env: { E2E_ORIGIN: "http://127.0.0.1:4317" } },
      },
    });
    failure(await fixture.run(), "origin_refused");
    expect(fixture.fetch).not.toHaveBeenCalled();
  });

  it.each([
    { url: "https://example.com/api/auth/session" },
    { url: "https://chatgpt.com/api/auth/session/" },
    { url: `${endpoint}?token=TOKEN_CANARY` },
    { url: `${endpoint}#x` },
    { url: "https://secret@chatgpt.com/api/auth/session" },
    { url: "broken" },
    { redirected: true },
    { redirected: undefined },
    { type: "opaque" },
    { type: "opaqueredirect" },
    { type: "cors" },
    { type: "error" },
    { type: "default" },
    { type: undefined },
    { type: "BASIC" },
    { status: 302 },
    { status: 401 },
    { status: 500 },
    { status: 204 },
    { status: "200" },
    { headers: new Headers({ "content-type": "text/html" }) },
    {
      headers: new Headers({
        "content-type": "application/json; charset=latin1",
      }),
    },
    { headers: new Headers({ "content-type": "application/jsonp" }) },
    { headers: new Headers() },
  ])("refuses response metadata without leaking it: %j", async (response) => {
    const fixture = page({ response });
    failure(await fixture.run(), "response_refused");
    expect(fixture.fetch).toHaveBeenCalledOnce();
    expect(fixture.hash).not.toHaveBeenCalled();
    expect(fixture.signal()?.aborted).toBe(true);
  });

  it.each(["application/json", 'Application/JSON; charset="UTF-8"'])(
    "accepts JSON UTF-8 content type: %s",
    async (contentType) => {
      observed(
        await page({
          response: { headers: new Headers({ "content-type": contentType }) },
        }).run(),
      );
    },
  );

  it("enforces the cap on streamed bytes even without Content-Length", async () => {
    const fixture = page({
      chunks: [new Uint8Array(65535), new Uint8Array(2)],
    });
    failure(await fixture.run(), "body_limit");
    expect(fixture.signal()?.aborted).toBe(true);
    expect(fixture.hash).not.toHaveBeenCalled();
  });

  it("accepts exactly 64 KiB and split multibyte UTF-8", async () => {
    const payload = { ...session(), user: { id: "é😀" } };
    const bytes = encoded(payload);
    const capped = new Uint8Array(65536).fill(32);
    capped.set(bytes);
    const fixture = page({
      chunks: Array.from(capped.subarray(0, bytes.length), (byte) =>
        Uint8Array.of(byte),
      ).concat([capped.subarray(bytes.length)]),
    });
    expect(observed(await fixture.run()).accountKey).toBe(expectedKey("é😀"));
  });

  it.each([
    Uint8Array.of(0xc0, 0xaf),
    Uint8Array.of(0xff),
    Uint8Array.of(0xe2, 0x82),
    Uint8Array.of(0xef, 0xbb, 0xbf, 0x7b, 0x7d),
    new TextEncoder().encode("{bad json"),
    new Uint8Array(),
  ])("refuses malformed UTF-8, BOM or JSON", async (bytes) => {
    failure(await page({ chunks: [bytes] }).run(), "session_refused");
  });

  it.each([
    {},
    [],
    "session",
    null,
    { ...session(), user: undefined },
    { ...session(), account: undefined },
    { ...session(), user: { id: "" } },
    { ...session(), account: { id: 17 } },
    { ...session(), account: { id: {} } },
    { ...session(), user: { id: "x".repeat(513) } },
    { ...session(), user: { id: "\n" } },
    { ...session(), user: { id: " " } },
    { ...session(), user: { id: "a\u0080b" } },
    { ...session(), user: { id: "\ud800" } },
    { ...session(), account: { id: "\udc00" } },
    { ...session(), expires: undefined },
    { ...session(), expires: 123 },
    { ...session(), expires: "not a date" },
    { ...session(), expires: "2026-02-30T13:00:00Z" },
    { ...session(), expires: "2026-10-04T25:00:00Z" },
    { ...session(), expires: "2026-10-04T12:00:00Z" },
    { ...session(), expires: "2025-10-04T13:00:00Z" },
    { ...session(), expires: "2026-10-04" },
    { ...session(), expires: "2026-10-04T13:00:00.0000Z" },
    { ...session(), error: canaries[7] },
    { ...session(), error: {} },
    { ...session(), error: false },
  ])(
    "refuses missing, malformed, expired or errored sessions",
    async (payload) => {
      // null is deliberate; the harness otherwise supplies the default session.
      const fixture = page({ chunks: [encoded(payload)] });
      failure(await fixture.run(), "session_refused");
      expect(fixture.hash).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, null, ""])(
    "permits absent/null/empty session error: %s",
    async (error) => {
      observed(await page({ payload: { ...session(), error } }).run());
    },
  );

  it.each([
    "2026-10-04T13:00:00Z",
    "2026-10-04T13:00:00.1Z",
    "2026-10-04T13:00:00.12Z",
  ])("accepts strict UTC expiry: %s", async (expires) => {
    expect(
      observed(await page({ payload: { ...session(), expires } }).run())
        .expiresAtMillis,
    ).toBe(Date.parse(expires));
  });

  it("keeps concatenation-like identities distinct with an independent hash oracle", async () => {
    const identities = [
      ["ab", "c"],
      ["a", "bc"],
      ["user", "account"],
      ["user", "other"],
      ["other", "account"],
      ['a"\\\u2028', "b😀"],
    ];
    const keys = [];
    for (const [user, account] of identities) {
      const result = observed(
        await page({
          payload: {
            ...session(),
            user: { id: user },
            account: { id: account },
          },
        }).run(),
      );
      expect(result.accountKey).toBe(expectedKey(user, account));
      keys.push(result.accountKey);
    }
    expect(new Set(keys).size).toBe(identities.length);
  });

  it.each(["fetch", "hash"])(
    "refuses a URL crossing during %s",
    async (phase) => {
      const fixture = page({
        [phase === "fetch" ? "onFetch" : "onHash"]: () => {
          fixture.location.href = `${home}?changed`;
        },
      });
      failure(await fixture.run(), "document_changed");
      expect(fixture.fetch).toHaveBeenCalledOnce();
    },
  );

  it.each(["fetch", "hash"])(
    "refuses a replaced document at the same URL during %s",
    async (phase) => {
      const fixture = page({
        [phase === "fetch" ? "onFetch" : "onHash"]: () => {
          fixture.context.document = {};
        },
      });
      failure(await fixture.run(), "document_changed");
    },
  );

  it("rechecks expiry after hash without advancing the session observation timestamp", async () => {
    const fixture = page({
      onHash: () => {
        fixture.advance(1000);
      },
    });
    expect(observed(await fixture.run()).observedAtMillis).toBe(instant);
    const expired = page({
      onHash: () => {
        expired.advance(3600000);
      },
    });
    failure(await expired.run(), "session_refused");
  });

  it.each([NaN, -1, Number.MAX_SAFE_INTEGER + 1])(
    "refuses unsafe wall clock: %s",
    async (clock) => {
      failure(
        await page({
          globals: {
            Date: class extends Date {
              static override now() {
                return clock;
              }
            },
          },
        }).run(),
        "session_refused",
      );
    },
  );

  it.each(["fetch", "body", "hash"])(
    "bounds a stalled %s and never awaits broken cancellation",
    async (phase) => {
      const pending = new Promise<void>(() => {});
      const fixture = page({
        stalledBody: phase === "body",
        brokenCancel: true,
        onFetch: phase === "fetch" ? () => pending : undefined,
        onHash: phase === "hash" ? () => pending : undefined,
      });
      const result = fixture.run();
      // Advance promise jobs until fetch/body/hash has reached its stall.
      for (let index = 0; index < 12; index++) await Promise.resolve();
      fixture.timeout();
      failure(await result, "timeout");
      expect(fixture.fetch).toHaveBeenCalledOnce();
      expect(fixture.signal()?.aborted).toBe(true);
      if (phase === "body") expect(fixture.cancel).toHaveBeenCalledOnce();
      expect(fixture.clearTimer).toHaveBeenCalledOnce();
    },
  );

  it("fences late fetch completion after timeout without retry or hashing", async () => {
    let finish: () => void = () => {};
    const delayed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const cancel = vi.fn(async () => {});
    const fixture = page({
      onFetch: () => delayed,
      response: { body: new ReadableStream({ cancel }) },
    });
    const result = fixture.run();
    fixture.timeout();
    failure(await result, "timeout");
    finish();
    for (let index = 0; index < 12; index++) await Promise.resolve();
    expect(fixture.hash).not.toHaveBeenCalled();
    expect(fixture.fetch).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("refuses URL change across an awaited body read and cancels it", async () => {
    const cancel = vi.fn(async () => {});
    const fixture = page({
      response: {
        body: {
          getReader: () => ({
            read: async () => {
              await Promise.resolve();
              fixture.location.href = `${home}#changed`;
              return { done: false, value: encoded(session()) };
            },
            cancel,
            releaseLock: () => {},
          }),
        },
      },
    });
    failure(await fixture.run(), "document_changed");
    expect(fixture.hash).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each(["URL", "document", "expiry"])(
    "fences %s changes in the final Promise.race gap",
    async (kind) => {
      const fixture = page({
        globals: {
          Array: {
            isArray: Array.isArray,
            from: (bytes: Uint8Array, mapper: (byte: number) => string) => {
              const result = Array.from(bytes, mapper);
              queueMicrotask(() => {
                if (kind === "URL") fixture.location.href = `${home}?changed`;
                if (kind === "document") fixture.context.document = {};
                if (kind === "expiry") fixture.advance(3600000);
              });
              return result;
            },
          },
        },
      });
      failure(
        await fixture.run(),
        kind === "expiry" ? "session_refused" : "document_changed",
      );
    },
  );

  it("refuses a wall clock rollback after fetch", async () => {
    const fixture = page({
      onFetch: () => {
        fixture.advance(-1);
      },
    });
    failure(await fixture.run(), "session_refused");
  });

  it("never exposes throwing cleanup errors", async () => {
    const fixture = page({
      globals: {
        clearTimeout: () => {
          throw new Error(canaries[7]);
        },
      },
    });
    observed(await fixture.run());
  });

  it("enforces elapsed deadline even before a delayed timer callback", async () => {
    const fixture = page({
      onHash: () => {
        fixture.elapsed(5000);
      },
    });
    failure(await fixture.run(), "timeout");
  });

  it("classifies request rejection without retry or raw errors", async () => {
    const fixture = page({
      onFetch: () => {
        throw new Error(canaries[7]);
      },
    });
    failure(await fixture.run(), "request_failed");
    expect(fixture.fetch).toHaveBeenCalledOnce();
  });

  it("classifies stream failure, missing body and malformed chunks", async () => {
    failure(await page({ streamError: true }).run(), "body_failed");
    failure(await page({ response: { body: null } }).run(), "body_failed");
    const cancel = vi.fn(async () => {});
    const releaseLock = vi.fn();
    const fixture = page({
      response: {
        body: {
          getReader: () => ({
            read: async () => ({ done: false, value: "TOKEN_CANARY" }),
            cancel,
            releaseLock,
          }),
        },
      },
    });
    failure(await fixture.run(), "body_failed");
    expect(cancel).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledOnce();
  });

  it("cancels an oversized open stream exactly once", async () => {
    const cancel = vi.fn(async () => {});
    const fixture = page({
      response: {
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(65537));
          },
          cancel,
        }),
      },
    });
    failure(await fixture.run(), "body_limit");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects session accessors without invoking identity or unrelated credential getters", async () => {
    const identityGetter = vi.fn(() => {
      throw new Error(canaries[0]);
    });
    const credentialGetter = vi.fn(() => {
      throw new Error(canaries[2]);
    });
    const object = session();
    Object.defineProperty(object.user, "id", { get: identityGetter });
    Object.defineProperty(object, "accessToken", { get: credentialGetter });
    const fixture = page({
      globals: { JSON: { parse: () => object, stringify: JSON.stringify } },
    });
    failure(await fixture.run(), "session_refused");
    expect(identityGetter).not.toHaveBeenCalled();
    expect(credentialGetter).not.toHaveBeenCalled();
  });

  it("never reads unrelated credential/session getters", async () => {
    const getter = vi.fn(() => {
      throw new Error(canaries[2]);
    });
    const object = session();
    Object.defineProperty(object, "accessToken", { get: getter });
    observed(
      await page({
        globals: { JSON: { parse: () => object, stringify: JSON.stringify } },
      }).run(),
    );
    expect(getter).not.toHaveBeenCalled();
  });

  it("classifies throwing page and response accessors content-free", async () => {
    const location = Object.defineProperty({}, "href", {
      get() {
        throw new Error(canaries[7]);
      },
    });
    const fixture = page({ globals: { location } });
    failure(await fixture.run(), "page_unavailable");
    expect(fixture.fetch).not.toHaveBeenCalled();
    const metadata = page();
    metadata.fetch.mockImplementation(async () =>
      Object.defineProperty(
        {
          url: endpoint,
          type: "basic",
          redirected: false,
          status: 200,
          headers: new Headers(),
          body: null,
        },
        "url",
        {
          get() {
            throw new Error(canaries[7]);
          },
        },
      ),
    );
    failure(await metadata.run(), "response_refused");
  });

  it.each([undefined, null, "fake document"])(
    "refuses a malformed document object before fetch",
    async (document) => {
      const fixture = page({ globals: { document } });
      failure(await fixture.run(), "page_unavailable");
      expect(fixture.fetch).not.toHaveBeenCalled();
    },
  );

  it.each(["rejection", "bad bytes"])(
    "classifies hash %s content-free",
    async (kind) => {
      const digest =
        kind === "rejection"
          ? async () => {
              throw new Error(canaries[7]);
            }
          : async () => new ArrayBuffer(31);
      failure(
        await page({ globals: { crypto: { subtle: { digest } } } }).run(),
        "hash_failed",
      );
    },
  );

  it.each([
    undefined,
    { ...session(), error: canaries[7] },
    { ...session(), user: {} },
  ])(
    "executes actual function serialization and builder with identical parsed behavior",
    async (payload) => {
      const direct = await page({ payload, rawFunction: true }).run();
      const built = await page({ payload }).run();
      expect(built).toEqual(direct);
      if (payload === undefined)
        expect(observed(built).accountKey).toBe(expectedKey());
      else failure(built, "session_refused");
    },
  );
});

describe("closed observation parser", () => {
  const success = {
    state: "observed",
    source: "provider-session-v1",
    accountKey: expectedKey(),
    observedAtMillis: instant,
    expiresAtMillis: Date.parse(expiry),
    documentUrl: home,
  };
  it("accepts both closed states", () => {
    expect(ChatGptAccountObservationSchema.parse(success)).toEqual(success);
    expect(
      ChatGptAccountObservationSchema.parse({
        state: "unavailable",
        code: "timeout",
      }),
    ).toEqual({ state: "unavailable", code: "timeout" });
  });
  it.each([
    { ...success, userId: canaries[0] },
    { ...success, accountKey: "A".repeat(64) },
    { ...success, accountKey: "a".repeat(64) + "\n" },
    { ...success, observedAtMillis: 1.5 },
    { ...success, observedAtMillis: -1 },
    { ...success, observedAtMillis: Number.MAX_SAFE_INTEGER + 1 },
    { ...success, expiresAtMillis: instant },
    { ...success, expiresAtMillis: Infinity },
    { ...success, documentUrl: "x".repeat(4097) },
    { ...success, documentUrl: "\n" },
    { ...success, documentUrl: "https://chatgpt.com/auth/TOKEN_CANARY" },
    { ...success, documentUrl: "https://chatgpt.com/c/%66ixture" },
    { ...success, documentUrl: "https://chatgpt.com/g/custom-gpt" },
    { ...success, documentUrl: "https://example.com/" },
    { ...success, documentUrl: "http://chatgpt.com/" },
    { ...success, documentUrl: "http://127.0.0.1:4317/" },
    { ...success, documentUrl: "https://chatgpt.com/chatgpt" },
    { ...success, documentUrl: `${home}?token=TOKEN_CANARY` },
    { ...success, documentUrl: `${home}#COOKIE_CANARY` },
    {
      ...success,
      documentUrl: "https://USER_CANARY:TOKEN_CANARY@chatgpt.com/",
    },
    { ...success, source: "public-dom" },
    { state: "unavailable", code: "ERROR_CANARY" },
    { state: "unavailable", code: "timeout", error: canaries[7] },
    { state: "unavailable", code: "timeout", accountKey: expectedKey() },
    null,
    [],
    { state: "observed" },
  ])("rejects extra fields, malformed facts and open codes", (value) => {
    expect(ChatGptAccountObservationSchema.safeParse(value).success).toBe(
      false,
    );
  });
  it("rejects accessors and throwing proxies without invoking or exposing getters", () => {
    const getter = vi.fn(() => {
      throw new Error(canaries[0]);
    });
    const value = Object.defineProperty({ ...success }, "accountKey", {
      get: getter,
    });
    expect(ChatGptAccountObservationSchema.safeParse(value).success).toBe(
      false,
    );
    expect(getter).not.toHaveBeenCalled();
    const proxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error(canaries[7]);
        },
      },
    );
    expect(ChatGptAccountObservationSchema.safeParse(proxy).success).toBe(
      false,
    );
  });
});
