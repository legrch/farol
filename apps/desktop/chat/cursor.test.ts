import { describe, expect, it } from "vitest";
import {
  conversationSourceCursor,
  digest,
  operationKey,
  summaryProviderOperationId,
} from "./cursor";

const binding = {
  ownerId: "owner-1",
  taskId: "task-1",
  hostThreadId: "thread-1",
  sessionId: "session-1",
};

describe("summary identities", () => {
  it("digests as lowercase sha256 hex", () => {
    expect(digest("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("keys an operation by its binding and id, in that order", () => {
    expect(operationKey(binding, "op-1")).toBe(
      digest(
        JSON.stringify(["owner-1", "task-1", "thread-1", "session-1", "op-1"]),
      ),
    );
    expect(operationKey(binding, "op-1")).not.toBe(
      operationKey(binding, "op-2"),
    );
    expect(operationKey(binding, "op-1")).not.toBe(
      operationKey({ ...binding, sessionId: "session-2" }, "op-1"),
    );
  });

  it("ignores binding fields the key does not name", () => {
    const wider = { ...binding, modelId: "model-1" };
    expect(operationKey(wider, "op-1")).toBe(operationKey(binding, "op-1"));
  });

  it("names a conversation cursor by the digest of its url", () => {
    const url = "https://chat.example/c/one";
    expect(conversationSourceCursor(url)).toBe(`conversation:${digest(url)}`);
    expect(conversationSourceCursor(url)).not.toBe(
      conversationSourceCursor("https://chat.example/c/two"),
    );
  });

  it("derives a forty character provider operation id", () => {
    const id = summaryProviderOperationId(
      "op-1",
      "boundary-1",
      "https://chat.example/c/one",
    );
    expect(id).toBe(
      `summary-${digest(JSON.stringify(["op-1", "boundary-1", "https://chat.example/c/one"])).slice(0, 40)}`,
    );
    expect(id).toHaveLength("summary-".length + 40);
    expect(
      summaryProviderOperationId(
        "op-1",
        "boundary-2",
        "https://chat.example/c/one",
      ),
    ).not.toBe(id);
  });
});
