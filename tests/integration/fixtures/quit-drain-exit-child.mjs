import { createQuitDrain } from "../../../src/apps/desktop/quit-drain.ts";
import fs from "node:fs/promises";

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
      await new Promise((resolve) => setTimeout(resolve, 5));
      await fs.writeFile(receiptFile, JSON.stringify(receipt), { mode: 0o600 });
    }
    process.stdout.write(`RECEIPT ${JSON.stringify(receipt)}\n`);
  },
  quit: () => {
    process.stdout.write("QUIT\n");
    if (receiptFile) process.exit(0);
  },
});

drain.onBeforeQuit({ preventDefault: () => undefined });
