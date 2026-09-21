import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import * as endpointModule from "../../src/apps/desktop/farol-model-endpoint";
import {
  FAROL_MODEL_RESPONSES_PATH,
  FarolModelEndpoint,
  routeBModelTurnHandler,
} from "../../src/apps/desktop/farol-model-endpoint";
import { FarolModelRuntimeState } from "../../src/apps/desktop/farol-model-runtime-state";
import {
  startCodexChatGptProvider,
  type CodexChatGptConversation,
  type CodexChatGptProviderRuntime,
} from "../../src/apps/desktop/codex-chatgpt-provider";

// Parity between the outer Farol Model bridge and the inner Route B
// provider, written against the contract being landed in
// `farol-model-endpoint.ts`: the outer layer streams rather than buffering,
// it never turns a dead or empty inner answer into a successful empty 200,
// it carries the one compaction route the inner serves, and it forwards
// exactly one metadata header and nothing else.
//
// A one-frame fixture cannot see any of that, which is why every row here
// drives the OUTER endpoint and asks what the outer client and the inner
// server each actually saw. Where the behaviour is about identity rules the
// inner already owns, the inner is the real provider; where a test must
// hold or break the inner mid-answer, it is a synthetic upstream.

const MODEL = "farol-next/mind";
const INNER_TOKEN = "route-b-test-token";
const METADATA_HEADER = "x-codex-turn-metadata";

type RouteBTarget = Readonly<{ baseUrl: string; token: string }>;

// The part of the contract that does not exist on today's module. Typed
// here so this file compiles against today's source and fails on today's
// BEHAVIOUR rather than on a missing symbol.
const contract = endpointModule as unknown as Readonly<{
  FAROL_MODEL_RESPONSES_COMPACT_PATH?: string;
  routeBModelCompactionHandler?: (target: () => RouteBTarget | null) => unknown;
}>;

const COMPACT_PATH =
  contract.FAROL_MODEL_RESPONSES_COMPACT_PATH ?? "/responses/compact";

const roots: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function stateRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-model-parity-"));
  roots.push(root);
  return path.join(root, "private", "model-endpoint");
}

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const CREATED = sseFrame("response.created", { type: "response.created" });
const COMPLETED = sseFrame("response.completed", {
  type: "response.completed",
  response: { status: "completed" },
});
const FAILED = sseFrame("response.failed", {
  type: "response.failed",
  response: { status: "failed", error: { code: "CHATGPT_TASK_ERROR" } },
});

type InnerBehaviour =
  "two-phase" | "failed" | "die-after-created" | "empty-200";

type InnerRequest = Readonly<{
  method: string;
  url: string;
  headers: Readonly<Record<string, string>>;
  body: string;
}>;

type SyntheticInner = Readonly<{
  target: RouteBTarget;
  requests: InnerRequest[];
  firstFrameFlushed: Promise<void>;
  release: () => void;
}>;

/**
 * An inner Route B upstream this test can hold open or break on purpose.
 * `firstFrameFlushed` resolves from the write callback, so it means the
 * bytes left this process rather than that `write` was called.
 */
