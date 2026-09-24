import { describe, expect, it, vi } from "vitest";
import {
  admittedCompaction,
  RouteBAdmission,
} from "../../src/apps/desktop/route-b-runtime";
import { failure } from "../../src/pkg/kernel/domain/result";

describe("compaction identity carriers share one admission owner", () => {
  it("does not summarize an active turn whose identity is only in embedded host metadata", async () => {
    const admission = new RouteBAdmission();
    admission.beginTurn("thread-active");
    const compact = vi.fn(async () =>
      failure("HOST_COMPACTION_REQUEST_INVALID" as const),
    );
    const boundary = admittedCompaction({ compact }, admission);
    expect(
      await boundary.compact({
        endpoint: "responses_compact",
        metadataHeader: undefined,
        body: {
          model: "farol-next/chatgpt",
          input: [{ role: "user", content: "Synthetic context" }],
          client_metadata: {
            "x-codex-turn-metadata": JSON.stringify({
              thread_id: "thread-active",
              turn_id: "compact-1",
            }),
          },
        },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "FAROL_NEXT_COMPACTION_TURN_ACTIVE" },
    });
    expect(compact).not.toHaveBeenCalled();
    expect(admission.owns("thread-active")).toBe(true);
  });
});
