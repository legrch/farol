import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { OperationsStore } from "../../apps/desktop/operations/store";
import {
  ProcessAuditCollector,
  ProcessAuditObserver,
} from "../../apps/desktop/operations/process-audit-collector";
import { ProcessAuditBridge } from "../../apps/desktop/bridge/process-audit";

it("collects a terminal without a renderer and retains UNKNOWN after reopen", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "farol-audit-background-"),
  );
  const store = new OperationsStore(directory);
  const ref = {
    owner: "computer.process" as const,
    operationId: "background",
    buildId: "build",
    runtimeId: "runtime",
    binding: "requested" as const,
  };
  const reader = {
    read: vi
      .fn()
      .mockResolvedValue({
        operationId: ref.operationId,
        buildId: ref.buildId,
        runtimeId: ref.runtimeId,
        exitCode: 0,
        exitSignal: 0,
        rootWaited: true,
        outputDrained: true,
        groupCleanup: "confirmed",
        descendantCleanup: "unverified",
        timedOut: false,
        authorityLost: false,
      }),
  };
  const collector = new ProcessAuditCollector(store);
  const observer = new ProcessAuditObserver(
    collector,
    () => store.snapshot(5000),
    reader,
    () => true,
    10,
  );
  try {
    const finish = store.beginExecution(
      { source: "ChatGPT", kind: "computer_shell_start", target: {} },
      { operationRef: ref, subjectRef: null },
    );
    finish("unknown", "PROCESS_OUTCOME_UNKNOWN", 12);
    expect(await store.flush(5000)).toBe(true);
    observer.start();
    await vi.waitFor(async () =>
      expect((await store.snapshot(5000)).entries).toHaveLength(2),
    );
    observer.stop();
    expect(await collector.drain(1000)).toBe(true);
    expect(await store.shutdown(5000)).toBe(true);
    const reopened = new OperationsStore(directory);
    try {
      expect((await reopened.snapshot(5000)).entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "computer_shell_start",
            outcome: "unknown",
          }),
          expect.objectContaining({
            kind: "computer.process.terminal",
            exit: { kind: "code", value: 0 },
          }),
        ]),
      );
      expect(reader.read).toHaveBeenCalledOnce();
    } finally {
      await reopened.shutdown(5000);
    }
  } finally {
    observer.stop();
    await store.shutdown(5000);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

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

it("retains an admitted terminal observation through a bounded close and reopen", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "farol-audit-quit-"));
  const store = new OperationsStore(directory);
  const ref = {
    owner: "computer.process" as const,
    operationId: "process-quit",
    buildId: "build",
    runtimeId: "runtime",
    binding: "requested" as const,
  };
  try {
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
      exitCode: 0,
      exitSignal: 0,
      rootWaited: true,
      outputDrained: true,
      groupCleanup: "confirmed" as const,
      descendantCleanup: "unverified" as const,
      timedOut: false,
      authorityLost: false,
    };
    let complete!: (value: typeof fact) => void;
    const reader = {
      read: vi.fn(
        () =>
          new Promise<typeof fact>((resolve) => {
            complete = resolve;
          }),
      ),
    };
    const collector = new ProcessAuditCollector(store);
    collector.observe(await store.snapshot(5000), reader, () => true);
    const draining = collector.drain(1000);
    complete(fact);
    expect(await draining).toBe(true);
    expect(await store.shutdown(5000)).toBe(true);
    const reopened = new OperationsStore(directory);
    try {
      const entries = (await reopened.snapshot(5000)).entries;
      expect(entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "computer_shell_start",
            outcome: "unknown",
          }),
          expect.objectContaining({
            kind: "computer.process.terminal",
            exit: { kind: "code", value: 0 },
          }),
        ]),
      );
      expect(reader.read).toHaveBeenCalledOnce();
    } finally {
      await reopened.shutdown(5000);
    }
  } finally {
    await store.shutdown(5000);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
