import { expect, it } from "vitest";
import {
  knownMethod,
  requiresOperationID,
  validate,
} from "../../apps/desktop/bridge/wire.ts";

// Canonical portable DTOs only. No provider membership or native qualification.
it("classifies the selected Codex read as a strict target-free read", () => {
  expect(knownMethod("task.codex.selected.read")).toBe(true);
  expect(requiresOperationID("task.codex.selected.read")).toBe(false);
  for (const request of [{}, { includeResult: false }, { includeResult: true }])
    expect(validate("TaskSelectedCodexReadRequest", request)).toBe(true);
  for (const request of [
    { threadId: "other" },
    { turnId: "other" },
    { includeResult: "true" },
    { includeResult: null },
    { includeResult: true, socketPath: "/other" },
  ])
    expect(validate("TaskSelectedCodexReadRequest", request)).toBe(false);
});
