import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { recordInterruptedCommand } from "../../apps/desktop/operations/interrupted-command";
import { OperationsStore } from "../../apps/desktop/operations/store";

// Private log files and a status-port double; no process, provider or recovery.
it("records one durable UNKNOWN notice across fresh starts without resolving history", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "farol-interrupted-notice-"),
  );
  const core = { interruptedCommand: vi.fn(async () => true) };
  const first = new OperationsStore(root);
  let second: OperationsStore | undefined;
  try {
    await recordInterruptedCommand(core, first);
    expect(await first.shutdown(1000)).toBe(true);
    second = new OperationsStore(root);
    const before = await second.snapshot();
    expect(before.entries).toHaveLength(1);
    expect(before.entries[0]).toMatchObject({
      kind: "computer_shell_start",
      code: "FRESH_SESSION_INTERRUPTED_COMMAND_UNKNOWN",
      outcome: "unknown",
      target: {},
    });
    await recordInterruptedCommand(core, second);
    expect(await second.shutdown(1000)).toBe(true);
    expect((await second.snapshot()).entries).toEqual(before.entries);
  } finally {
    await first.shutdown(1000);
    await second?.shutdown(1000);
    await fs.rm(root, { recursive: true, force: true });
  }
});

it("does not invent a notice without the current Go observation", async () => {
  const operations = { snapshot: vi.fn(), record: vi.fn() };
  await recordInterruptedCommand(
    { interruptedCommand: async () => false },
    operations,
  );
  expect(operations.snapshot).not.toHaveBeenCalled();
  expect(operations.record).not.toHaveBeenCalled();
  await expect(
    recordInterruptedCommand(
      {
        interruptedCommand: async () => {
          throw Error("STATUS_UNAVAILABLE");
        },
      },
      operations,
    ),
  ).rejects.toThrow("STATUS_UNAVAILABLE");
  expect(operations.record).not.toHaveBeenCalled();
});
