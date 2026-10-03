import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

// Test-only provider double. Future scripted output stays in this closure;
// public responses contain only explicitly generated AND render-released text.
const text = (value) =>
  typeof value === "string" && value.length > 0 && value.length <= 65536;
const id = (value) =>
  typeof value === "string" && /^[A-Za-z0-9-]{1,128}$/u.test(value);
const fields = (value, keys) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const selectionValid = (value) =>
  fields(value, ["model", "effort", "connector"]) &&
  text(value.model) &&
  text(value.effort) &&
  (value.connector === null ||
    (fields(value.connector, ["id", "label"]) &&
      text(value.connector.id) &&
      text(value.connector.label)));
const sameSelection = (left, right) =>
  left.model === right.model &&
  left.effort === right.effort &&
  (left.connector === null
    ? right.connector === null
    : right.connector !== null &&
      left.connector.id === right.connector.id &&
      left.connector.label === right.connector.label);
const clone = (value) => structuredClone(value);
const escape = (value) =>
  String(value).replace(
    /[&<>"']/gu,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character],
  );

export async function startControlledChatGptSite(candidate) {
  assert.ok(
    fields(candidate, ["conversationId", "selection", "turns"]),
    "FIXTURE_SCENARIO_INVALID",
  );
  assert.ok(
    id(candidate.conversationId) && candidate.conversationId.length >= 8,
    "FIXTURE_CONVERSATION_INVALID",
  );
  assert.ok(selectionValid(candidate.selection), "FIXTURE_SELECTION_INVALID");
  assert.ok(
    Array.isArray(candidate.turns) &&
      candidate.turns.length > 0 &&
      candidate.turns.length <= 8,
    "FIXTURE_TURNS_INVALID",
  );
  for (const turn of candidate.turns) {
    assert.ok(
      fields(turn, ["userId", "replyId", "prompt", "segments"]) &&
        id(turn.userId) &&
        id(turn.replyId) &&
        text(turn.prompt),
      "FIXTURE_TURN_INVALID",
    );
    assert.ok(
      Array.isArray(turn.segments) &&
        turn.segments.length > 0 &&
        turn.segments.length <= 16,
      "FIXTURE_SEGMENTS_INVALID",
    );
    assert.ok(
      turn.segments.every(
        (segment) =>
          fields(segment, ["id", "text"]) &&
          id(segment.id) &&
          text(segment.text),
      ),
      "FIXTURE_SEGMENT_INVALID",
    );
  }
  const scenario = clone(candidate);
  const identities = scenario.turns.flatMap((turn) => [
    turn.userId,
    turn.replyId,
    ...turn.segments.map((segment) => segment.id),
  ]);
  assert.equal(
    new Set(identities).size,
    identities.length,
    "FIXTURE_DUPLICATE_ID",
  );
  const client = await readFile(
    new URL("./chatgpt-controlled-client.mjs", import.meta.url),
  );
  const conversationPath = `/chatgpt/c/${scenario.conversationId}`;
  const ledger = [];
  const accepted = [];
  const eventResponses = new Set();
  let selected = clone(scenario.selection);
  let documentGeneration = 0;
  let currentDocument = null;
  let origin = null;
  let loseNextAck = false;
  let closed = false;

  const projection = () => ({
    conversationId: scenario.conversationId,
    documentGeneration,
    selection: clone(selected),
    turns: accepted.map((turn) => ({
      userId: turn.userId,
      replyId: turn.replyId,
      prompt: turn.prompt,
      segments: clone(turn.generated.slice(0, turn.renderReleased)),
      generationWatermark: turn.generated.length,
      renderReleasedWatermark: turn.renderReleased,
      providerTerminal: turn.terminal,
      renderedTerminal:
        turn.terminal && turn.renderReleased === turn.generated.length,
      cancelRequested: turn.cancelRequested,
    })),
  });
  const publish = () => {
    const data = `event: state\ndata: ${JSON.stringify(projection())}\n\n`;
    for (const response of eventResponses) response.write(data);
  };
  const json = (response, status, value) => {
    response.writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    response.end(JSON.stringify(value));
  };
  const body = async (request) => {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      assert.ok(size <= 131072, "FIXTURE_BODY_TOO_LARGE");
      chunks.push(chunk);
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
  };
  const current = (value) =>
    currentDocument !== null &&
    value.documentId === currentDocument.id &&
    value.documentGeneration === currentDocument.generation &&
    value.conversationId === scenario.conversationId;
  const publicHeaders = {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy":
      "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'",
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", origin);
    const sendAttempt =
      request.method === "POST" && url.pathname === "/fixtures/chatgpt/send";
    const entry = sendAttempt
      ? { attempt: ledger.length + 1, accepted: false, code: "invalid-request" }
      : null;
    if (entry) ledger.push(entry);
    const reject = (status, code) => {
      if (entry) entry.code = code;
      json(response, status, { accepted: false, code });
    };
    if (
      request.headers.host !== new URL(origin).host ||
      url.origin !== origin ||
      (request.headers.origin !== undefined &&
        request.headers.origin !== origin)
    ) {
      reject(403, "foreign-origin");
      return;
    }
    try {
      if (
        request.method === "GET" &&
        (url.pathname === "/chatgpt" || url.pathname === conversationPath)
      ) {
        documentGeneration += 1;
        currentDocument = { id: randomUUID(), generation: documentGeneration };
        for (const old of eventResponses) old.end();
        eventResponses.clear();
        response.writeHead(200, publicHeaders);
        response.end(`<!doctype html><html><head><meta charset="utf-8"><title>Controlled provider fixture</title>
          <style>body{font:16px sans-serif}button,#prompt-textarea{min-width:120px;min-height:36px}.markdown{white-space:pre-wrap}</style></head>
          <body data-conversation-id="${escape(scenario.conversationId)}" data-document-id="${currentDocument.id}" data-document-generation="${documentGeneration}">
          <button aria-label="Select ChatGPT model">${escape(selected.model)}</button>
          <form><div id="prompt-textarea" contenteditable="true" data-virtualkeyboard="true" aria-label="Message"></div>
          <button type="button" aria-haspopup="menu" data-tone="neutral">${escape(selected.effort)}</button>
          <span data-testid="composer-app-chip" ${selected.connector ? `data-plugin-id="${escape(selected.connector.id)}" data-app-name="${escape(selected.connector.label)}"` : "hidden"}>${escape(selected.connector?.label ?? "")}</span>
          <button data-testid="send-button" type="button" disabled>Send</button><button data-testid="stop-button" type="button" hidden>Stop</button></form>
          <p data-testid="network-error" hidden>Submission acknowledgement unavailable</p><section id="conversation"></section>
          <script type="module" src="/fixtures/chatgpt/client.mjs"></script></body></html>`);
        return;
      }
      if (
        request.method === "GET" &&
        url.pathname === "/fixtures/chatgpt/client.mjs"
      ) {
        response.writeHead(200, {
          "content-type": "text/javascript",
          "cache-control": "no-store",
        });
        response.end(client);
        return;
      }
      if (
        request.method === "GET" &&
        ["/fixtures/chatgpt/state", "/fixtures/chatgpt/events"].includes(
          url.pathname,
        )
      ) {
        const identity = {
          documentId: url.searchParams.get("documentId"),
          documentGeneration: Number(
            url.searchParams.get("documentGeneration"),
          ),
          conversationId: url.searchParams.get("conversationId"),
        };
        if (!current(identity)) {
          reject(409, "stale-document");
          return;
        }
        if (url.pathname.endsWith("/state")) {
          json(response, 200, projection());
          return;
        }
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          connection: "keep-alive",
        });
        response.flushHeaders();
        eventResponses.add(response);
        response.on("close", () => eventResponses.delete(response));
        response.write(
          `event: state\ndata: ${JSON.stringify(projection())}\n\n`,
        );
        return;
      }
      if (
        request.method !== "POST" ||
        ![
          "/fixtures/chatgpt/send",
          "/fixtures/chatgpt/rendered",
          "/fixtures/chatgpt/stop",
        ].includes(url.pathname)
      ) {
        reject(404, "not-found");
        return;
      }
      if (request.headers.origin !== origin) {
        reject(403, "origin-required");
        return;
      }
      const input = await body(request);
      if (!current(input)) {
        reject(409, "stale-document");
        return;
      }
      if (sendAttempt) {
        if (
          !fields(input, [
            "documentId",
            "documentGeneration",
            "conversationId",
            "message",
            "selection",
            "previousUserId",
            "previousReplyId",
          ]) ||
          !text(input.message) ||
          !selectionValid(input.selection)
        ) {
          reject(400, "invalid-send");
          return;
        }
        if (
          !sameSelection(input.selection, scenario.selection) ||
          !sameSelection(selected, scenario.selection)
        ) {
          reject(409, "selection-mismatch");
          return;
        }
        const previous = accepted.at(-1);
        if (previous && !previous.terminal) {
          reject(409, "busy");
          return;
        }
        if (
          input.previousUserId !== (previous?.userId ?? null) ||
          input.previousReplyId !== (previous?.replyId ?? null)
        ) {
          reject(409, "previous-identity-mismatch");
          return;
        }
        const script = scenario.turns[accepted.length];
        if (!script || input.message !== script.prompt) {
          reject(409, "unexpected-message");
          return;
        }
        const turn = {
          userId: script.userId,
          replyId: script.replyId,
          prompt: input.message,
          generated: [],
          renderReleased: 0,
          terminal: false,
          cancelRequested: false,
          renderedByDocument: new Map(),
        };
        accepted.push(turn);
        Object.assign(entry, {
          accepted: true,
          code: "accepted",
          conversationId: input.conversationId,
          documentGeneration: input.documentGeneration,
          userId: turn.userId,
          replyId: turn.replyId,
        });
        publish();
        if (loseNextAck) {
          loseNextAck = false;
          entry.acknowledgement = "lost";
          response.destroy();
          return;
        }
        entry.acknowledgement = "delivered";
        json(response, 200, {
          accepted: true,
          conversationId: scenario.conversationId,
          userId: turn.userId,
          replyId: turn.replyId,
        });
        return;
      }
      const turn = accepted.find((item) => item.replyId === input.replyId);
      if (!turn) {
        reject(409, "reply-unavailable");
        return;
      }
      if (url.pathname.endsWith("/stop")) {
        turn.cancelRequested = true;
        publish();
        json(response, 200, { requested: true });
        return;
      }
      const ids = turn.generated
        .slice(0, turn.renderReleased)
        .map((segment) => segment.id);
      if (
        !Array.isArray(input.segmentIds) ||
        input.segmentIds.length > ids.length ||
        input.segmentIds.some((value, index) => value !== ids[index])
      ) {
        reject(409, "render-ahead");
        return;
      }
      const old = turn.renderedByDocument.get(input.documentId) ?? 0;
      if (input.segmentIds.length < old) {
        reject(409, "render-regression");
        return;
      }
      turn.renderedByDocument.set(input.documentId, input.segmentIds.length);
      json(response, 200, { recorded: true });
    } catch {
      reject(400, "invalid-request");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  origin = `http://127.0.0.1:${address.port}`;
  const ownedTurn = (replyId) => {
    assert.equal(closed, false, "FIXTURE_CLOSED");
    const index = accepted.findIndex((turn) => turn.replyId === replyId);
    assert.ok(index >= 0, "FIXTURE_REPLY_UNAVAILABLE");
    return { turn: accepted[index], script: scenario.turns[index] };
  };
  const driver = Object.freeze({
    loseNextSendAcknowledgement() {
      loseNextAck = true;
    },
    releaseGeneration(replyId, count) {
      const { turn, script } = ownedTurn(replyId);
      assert.ok(
        !turn.terminal &&
          Number.isSafeInteger(count) &&
          count >= turn.generated.length &&
          count <= script.segments.length,
        "FIXTURE_GENERATION_BARRIER_INVALID",
      );
      turn.generated = clone(script.segments.slice(0, count));
      publish();
    },
    releaseRender(replyId, count) {
      const { turn } = ownedTurn(replyId);
      assert.ok(
        Number.isSafeInteger(count) &&
          count >= turn.renderReleased &&
          count <= turn.generated.length,
        "FIXTURE_RENDER_BARRIER_INVALID",
      );
      turn.renderReleased = count;
      publish();
    },
    releaseTerminal(replyId) {
      const { turn, script } = ownedTurn(replyId);
      assert.equal(
        turn.generated.length,
        script.segments.length,
        "FIXTURE_FINAL_NOT_GENERATED",
      );
      turn.terminal = true;
      publish();
    },
    setSelection(value) {
      assert.ok(selectionValid(value), "FIXTURE_SELECTION_INVALID");
      selected = clone(value);
      publish();
    },
    snapshot() {
      return clone({
        attemptedSends: ledger.length,
        acceptedSends: ledger.filter((entry) => entry.accepted).length,
        ledger,
        turns: accepted.map((turn) => ({
          userId: turn.userId,
          replyId: turn.replyId,
          generationWatermark: turn.generated.length,
          renderReleasedWatermark: turn.renderReleased,
          providerTerminal: turn.terminal,
          browserRendered: [...turn.renderedByDocument].map(
            ([documentId, watermark]) => ({ documentId, watermark }),
          ),
        })),
      });
    },
  });
  return {
    server,
    url: `${origin}/chatgpt`,
    origin,
    driver,
    async close() {
      if (closed) return;
      closed = true;
      for (const response of eventResponses) response.end();
      eventResponses.clear();
      const done = new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      server.closeAllConnections();
      await done;
    },
  };
}
