import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { VisibleOutputItem } from "../../../src/apps/desktop/chatgpt-visible-output";
import { startStream, writeEvent } from "./http";

// One streamed HTTP response to the host, written as the Responses event
// sequence: text and status items as the task's page shows them, then either
// one issued tool call or the final answer closes the round. It keeps the
// events well-formed and ends the response exactly once; whether the round is
// still the turn's current one is the caller's to say.

// What the round needs to announce one issued native tool call.
export type RoundToolCall = Readonly<{
  itemId: string;
  callId: string;
  name: string;
  namespace: string | null;
  encodedArguments: string;
}>;

export class ResponseRound {
  private readonly responseId = `resp_${randomUUID()}`;
  private messageId = `${this.responseId}_message`;
  private readonly output: Readonly<Record<string, unknown>>[] = [];
  private text = "";
  private textStarted = false;
  private textPhase: "commentary" | "final_answer" | null = null;
  private ended = false;

  constructor(
    private readonly response: ServerResponse,
    private readonly model: string,
  ) {}

  async open(): Promise<void> {
    startStream(this.response);
    await writeEvent(this.response, "response.created", {
      type: "response.created",
      response: {
        id: this.responseId,
        model: this.model,
        status: "in_progress",
        output: [],
      },
    });
  }

  async delta(value: string): Promise<void> {
    await this.appendText(value, null, false);
  }

  async visible(item: VisibleOutputItem): Promise<void> {
    if (this.ended) throw new Error("FAROL_HOST_DELIVERY_LOST");
    if (item.channel !== "status") {
      await this.appendText(
        item.text,
        item.channel === "answer" ? "final_answer" : "commentary",
        true,
      );
      return;
    }
    await this.finishText();
    const outputIndex = this.output.length;
    const id = `${this.responseId}_status_${outputIndex}`;
    const itemFields = { id, type: "reasoning" } as const;
    const eventFields = {
      item_id: id,
      output_index: outputIndex,
      summary_index: 0,
    };
    await writeEvent(this.response, "response.output_item.added", {
      type: "response.output_item.added",
      output_index: outputIndex,
      item: { ...itemFields, summary: [] },
    });
    await writeEvent(this.response, "response.reasoning_summary_part.added", {
      type: "response.reasoning_summary_part.added",
      ...eventFields,
      part: { type: "summary_text", text: "" },
    });
    await writeEvent(this.response, "response.reasoning_summary_text.delta", {
      type: "response.reasoning_summary_text.delta",
      ...eventFields,
      delta: item.text,
    });
    await writeEvent(this.response, "response.reasoning_summary_text.done", {
      type: "response.reasoning_summary_text.done",
      ...eventFields,
      text: item.text,
    });
    const part = { type: "summary_text", text: item.text } as const;
    await writeEvent(this.response, "response.reasoning_summary_part.done", {
      type: "response.reasoning_summary_part.done",
      ...eventFields,
      part,
    });
    const completed = { ...itemFields, summary: [part] };
    await writeEvent(this.response, "response.output_item.done", {
      type: "response.output_item.done",
      output_index: outputIndex,
      item: completed,
    });
    this.output.push(completed);
  }

  private async appendText(
    value: string,
    phase: "commentary" | "final_answer" | null,
    separateBlock: boolean,
  ): Promise<void> {
    if (this.ended) throw new Error("FAROL_HOST_DELIVERY_LOST");
    if (this.textStarted && this.textPhase !== phase) await this.finishText();
    const separator = separateBlock && this.textStarted ? "\n\n" : "";
    if (!this.textStarted) {
      this.textPhase = phase;
      this.messageId = `${this.responseId}_message_${this.output.length}`;
      this.textStarted = true;
      await writeEvent(this.response, "response.output_item.added", {
        type: "response.output_item.added",
        output_index: this.output.length,
        item: {
          id: this.messageId,
          type: "message",
          role: "assistant",
          status: "in_progress",
          content: [],
          ...(phase === null ? {} : { phase }),
        },
      });
      await writeEvent(this.response, "response.content_part.added", {
        type: "response.content_part.added",
        item_id: this.messageId,
        output_index: this.output.length,
        content_index: 0,
        part: { type: "output_text", text: "" },
      });
    }
    const delta = `${separator}${value}`;
    this.text += delta;
    await writeEvent(this.response, "response.output_text.delta", {
      type: "response.output_text.delta",
      item_id: this.messageId,
      output_index: this.output.length,
      content_index: 0,
      delta,
    });
  }

