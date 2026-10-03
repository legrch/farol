import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { startChatGptFixture, stopChatGptFixture } from "./chatgpt-site.mjs";

// Fixture protocol tests over owned loopback HTTP, not assembled-product E2E,
// browser rendering, Go persistence, parent ACK or process-tree containment.
const sites = [];
afterEach(async () => {
  await Promise.all(sites.splice(0).map(stopChatGptFixture));
});
const scenario = () => ({
  conversationId: "fixture-conversation",
  selection: {
    model: "Test model",
    effort: "Light",
    connector: { id: "plugin_asdk_app_TEST", label: "Farol DEV" },
  },
  turns: [
    {
      userId: "user-1",
      replyId: "reply-1",
      prompt: "Remember pear.",
      segments: [
        { id: "segment-1", text: "Useful partial 😺 " },
        { id: "segment-2", text: "FUTURE_FINAL_CANARY" },
      ],
    },
    {
      userId: "user-2",
      replyId: "reply-2",
      prompt: "Return pear.",
      segments: [{ id: "segment-3", text: "pear" }],
    },
  ],
});
async function site(config = scenario()) {
  const fixture = await startChatGptFixture({ controlledScenario: config });
  sites.push(fixture);
  return fixture;
}
async function open(fixture) {
  const response = await fetch(fixture.url);
  const html = await response.text();
  assert.equal(response.status, 200);
  return {
    html,
    documentId: /data-document-id="([^"]+)"/u.exec(html)[1],
    documentGeneration: Number(
      /data-document-generation="([^"]+)"/u.exec(html)[1],
    ),
    conversationId: /data-conversation-id="([^"]+)"/u.exec(html)[1],
  };
}
async function post(fixture, page, path, value, origin = fixture.origin) {
  const { documentId, documentGeneration, conversationId } = page;
  return fetch(`${fixture.origin}/fixtures/chatgpt/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({
      documentId,
      documentGeneration,
      conversationId,
      ...value,
    }),
  });
}
async function send(fixture, page, config, index = 0, overrides = {}) {
  const prior = config.turns[index - 1];
  return post(fixture, page, "send", {
    message: config.turns[index].prompt,
    selection: config.selection,
    previousUserId: prior?.userId ?? null,
    previousReplyId: prior?.replyId ?? null,
    ...overrides,
  });
}
const query = (page) =>
  new URLSearchParams({
    documentId: page.documentId,
    documentGeneration: String(page.documentGeneration),
    conversationId: page.conversationId,
  });
async function state(fixture, page) {
  const response = await fetch(
    `${fixture.origin}/fixtures/chatgpt/state?${query(page)}`,
  );
  assert.equal(response.status, 200);
  return response.json();
}
function counts(fixture, attempted, accepted) {
  const snapshot = fixture.driver.snapshot();
  assert.deepEqual(
    { attempted: snapshot.attemptedSends, accepted: snapshot.acceptedSends },
    { attempted, accepted },
  );
}
function finish(fixture, config, index = 0) {
  const turn = config.turns[index];
  fixture.driver.releaseGeneration(turn.replyId, turn.segments.length);
  fixture.driver.releaseTerminal(turn.replyId);
  fixture.driver.releaseRender(turn.replyId, turn.segments.length);
}

describe("controlled ChatGPT fixture protocol and independent submission ledger", () => {
  it("keeps unreleased future output off the page, ordinary endpoints and reload storage", async () => {
    const config = scenario();
    const fixture = await site(config);
    let page = await open(fixture);
    expect(page.html).not.toContain("FUTURE_FINAL_CANARY");
    const client = await (
      await fetch(`${fixture.origin}/fixtures/chatgpt/client.mjs`)
    ).text();
    expect(client).not.toMatch(
      /localStorage|FUTURE_FINAL_CANARY|releaseGeneration|driver\.snapshot/u,
    );
    expect((await send(fixture, page, config)).status).toBe(200);
    expect((await state(fixture, page)).turns[0].segments).toEqual([]);
    expect(() => fixture.driver.releaseRender("reply-1", 1)).toThrow(
      "FIXTURE_RENDER_BARRIER_INVALID",
    );
    fixture.driver.releaseGeneration("reply-1", 1);
    fixture.driver.releaseRender("reply-1", 1);
    expect(() => fixture.driver.releaseTerminal("reply-1")).toThrow(
      "FIXTURE_FINAL_NOT_GENERATED",
    );
    const partial = await state(fixture, page);
    expect(partial.turns[0]).toMatchObject({
      segments: [config.turns[0].segments[0]],
      providerTerminal: false,
      generationWatermark: 1,
    });
    page = await open(fixture);
    const recovered = await state(fixture, page);
    expect(JSON.stringify(recovered)).not.toContain("FUTURE_FINAL_CANARY");
    expect(recovered.turns[0].segments).toEqual([config.turns[0].segments[0]]);
    counts(fixture, 1, 1);
  });

  it("transports useful partial text over an actual SSE socket while the final barrier is held", async () => {
    const config = scenario();
    const fixture = await site(config);
    const page = await open(fixture);
    await send(fixture, page, config);
    const controller = new AbortController();
    const response = await fetch(
      `${fixture.origin}/fixtures/chatgpt/events?${query(page)}`,
      { signal: controller.signal },
    );
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const next = async () => {
      while (!buffer.includes("\n\n")) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false);
        buffer += decoder.decode(chunk.value, { stream: true });
      }
      const boundary = buffer.indexOf("\n\n");
      const event = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      return JSON.parse(
        event
          .split("\n")
          .find((line) => line.startsWith("data: "))
          .slice(6),
      );
    };
    try {
      expect((await next()).turns[0].segments).toEqual([]);
      fixture.driver.releaseGeneration("reply-1", 1);
      await next();
      fixture.driver.releaseRender("reply-1", 1);
      const useful = await next();
      expect(useful.turns[0].segments[0].text).toBe("Useful partial 😺 ");
      expect(useful.turns[0].providerTerminal).toBe(false);
      expect(JSON.stringify(useful)).not.toContain("FUTURE_FINAL_CANARY");
      finish(fixture, config);
    } finally {
      controller.abort();
      await reader.cancel().catch(() => {});
    }
    counts(fixture, 1, 1);
  });

  it("separates generated, render-released and page-render-receipt watermarks", async () => {
    const config = scenario();
    const fixture = await site(config);
    let page = await open(fixture);
    await send(fixture, page, config);
    fixture.driver.releaseGeneration("reply-1", 2);
    fixture.driver.releaseTerminal("reply-1");
    page = await open(fixture);
    const delayed = await state(fixture, page);
    expect(delayed.turns[0]).toMatchObject({
      providerTerminal: true,
      renderedTerminal: false,
      generationWatermark: 2,
      segments: [],
    });
    expect(
      (
        await post(fixture, page, "rendered", {
          replyId: "reply-1",
          segmentIds: ["segment-1"],
        })
      ).status,
    ).toBe(409);
    fixture.driver.releaseRender("reply-1", 2);
    expect((await state(fixture, page)).turns[0].segments).toEqual(
      config.turns[0].segments,
    );
    expect(fixture.driver.snapshot().turns[0].browserRendered).toEqual([]);
    expect(
      (
        await post(fixture, page, "rendered", {
          replyId: "reply-1",
          segmentIds: ["segment-1", "segment-2"],
        })
      ).status,
    ).toBe(200);
    expect(fixture.driver.snapshot().turns[0].browserRendered).toEqual([
      { documentId: page.documentId, watermark: 2 },
    ]);
    counts(fixture, 1, 1);
  });

  it("accepts the second turn only on the same conversation and exact previous IDs with pinned selection", async () => {
    const config = scenario();
    const fixture = await site(config);
    const page = await open(fixture);
    const first = await (await send(fixture, page, config)).json();
    finish(fixture, config);
    fixture.driver.setSelection({ ...config.selection, connector: null });
    expect((await send(fixture, page, config, 1)).status).toBe(409);
    counts(fixture, 2, 1);
    fixture.driver.setSelection(config.selection);
    const second = await (await send(fixture, page, config, 1)).json();
    expect(first.conversationId).toBe(second.conversationId);
    expect(second).toMatchObject({ userId: "user-2", replyId: "reply-2" });
    expect(first.userId).not.toBe(second.userId);
    expect(first.replyId).not.toBe(second.replyId);
    finish(fixture, config, 1);
    counts(fixture, 3, 2);
  });

  it("loses Send ACK after acceptance and recovers available state with no additional submission", async () => {
    const config = scenario();
    const fixture = await site(config);
    const page = await open(fixture);
    fixture.driver.loseNextSendAcknowledgement();
    await expect(send(fixture, page, config)).rejects.toThrow();
    counts(fixture, 1, 1);
    expect(fixture.driver.snapshot().ledger[0]).toMatchObject({
      accepted: true,
      acknowledgement: "lost",
      userId: "user-1",
    });
    fixture.driver.releaseGeneration("reply-1", 1);
    fixture.driver.releaseRender("reply-1", 1);
    const reopened = await open(fixture);
    expect((await state(fixture, reopened)).turns[0].segments).toEqual([
      config.turns[0].segments[0],
    ]);
    counts(fixture, 1, 1);
  });

  it("detects a broken client that makes another accepted Send after lost ACK", async () => {
    const config = scenario();
    config.turns[1].prompt = config.turns[0].prompt;
    const fixture = await site(config);
    const page = await open(fixture);
    fixture.driver.loseNextSendAcknowledgement();
    await expect(send(fixture, page, config)).rejects.toThrow();
    finish(fixture, config);
    expect((await send(fixture, page, config, 1)).status).toBe(200);
    expect(() => counts(fixture, 1, 1)).toThrow();
    counts(fixture, 2, 2);
  });

  it("records and rejects stale document, dropped field, foreign origin and incorrect previous identity", async () => {
    const config = scenario();
    const fixture = await site(config);
    const old = await open(fixture);
    const page = await open(fixture);
    expect((await send(fixture, old, config)).status).toBe(409);
    expect(
      (await post(fixture, page, "send", { message: "Remember pear." })).status,
    ).toBe(400);
    expect(
      (await send(fixture, page, config, 0, { previousUserId: "foreign" }))
        .status,
    ).toBe(409);
    expect(
      (await post(fixture, page, "send", {}, "https://example.invalid")).status,
    ).toBe(403);
    const missing = await fetch(`${fixture.origin}/fixtures/chatgpt/oracle`);
    expect(missing.status).toBe(404);
    counts(fixture, 4, 0);
    expect(fixture.driver.snapshot().ledger.map((entry) => entry.code)).toEqual(
      [
        "stale-document",
        "invalid-send",
        "previous-identity-mismatch",
        "foreign-origin",
      ],
    );
  });
  it("decodes fragmented UTF-8 Send bytes without rewriting the prompt", async () => {
    const config = scenario();
    config.turns[0].prompt = "Remember 😺.";
    const fixture = await site(config);
    const page = await open(fixture);
    const bytes = Buffer.from(
      JSON.stringify({
        documentId: page.documentId,
        documentGeneration: page.documentGeneration,
        conversationId: page.conversationId,
        message: config.turns[0].prompt,
        selection: config.selection,
        previousUserId: null,
        previousReplyId: null,
      }),
    );
    const status = await new Promise((resolve, reject) => {
      const request = httpRequest(
        `${fixture.origin}/fixtures/chatgpt/send`,
        {
          method: "POST",
          headers: {
            origin: fixture.origin,
            "content-type": "application/json",
          },
        },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode));
        },
      );
      request.on("error", reject);
      for (const byte of bytes) request.write(Buffer.from([byte]));
      request.end();
    });
    expect(status).toBe(200);
    counts(fixture, 1, 1);
  });

  it("compares literal selection fields independently of JSON property order", async () => {
    const config = scenario();
    const fixture = await site(config);
    const page = await open(fixture);
    expect(
      (
        await send(fixture, page, config, 0, {
          selection: {
            connector: config.selection.connector,
            effort: config.selection.effort,
            model: config.selection.model,
          },
        })
      ).status,
    ).toBe(200);
    counts(fixture, 1, 1);
  });
});

describe("legacy fixture extraction compatibility", () => {
  it("retains login, overlay, attachment, context summary, saved history, popup and Next scenarios", async () => {
    const fixture = await startChatGptFixture();
    sites.push(fixture);
    const response = await fetch(`${fixture.url}?cover=1`);
    const html = await response.text();
    expect(response.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    for (const marker of [
      "e2e-cover-overlay",
      "attachment-input",
      "__farolSubmitCount",
      "__farolTaskProgress",
      "Preserve the current task context",
      "farol-next-e2e-conversation:",
    ])
      expect(html).toContain(marker);
    const origin = new URL(fixture.url).origin;
    expect(await (await fetch(`${origin}/chatgpt-popup`)).text()).toContain(
      "popup-ready",
    );
    expect(await (await fetch(`${origin}/chatgpt-next`)).text()).toContain(
      "next-page-ready",
    );
    expect((await fetch(`${origin}/undeclared`)).status).toBe(404);
  });
});
