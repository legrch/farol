import { describe, expect, it } from "vitest";
import {
  compactionEvents,
  compactionMetadataHeader,
  streamedCompactionRequestWith,
} from "./compaction";

const isMetadata = (candidate: unknown): boolean =>
  typeof candidate === "object" &&
  candidate !== null &&
  (candidate as { kind?: unknown }).kind === "compact";
const streamed = (candidate: unknown, header?: string) =>
  streamedCompactionRequestWith(isMetadata, candidate, header);

describe("provider compaction", () => {
  it("recognizes a trailing compaction trigger and nothing looser", () => {
    expect(
      streamed({
        input: [{ type: "message" }, { type: "compaction_trigger" }],
      }),
    ).toBe(true);
    expect(
      streamed({
        input: [{ type: "compaction_trigger" }, { type: "message" }],
      }),
    ).toBe(false);
    expect(
      streamed({ input: [{ type: "compaction_trigger", extra: 1 }] }),
    ).toBe(false);
    expect(streamed(null)).toBe(false);
  });

  it("takes a header the codec accepts and refuses one it does not", () => {
    expect(streamed({ input: [] }, '{"kind":"compact"}')).toBe(true);
    expect(streamed({ input: [] }, '{"kind":"turn"}')).toBe(false);
  });

  it("treats an unreadable header as no declaration", () => {
    expect(streamed({ input: [] }, "{not json")).toBe(false);
  });

  it("reads the turn metadata header only when it is a string", () => {
    expect(
      compactionMetadataHeader({ headers: { "x-codex-turn-metadata": "a" } }),
    ).toBe("a");
    expect(
      compactionMetadataHeader({ headers: { "x-codex-turn-metadata": ["a"] } }),
    ).toBeUndefined();
    expect(compactionMetadataHeader({ headers: {} })).toBeUndefined();
  });

  it("orders the streamed events created, added, done, completed", () => {
    const item = { type: "compaction", id: "c1" };
    const events = compactionEvents("resp_1", "m", item);
    expect(events.map((entry) => entry.event)).toEqual([
      "response.created",
      "response.output_item.added",
      "response.output_item.done",
      "response.completed",
    ]);
    expect(events[0]?.data).toEqual({
      type: "response.created",
      response: { id: "resp_1", model: "m", status: "in_progress", output: [] },
    });
    expect(events[3]?.data).toEqual({
      type: "response.completed",
      response: {
        id: "resp_1",
        model: "m",
        status: "completed",
        output: [item],
      },
    });
  });
});