  private async finishText(): Promise<void> {
    if (!this.textStarted) return;
    const outputIndex = this.output.length;
    const item = {
      id: this.messageId,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: this.text }],
      ...(this.textPhase === null ? {} : { phase: this.textPhase }),
    } as const;
    await writeEvent(this.response, "response.output_text.done", {
      type: "response.output_text.done",
      item_id: this.messageId,
      output_index: outputIndex,
      content_index: 0,
      text: this.text,
    });
    await writeEvent(this.response, "response.content_part.done", {
      type: "response.content_part.done",
      item_id: this.messageId,
      output_index: outputIndex,
      content_index: 0,
      part: { type: "output_text", text: this.text },
    });
    await writeEvent(this.response, "response.output_item.done", {
      type: "response.output_item.done",
      output_index: outputIndex,
      item,
    });
    this.output.push(item);
    this.text = "";
    this.textStarted = false;
    this.textPhase = null;
  }

  async completeTool(
    call: RoundToolCall,
    current: () => boolean,
  ): Promise<void> {
    const requireCurrent = () => {
      if (!current()) throw new Error("FAROL_HOST_DELIVERY_LOST");
    };
    requireCurrent();
    await this.finishText();
    requireCurrent();
    const outputIndex = this.output.length;
    const opening = {
      id: call.itemId,
      type: "function_call",
      call_id: call.callId,
      name: call.name,
      arguments: "",
      ...(call.namespace === null ? {} : { namespace: call.namespace }),
    } as const;
    await writeEvent(this.response, "response.output_item.added", {
      type: "response.output_item.added",
      output_index: outputIndex,
      item: opening,
    });
    requireCurrent();
    await writeEvent(this.response, "response.function_call_arguments.delta", {
      type: "response.function_call_arguments.delta",
      item_id: call.itemId,
      output_index: outputIndex,
      delta: call.encodedArguments,
    });
    requireCurrent();
    await writeEvent(this.response, "response.function_call_arguments.done", {
      type: "response.function_call_arguments.done",
      item_id: call.itemId,
      output_index: outputIndex,
      arguments: call.encodedArguments,
    });
    requireCurrent();
    const item = {
      ...opening,
      arguments: call.encodedArguments,
      status: "completed",
    } as const;
    await writeEvent(this.response, "response.output_item.done", {
      type: "response.output_item.done",
      output_index: outputIndex,
      item,
    });
    requireCurrent();
    this.output.push(item);
    await this.complete();
  }

  async completeFinal(): Promise<void> {
    await this.finishText();
    if (this.output.length < 1) {
      await this.fail("FAROL_PROVIDER_RESULT_INVALID");
      return;
    }
    await this.complete();
  }

  private async complete(): Promise<void> {
    await writeEvent(this.response, "response.completed", {
      type: "response.completed",
      response: {
        id: this.responseId,
        model: this.model,
        status: "completed",
        output: this.output,
      },
    });
    this.end();
  }

  async fail(code: string): Promise<void> {
    if (this.ended) return;
    await writeEvent(this.response, "response.failed", {
      type: "response.failed",
      response: {
        id: this.responseId,
        model: this.model,
        status: "failed",
        error: { code },
      },
    });
    this.end();
  }

  private end(): void {
    this.ended = true;
    this.response.end();
  }
}
