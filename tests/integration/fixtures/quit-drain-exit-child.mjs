import { createQuitDrain } from "../../../src/apps/desktop/quit-drain.ts";
import { writeFileSync } from "node:fs";

const receiptFile = process.argv[2];

const drain = createQuitDrain({
  deadlineMs: receiptFile ? 80 : 25,
  ...(receiptFile
    ? {
        preparationMs: 10,
        recordReserveMs: 40,
        prepare: () => new Promise(() => {}),
      }
    : {}),
  collect: () => [
    {
      name: "stalled-child",
      close: () => new Promise(() => {}),
    },
  ],
  record: async (receipt) => {
    if (receiptFile) {
      // This process fixture proves that a referenced drain reaches the real
      // Quit, even when preparation owns no active handle. Record its input
      // synchronously so host scheduling cannot turn the assertion into a race
      // against an intentionally bounded asynchronous diagnostic. Reserved and
      // stalled recorder budgets are covered by quit-drain's clocked tests.
      writeFileSync(receiptFile, JSON.stringify(receipt), { mode: 0o600 });
    }
    process.stdout.write(`RECEIPT ${JSON.stringify(receipt)}\n`);
  },
  quit: () => {
    process.stdout.write("QUIT\n");
    if (receiptFile) process.exit(0);
  },
});

drain.onBeforeQuit({ preventDefault: () => undefined });
