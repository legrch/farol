import { describe, expect, it } from "vitest";
import {
  AuditDetailsSchema,
  OperationEntrySchema,
} from "../../apps/desktop/renderer/operations-contract";
import { supportOperationMetadata } from "../../apps/desktop/operations/support-projection";

const empty = { state: "filtered" };
const details = (command: unknown) => ({
  command,
  stdout: empty,
  stderr: empty,
});

describe("local activity audit details", () => {
  it("keeps accepted local text out of support metadata", () => {
    const entry = OperationEntrySchema.parse({
      id: "22222222-2222-4222-8222-222222222222",
      at: 1,
      source: "ChatGPT",
      kind: "computer.process.terminal",
      target: {},
      outcome: "done",
      code: null,
      durationMs: null,
      schema: "farol.operation/2",
      operationRef: null,
      subjectRef: null,
      timing: null,
      exit: null,
      executionFacts: null,
      auditDetails: {
        command: { state: "filtered", text: "PRIVATE-LOCAL-CANARY" },
        stdout: empty,
        stderr: empty,
      },
    });
    expect(JSON.stringify(entry)).toContain("PRIVATE-LOCAL-CANARY");
    expect(JSON.stringify(supportOperationMetadata(entry))).not.toContain(
      "PRIVATE-LOCAL-CANARY",
    );
  });
  it("accepts bounded filtered text and closed withheld states", () => {
    expect(
      AuditDetailsSchema.safeParse(
        details({ state: "filtered", text: "git status\n" }),
      ).success,
    ).toBe(true);
    expect(
      AuditDetailsSchema.safeParse(
        details({ state: "withheld", reason: "inline_body" }),
      ).success,
    ).toBe(true);
    expect(
      AuditDetailsSchema.safeParse(
        details({ state: "unavailable", reason: "filter_unavailable" }),
      ).success,
    ).toBe(true);
  });

  it("rejects hidden text on withheld results, controls and excessive UTF-8 bytes", () => {
    for (const command of [
      { state: "withheld", reason: "inline_body", text: "secret" },
      { state: "unavailable", reason: "filter_failed", text: "secret" },
      { state: "filtered", text: "\u001b[31m" },
      { state: "filtered", text: "\ud800" },
      { state: "filtered", text: "é".repeat(1025) },
      { state: "withheld", reason: "unknown_reason" },
    ])
      expect(AuditDetailsSchema.safeParse(details(command)).success).toBe(
        false,
      );
  });
});
