import { describe, expect, it } from "vitest";
import { completedSummaryReceipt } from "./receipt";

describe("completed summary receipt", () => {
  it("binds the stored summary to its source boundary", () => {
    const content = { goal: "one" };
    expect(
      completedSummaryReceipt(
        { providerOperationId: "summary-1", sourceCursor: "cursor-1", content },
        "boundary-1",
      ),
    ).toEqual({
      status: "completed",
      providerOperationId: "summary-1",
      sourceCursor: "cursor-1",
      content,
      summarizer: {
        engine: "current_chatgpt",
        provider: "chatgpt-web",
        observedModel: null,
        observedEffort: null,
        providerOperationId: "summary-1",
        sourceBoundary: "boundary-1",
        sourceCursor: "cursor-1",
      },
    });
  });

  it("returns the very content object it was given", () => {
    const content = { goal: "one" };
    const receipt = completedSummaryReceipt(
      { providerOperationId: "p", sourceCursor: "c", content },
      "b",
    );
    expect(receipt.content).toBe(content);
  });
});