async function syntheticInner(
  behaviour: InnerBehaviour,
): Promise<SyntheticInner> {
  let flushed: () => void = () => undefined;
  const firstFrameFlushed = new Promise<void>((resolve) => {
    flushed = resolve;
  });
  let release: () => void = () => undefined;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requests: InnerRequest[] = [];
  const server = http.createServer((request, response) => {
    if (request.method === "GET") {
      response.writeHead(200).end("pong");
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (body += chunk));
    request.on("end", () => {
      requests.push({
        method: request.method ?? "",
        url: request.url ?? "",
        headers: Object.fromEntries(
          Object.entries(request.headers).map(([key, value]) => [
            key,
            Array.isArray(value) ? value.join(",") : (value ?? ""),
          ]),
        ),
        body,
      });
      if (behaviour === "empty-200") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end();
        flushed();
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(CREATED, () => flushed());
      if (behaviour === "die-after-created") {
        // The inner answer stops existing after its first frame: the
        // socket is destroyed without a terminal event and without a
        // well-formed end of body.
        void firstFrameFlushed.then(() => request.socket.destroy());
        return;
      }
      void barrier.then(() => {
        response.write(behaviour === "failed" ? FAILED : COMPLETED);
        response.end();
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        release();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const port = (server.address() as { port: number }).port;
  return {
    target: { baseUrl: `http://127.0.0.1:${port}`, token: INNER_TOKEN },
    requests,
    firstFrameFlushed,
    release: () => release(),
  };
}

/** Prove the event loop has carried a whole request and answer since. */
async function innerRoundTrip(target: RouteBTarget): Promise<void> {
  expect(await (await fetch(`${target.baseUrl}/ping`)).text()).toBe("pong");
}

type OuterEndpoint = Readonly<{
  url: (route: string) => string;
  token: string;
}>;

async function outerEndpoint(
  options: Readonly<{ target: RouteBTarget }>,
): Promise<OuterEndpoint> {
  const state = new FarolModelRuntimeState(await stateRoot());
  const compaction = contract.routeBModelCompactionHandler;
  const endpoint = new FarolModelEndpoint({
    state,
    model: MODEL,
    handler: routeBModelTurnHandler(() => options.target),
    ...(compaction
      ? { compactionHandler: compaction(() => options.target) }
      : {}),
  } as ConstructorParameters<typeof FarolModelEndpoint>[0]);
  closers.push(() => endpoint.stop().catch(() => undefined));
  const { port } = await endpoint.start();
  const token = (await state.currentToken()) as string;
  return { url: (route) => `http://127.0.0.1:${port}${route}`, token };
}

function turnBody(extra: Readonly<Record<string, unknown>> = {}) {
  return {
    model: MODEL,
    stream: true,
    store: false,
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Say hello" }],
      },
    ],
    ...extra,
  };
}

/** Read an SSE body to its end and return the `event:` names in order. */
async function sseEventNames(response: Response): Promise<string[]> {
  const text = await response.text();
  return text
    .split("\n")
    .filter((line) => line.startsWith("event: "))
    .map((line) => line.slice("event: ".length));
}

function compactionMetadata(turnId = "turn-compact-1") {
  return JSON.stringify({ thread_id: "thread-route-b", turn_id: turnId });
}

function compactionHistory() {
  return [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Keep the latest constraint." }],
    },
  ];
}

const compactedConversation: CodexChatGptConversation = {
  run: async (_input, observer) => {
    await observer.onTextDelta({
      sequence: 1,
      delta: "Compacted.",
      text: "Compacted.",
      observedCharacters: 10,
    });
    return {
      state: "completed" as const,
      code: null,
      outputText: "Compacted.",
      observedProvider: "chatgpt-web",
      observedModel: null,
      observedMode: null,
    };
  },
};

/**
 * The product's real inner provider, as the outer bridge's upstream.
 *
 * The summary-only compaction adapter is a port the provider requires
 * before it serves `/v1/responses/compact` at all -- without it every
 * compaction answers 501 `FAROL_NEXT_COMPACTION_UNSUPPORTED`, measured
 * here before these rows were written. It is supplied as a fixture that
 * always returns the same replacement history, so what these rows exercise
 * is the provider's own identity validation, which runs before the port is
 * ever called, and not a summary this test invented.
 */
async function realInner(): Promise<RouteBTarget> {
  const compact = async () => ({
    ok: true as const,
    value: {
      variant: "unary_replacement_history" as const,
      response: {
        output: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "Validated compact context" },
            ],
          },
        ],
      },
    },
  });
  let runtime: CodexChatGptProviderRuntime | null =
    await startCodexChatGptProvider({
      model: MODEL,
      token: INNER_TOKEN,
      conversation: compactedConversation,
      compaction: { compact },
      turns: {
        admit: async () => "admitted",
        release: async () => undefined,
      },
    } as unknown as Parameters<typeof startCodexChatGptProvider>[0]);
  closers.push(async () => {
    await runtime?.close();
    runtime = null;
  });
  return { baseUrl: `${runtime.baseUrl}/v1`, token: INNER_TOKEN };
}

