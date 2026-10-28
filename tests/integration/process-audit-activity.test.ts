import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { OperationsStore } from "../../apps/desktop/operations/store";
import { ProcessAuditCollector } from "../../apps/desktop/operations/process-audit-collector";
import { ProcessAuditBridge } from "../../apps/desktop/bridge/process-audit";

// Synthetic transport response; this test does not launch Go or a native child.
it("carries a late original terminal observation into Activity without replacing UNKNOWN", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "farol-audit-test-"));
  const store = new OperationsStore(directory);
  try {
    const ref = {
      owner: "computer.process" as const,
      operationId: "process-1",
      buildId: "build",
      runtimeId: "runtime",
      binding: "requested" as const,
    };
    const finish = store.beginExecution(
      { source: "ChatGPT", kind: "computer_shell_start", target: {} },
      { operationRef: ref, subjectRef: null },
    );
    finish("unknown", "PROCESS_OUTCOME_UNKNOWN", 12);
    expect(await store.flush(5000)).toBe(true);
    const fact = {
      operationId: ref.operationId,
      buildId: ref.buildId,
      runtimeId: ref.runtimeId,
      exitCode: 3,
      exitSignal: 0,
      rootWaited: true,
      outputDrained: true,
      groupCleanup: "confirmed",
      descendantCleanup: "unverified",
      timedOut: false,
      authorityLost: false,
      auditDetails: {
        command: { state: "filtered", text: "git status" },
        stdout: { state: "filtered", text: "clean" },
        stderr: { state: "unavailable", reason: "source_incomplete" },
      },
    };
    const request = vi
      .fn()
      .mockResolvedValue({ status: "ok", data: { state: "observed", fact } });
    const collector = new ProcessAuditCollector(store);
    const before = await store.snapshot(5000);
    collector.observe(before, new ProcessAuditBridge({ request }), () => true);
    await vi.waitFor(async () =>
      expect((await store.snapshot(5000)).entries).toHaveLength(2),
    );
    const after = await store.snapshot(5000);
    expect(after.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "computer_shell_start",
          outcome: "unknown",
          operationRef: ref,
        }),
        expect.objectContaining({
          kind: "computer.process.terminal",
          durationMs: null,
          exit: { kind: "code", value: 3 },
          operationRef: { ...ref, binding: "accepted" },
          auditDetails: fact.auditDetails,
        }),
      ]),
    );
    expect(request).toHaveBeenCalledOnce();
    collector.observe(after, new ProcessAuditBridge({ request }), () => true);
    expect(request).toHaveBeenCalledOnce();
  } finally {
    await store.shutdown(5000);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
