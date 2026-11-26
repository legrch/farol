import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import type { VisibleOutputItem } from "../../../src/apps/desktop/chatgpt-visible-output";
import { ResponseRound, type RoundToolCall } from "./round";

function fakeResponse() {
  const frames: { event: string; data: Record<string, unknown> }[] = [];
  const response = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    status: 0,
    frames,
    writeHead(status: number) {
      response.status = status;
    },
    flushHeaders() {},
    write(value: string) {
      const match = /^event: (.+)\ndata: (.+)\n\n$/u.exec(value);
      if (!match) throw new Error(`unexpected frame ${value}`);
      frames.push({
        event: match[1] as string,
        data: JSON.parse(match[2] as string) as Record<string, unknown>,
      });
      return true;
    },
    end() {
      response.writableEnded = true;
    },
  });
  return response;
}

function open() {
  const response = fakeResponse();
  const round = new ResponseRound(response as unknown as ServerResponse, "m");
  return { response, round };
}

const events = (response: ReturnType<typeof fakeResponse>) =>
  response.frames.map((frame) => frame.event);

function visible(
  channel: "answer" | "commentary" | "status",
  text: string,
): VisibleOutputItem {
  return { sequence: 1, id: `v_${text}`, channel, text };
}

const call: RoundToolCall = {
  itemId: "item_1",
  callId: "farol_call_x",
  name: "shell",
  namespace: null,
  encodedArguments: '{"cmd":"ls"}',
};

describe("provider response round", () => {
  it("opens the stream with a created response", async () => {
    const { response, round } = open();
    await round.open();
    expect(response.status).toBe(200);
    expect(events(response)).toEqual(["response.created"]);
    expect(response.frames[0]?.data).toMatchObject({
      response: { model: "m", status: "in_progress", output: [] },
    });
  });

  it("streams text deltas into one message and completes it", async () => {
    const { response, round } = open();
    await round.open();
    await round.delta("he");
    await round.delta("llo");
    await round.completeFinal();
    expect(events(response)).toEqual([
      "response.created",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);
    expect(response.writableEnded).toBe(true);
    const done = response.frames.find(
      (frame) => frame.event === "response.output_text.done",
    );
    expect(done?.data.text).toBe("hello");
  });

  it("starts a new message when the phase changes and separates visible blocks", async () => {
    const { response, round } = open();
    await round.open();
    await round.visible(visible("commentary", "a"));
    await round.visible(visible("commentary", "b"));
    await round.visible(visible("answer", "c"));
    await round.completeFinal();
    const deltas = response.frames
      .filter((frame) => frame.event === "response.output_text.delta")
      .map((frame) => frame.data.delta);
    expect(deltas).toEqual(["a", "\n\nb", "c"]);
    const added = response.frames
      .filter((frame) => frame.event === "response.output_item.added")
      .map((frame) => (frame.data.item as { phase?: string }).phase);
    expect(added).toEqual(["commentary", "final_answer"]);
  });

  it("writes a status item as a reasoning summary", async () => {
    const { response, round } = open();
    await round.open();
    await round.visible(visible("status", "thinking"));
    await round.completeFinal();
    expect(events(response)).toEqual([
      "response.created",
      "response.output_item.added",
      "response.reasoning_summary_part.added",
      "response.reasoning_summary_text.delta",
      "response.reasoning_summary_text.done",
      "response.reasoning_summary_part.done",
      "response.output_item.done",
      "response.completed",
    ]);
  });

  it("fails a final answer that produced nothing", async () => {
    const { response, round } = open();
    await round.open();
    await round.completeFinal();
    expect(events(response)).toEqual(["response.created", "response.failed"]);
    expect(response.frames[1]?.data).toMatchObject({
      response: { error: { code: "FAROL_PROVIDER_RESULT_INVALID" } },
    });
    expect(response.writableEnded).toBe(true);
  });

  it("completes a round with one issued tool call", async () => {
    const { response, round } = open();
    await round.open();
    await round.delta("working");
    await round.completeTool({ ...call, namespace: "ns" }, () => true);
    expect(events(response).slice(-6)).toEqual([
      "response.output_item.done",
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.completed",
    ]);
    const completed = response.frames.at(-1)?.data as {
      response: { output: Record<string, unknown>[] };
    };
    expect(completed.response.output).toHaveLength(2);
    expect(completed.response.output[1]).toMatchObject({
      type: "function_call",
      call_id: "farol_call_x",
      namespace: "ns",
      arguments: '{"cmd":"ls"}',
      status: "completed",
    });
    expect(response.writableEnded).toBe(true);
  });

  it("abandons a tool call as lost delivery once the round is no longer current", async () => {
    const { response, round } = open();
    await round.open();
    let current = true;
    const pending = round.completeTool(call, () => {
      const answer = current;
      current = false;
      return answer;
    });
    await expect(pending).rejects.toThrow("FAROL_HOST_DELIVERY_LOST");
    expect(events(response)).not.toContain("response.completed");
  });

  it("refuses more text after the round ended, and fails only once", async () => {
    const { response, round } = open();
    await round.open();
    await round.fail("BOOM");
    await round.fail("AGAIN");
    expect(events(response)).toEqual(["response.created", "response.failed"]);
    await expect(round.delta("x")).rejects.toThrow("FAROL_HOST_DELIVERY_LOST");
    await expect(round.visible(visible("status", "x"))).rejects.toThrow(
      "FAROL_HOST_DELIVERY_LOST",
    );
  });
});