describe("Farol Model bridge parity with Route B: streaming", () => {
  it("opens its own response on the inner's first frame, not on its last", async () => {
    const inner = await syntheticInner("two-phase");
    const outer = await outerEndpoint({ target: inner.target });

    const answered = fetch(outer.url(FAROL_MODEL_RESPONSES_PATH), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${outer.token}`,
      },
      body: JSON.stringify(turnBody()),
    });

    // A streaming bridge answers as soon as the inner's first frame lands.
    // The losing branch costs a whole extra request and answer to the same
    // inner, so this does not turn on a scheduling accident.
    const raced = await Promise.race([
      answered.then(() => "outer-answered" as const),
      (async () => {
        await inner.firstFrameFlushed;
        await innerRoundTrip(inner.target);
        return "outer-still-waiting-for-the-inner-to-finish" as const;
      })(),
    ]);
    expect(raced).toBe("outer-answered");

    const response = await answered;
    expect(response.status).toBe(200);
    inner.release();
    expect(await sseEventNames(response)).toEqual([
      "response.created",
      "response.completed",
    ]);
    // Exactly one upstream request, never a retry.
    expect(inner.requests.filter((r) => r.method === "POST")).toHaveLength(1);
  });

  it("relays an inner response.failed as failed, never as completed", async () => {
    const inner = await syntheticInner("failed");
    const outer = await outerEndpoint({ target: inner.target });
    inner.release();

    const response = await fetch(outer.url(FAROL_MODEL_RESPONSES_PATH), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${outer.token}`,
      },
      body: JSON.stringify(turnBody()),
    });

    expect(response.status).toBe(200);
    const names = await sseEventNames(response);
    expect(names).toContain("response.failed");
    expect(names).not.toContain("response.completed");
  });

  it("ends a stream whose inner body died with response.failed, not completed", async () => {
    const inner = await syntheticInner("die-after-created");
    const outer = await outerEndpoint({ target: inner.target });

    const response = await fetch(outer.url(FAROL_MODEL_RESPONSES_PATH), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${outer.token}`,
      },
      body: JSON.stringify(turnBody()),
    });

    // The first frame was already delivered, so the turn cannot be refused
    // with a status any more: it has to end as a failure inside the stream.
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("response.created");
    expect(text).toContain("response.failed");
    expect(text).toContain("FAROL_MODEL_ROUTE_UNREACHABLE");
    expect(text).not.toContain("response.completed");
  });

  it("refuses an inner 200 that carries no event at all", async () => {
    const inner = await syntheticInner("empty-200");
    const outer = await outerEndpoint({ target: inner.target });

    const response = await fetch(outer.url(FAROL_MODEL_RESPONSES_PATH), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${outer.token}`,
      },
      body: JSON.stringify(turnBody()),
    });

    // An empty successful answer is an answer the provider never gave.
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("FAROL_MODEL_ROUTE_UNREACHABLE");
  });
});

describe("Farol Model bridge parity with Route B: header allowlist", () => {
  it("forwards the compaction metadata header and nothing else of the caller's", async () => {
    const inner = await syntheticInner("two-phase");
    const outer = await outerEndpoint({ target: inner.target });
    inner.release();

    await fetch(outer.url(FAROL_MODEL_RESPONSES_PATH), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${outer.token}`,
        [METADATA_HEADER]: compactionMetadata(),
        "x-unreviewed-header": "must not be forwarded",
      },
      body: JSON.stringify(turnBody()),
    });

    const forwarded = inner.requests.find((r) => r.method === "POST");
    expect(forwarded).toBeDefined();
    // The one reviewed header crosses the boundary.
    expect(forwarded?.headers[METADATA_HEADER]).toBe(compactionMetadata());
    // The caller's own bearer never does: the inner sees the internal one.
    expect(forwarded?.headers.authorization).toBe(`Bearer ${INNER_TOKEN}`);
    expect(forwarded?.headers.authorization).not.toContain(outer.token);
    expect(forwarded?.headers["x-unreviewed-header"]).toBeUndefined();
    expect(forwarded?.headers.origin).toBeUndefined();
  });

  it("refuses an outer request carrying Origin before anything reaches the inner", async () => {
    const inner = await syntheticInner("two-phase");
    const outer = await outerEndpoint({ target: inner.target });

    const response = await fetch(outer.url(FAROL_MODEL_RESPONSES_PATH), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${outer.token}`,
        origin: "https://evil.test",
      },
      body: JSON.stringify(turnBody()),
    });

    expect(response.status).toBe(403);
    expect(inner.requests.filter((r) => r.method === "POST")).toHaveLength(0);
  });
});

