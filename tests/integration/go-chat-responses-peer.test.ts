import { describe, expect, it, vi } from "vitest";
import { GoChatBrowserDriver } from "../../apps/desktop/go-chat-browser.ts";
import type {
  ChatGptPhysicalApi,
  PhysicalBinding,
} from "../../apps/desktop/chatgpt-physical-api.ts";
import { startGoChatResponsesFixture } from "./fixtures/go-chat-responses-process.ts";
import {
  validate,
  type BrowserNextResult,
  type BrowserPrepare,
  type Json,
} from "../../apps/desktop/bridge/wire.ts";

// Actual common framing and production Chat services. The physical browser and
// journal are controlled doubles; this does not qualify Electron or a provider.
describe("controlled real-Go Chat peer", () => {
  it("delivers the first reciprocal Prepare through the strict TypeScript client", async () => {
    const peer = await startGoChatResponsesFixture("reciprocal");
    let preparing: Promise<unknown> | undefined;
    try {
      const handle = await peer.chat.create({
        sessionId: "controlled-reciprocal-session",
        prompt: "Controlled browser transport question",
        selection: peer.selection,
        resolution: peer.resolution,
        required: peer.required,
      });
      const deadline = String(Date.now() + 3000);
      const next = peer.client.request(
        "chat.browser.next",
        { deadlineMillis: deadline },
        { timeoutMs: 4000 },
      );
      preparing = peer.chat.prepare(deadline).catch((error: unknown) => error);
      const outcome = await next;
      expect(outcome.status).toBe("ok");
      expect(validate("BrowserNextResult", outcome.data)).toBe(true);
      const command = (outcome.data as unknown as BrowserNextResult).command!;
      expect(command.kind).toBe("prepare");
      expect(validate("BrowserPrepare", command.body)).toBe(true);
      const input = command.body as unknown as BrowserPrepare;
      const home: PhysicalBinding = {
        phase: "home",
        conversationId: null,
        url: "https://chatgpt.com/",
        viewId: "controlled-view",
        viewGeneration: 1,
        documentGeneration: 1,
        partition: "persist:farol-app-chatgpt",
      };
      const forbidden = async (): Promise<never> => {
        throw new Error("unexpected physical action");
      };
      const api: ChatGptPhysicalApi = {
        prepare: vi.fn<ChatGptPhysicalApi["prepare"]>(
          async (_request, guard) => {
            expect(guard(home)).toBe(true);
            return { state: "prepared", binding: home, readiness: "ready" };
          },
        ),
        verifySend: forbidden,
        send: forbidden,
        observe: forbidden,
        cancel: forbidden,
        dispose: forbidden,
      };
      const driver = new GoChatBrowserDriver({
        lookup: (lease) => ({ lease, api, partition: home.partition }),
        translations: [
          {
            version: "public-controls-v1",
            configSHA256: peer.resolution.configSHA256,
            translationId: peer.resolution.translationId,
            model: [{ value: "controlled-model", literal: "Test model" }],
            effort: [{ value: "low", literal: "Light" }],
            mode: [{ value: "standard", literal: "standard" }],
            connector: [],
          },
        ],
      });
      const preparedReply = await driver.prepare(input);
      const reply = await peer.client.request(
        "chat.browser.reply",
        {
          commandId: command.commandId,
          kind: command.kind,
          body: preparedReply as unknown as Json,
        },
        { operationId: command.commandId, timeoutMs: 3000 },
      );
      expect(reply.status).toBe("ok");
      expect(await preparing).toMatchObject({ handle });
      expect(api.prepare).toHaveBeenCalledTimes(1);
    } finally {
      const receipt = await peer.close();
      await preparing;
      expect(receipt.physicalSendAttempts).toBe(0);
    }
  });
  for (const scenario of ["text", "lost-send-reply"] as const) {
    it(`${scenario}: preserves Send meaning across the real typed bridge`, async () => {
      const peer = await startGoChatResponsesFixture(scenario);
      try {
        const handle = await peer.chat.create({
          sessionId: "controlled-http-session",
          prompt: "Controlled transport question",
          selection: peer.selection,
          resolution: peer.resolution,
          required: peer.required,
        });
        const deadline = String(Date.now() + 10000);
        const prepared = await peer.chat.prepare(deadline);
        expect(prepared.handle).toEqual(handle);
        await peer.chat.send(handle.handleId, deadline);
        if (scenario === "text") {
          await peer.chat.observe(handle.handleId, deadline);
          await peer.chat.observe(handle.handleId, deadline);
          const { frames } = await peer.chat.events(handle.handleId, "0");
          expect(
            frames.some(
              (frame) =>
                frame.kind === "response.output_text.delta" &&
                JSON.stringify(frame.data).includes("Useful before tool."),
            ),
          ).toBe(true);
          expect(
            frames.some((frame) => frame.kind === "response.completed"),
          ).toBe(false);
        } else {
          const { frames } = await peer.chat.events(handle.handleId, "0");
          expect(frames.some((frame) => frame.kind === "response.failed")).toBe(
            true,
          );
          expect(
            frames.some((frame) => frame.kind === "response.completed"),
          ).toBe(false);
          expect((await peer.chat.submission(handle)).state).toBe("unknown");
        }
      } finally {
        const receipt = await peer.close();
        expect(receipt.serverEOF).toBe(true);
        expect(receipt.physicalSendAttempts).toBe(1);
        expect(receipt.acceptedSubmissions).toBe(1);
        expect(receipt.methods["chat.conversation.create"]).toEqual({
          attempts: 1,
          known: 1,
        });
        expect(receipt.methods["chat.conversation.send"]).toEqual({
          attempts: 1,
          known: 1,
        });
        expect(receipt.commits.dispatch).toBe(1);
        if (scenario === "lost-send-reply")
          expect(receipt.observations).toBe(0);
      }
    });
  }
});
