import { describe, expect, it } from "vitest";
import { startGoChatResponsesFixture } from "./fixtures/go-chat-responses-process.ts";

// Actual common framing and production Chat services. The physical browser and
// journal are controlled doubles; this does not qualify Electron or a provider.
describe("controlled real-Go Chat peer", () => {
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