/** An inner that answers one unary compaction with an exact status/body. */
async function refusingCompactionInner(
  status: number,
  body: unknown,
): Promise<SyntheticInner> {
  const requests: InnerRequest[] = [];
  const server = http.createServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (raw += chunk));
    request.on("end", () => {
      requests.push({
        method: request.method ?? "",
        url: request.url ?? "",
        headers: Object.fromEntries(
          Object.entries(request.headers).map(([key, value]) => [
            key,
            Array.isArray(value) ? value.join(",") : (value ?? ""),
          ]),
        ),
        body: raw,
      });
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const port = (server.address() as { port: number }).port;
  return {
    target: { baseUrl: `http://127.0.0.1:${port}`, token: INNER_TOKEN },
    requests,
    firstFrameFlushed: Promise.resolve(),
    release: () => undefined,
  };
}

describe("Farol Model bridge parity with Route B: compaction route", () => {
  async function compact(
    outer: OuterEndpoint,
    body: unknown,
    metadataHeader?: string,
  ): Promise<Response> {
    return fetch(outer.url(COMPACT_PATH), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${outer.token}`,
        ...(metadataHeader === undefined
          ? {}
          : { [METADATA_HEADER]: metadataHeader }),
      },
      body: JSON.stringify(body),
    });
  }

  const compacted = {
    output: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Validated compact context" }],
      },
    ],
  };

  it("accepts header-only compaction identity", async () => {
    const outer = await outerEndpoint({ target: await realInner() });

    const response = await compact(
      outer,
      { model: MODEL, input: compactionHistory() },
      compactionMetadata(),
    );

    expect(response.status).toBe(200);
    // Unary JSON, relayed verbatim -- not an SSE stream.
    await expect(response.json()).resolves.toEqual(compacted);
  });

  it("accepts embedded-only compaction identity", async () => {
    const outer = await outerEndpoint({ target: await realInner() });

    const response = await compact(outer, {
      model: MODEL,
      input: compactionHistory(),
      client_metadata: { [METADATA_HEADER]: compactionMetadata() },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(compacted);
  });

  it("accepts a header and an embedded identity that agree", async () => {
    const outer = await outerEndpoint({ target: await realInner() });

    const response = await compact(
      outer,
      {
        model: MODEL,
        input: compactionHistory(),
        client_metadata: { [METADATA_HEADER]: compactionMetadata() },
      },
      compactionMetadata(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(compacted);
  });

  // Measured before these rows were written, against the real provider with
  // its summary-only compaction port attached: `/v1/responses/compact`
  // answered 200 for every identity shape -- header-only, embedded-only,
  // both agreeing, header and embedded disagreeing on turn_id or thread_id,
  // an unparseable header, and no identity at all. The 422 identity codes in
  // `modules/chat/infra/client/host-compaction-codec.ts`
  // (HOST_COMPACTION_IDENTITY_MISSING / _INVALID / _MISMATCH) were therefore
  // NOT reachable through this fixture, so a row asserting them here would
  // pin an expectation the product does not currently hold. Where that
  // validation runs for a real host is recorded as the open question below.
  //
  // What the outer bridge owns regardless is that it decides nothing: an
  // inner refusal must arrive unchanged, which a synthetic inner can state
  // exactly.
  it("relays an inner compaction refusal verbatim instead of deciding itself", async () => {
    const refusal = { error: { code: "HOST_COMPACTION_IDENTITY_MISMATCH" } };
    const inner = await refusingCompactionInner(422, refusal);
    const outer = await outerEndpoint({ target: inner.target });

    const response = await compact(
      outer,
      {
        model: MODEL,
        input: compactionHistory(),
        client_metadata: {
          [METADATA_HEADER]: compactionMetadata("turn-compact-2"),
        },
      },
      compactionMetadata("turn-compact-1"),
    );

    // The inner's own status and body, not a code the bridge invented.
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual(refusal);
    // Both identities crossed the boundary, so the inner could compare them.
    const forwarded = inner.requests.at(-1);
    expect(forwarded?.headers[METADATA_HEADER]).toBe(
      compactionMetadata("turn-compact-1"),
    );
    expect(forwarded?.body).toContain("turn-compact-2");
  });

  it("carries a compaction that declares no identity to the inner unchanged", async () => {
    const inner = await refusingCompactionInner(200, { output: [] });
    const outer = await outerEndpoint({ target: inner.target });

    const response = await compact(outer, {
      model: MODEL,
      input: compactionHistory(),
    });

    // Whatever the inner makes of a missing identity is the inner's call;
    // the bridge must neither supply one nor refuse on its behalf.
    expect(response.status).toBe(200);
    const forwarded = inner.requests.at(-1);
    expect(forwarded?.headers[METADATA_HEADER]).toBeUndefined();
    expect(forwarded?.body).not.toContain(METADATA_HEADER);
  });

  // Open question for whoever owns the compaction contract next, recorded
  // with its evidence rather than guessed: the identity rules in
  // host-compaction-codec.ts refuse a header/embedded disagreement, and the
  // provider's compaction path reads a metadata header, yet the running
  // provider accepted every shape above. Establish which host requests that
  // validation actually governs before asserting a parity matrix on it.
  it.todo(
    "refuses a header/embedded identity disagreement through the real production compaction port — TRACED (root, 2026-09-21): the identity refusals HOST_COMPACTION_IDENTITY_{MISSING,INVALID,MISMATCH} are produced by parseHostCompactionRequest, which the PRODUCTION port reaches via route-b-runtime.ts::admittedCompaction(inner) → codex-context-continuity.ts::CodexContextContinuity.compact (parseHostCompactionRequest(endpoint, body, input.metadataHeader)); the summary-only `compaction: { compact }` stub this fixture hands the provider is what bypassed them, not the bridge. The bridge forwards x-codex-turn-metadata so that validator sees the header. A real-path row needs CodexContextContinuity with its disposable state; left for Codex with this trace.",
  );

  it("serves the compaction route only for the model this endpoint carries", async () => {
    const outer = await outerEndpoint({ target: await realInner() });

    const response = await compact(
      outer,
      { model: "some-other/model", input: compactionHistory() },
      compactionMetadata(),
    );

    expect(response.status).toBe(422);
  });
});
