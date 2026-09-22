import { createQuitDrain } from "../../../src/apps/desktop/quit-drain.ts";

const drain = createQuitDrain({
  deadlineMs: 25,
  collect: () => [
    {
      name: "stalled-child",
      close: () => new Promise(() => {}),
    },
  ],
  record: async (receipt) => {
    process.stdout.write(`RECEIPT ${JSON.stringify(receipt)}\n`);
  },
  quit: () => {
    process.stdout.write("QUIT\n");
  },
});

drain.onBeforeQuit({ preventDefault: () => undefined });
