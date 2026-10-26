// The descendant must survive terminal Ctrl+C until its owner drains it.
import { spawn } from "node:child_process";
const child = spawn(
  process.execPath,
  [
    "--input-type=module",
    "-e",
    `
  process.on("message", (message) => { if (message === "quit") process.exit(0); });
  process.send("ready");
  setTimeout(() => process.exit(4), 8000);
`,
  ],
  { stdio: ["ignore", "ignore", "ignore", "ipc"] },
);
let requested = false;
const drainDelay = Number(process.env.FAROL_TERMINAL_FIXTURE_DRAIN_MS ?? "50");
if (![50, 300, 3000].includes(drainDelay))
  throw Error("FIXTURE_DRAIN_DELAY_INVALID");
const requestQuit = () => {
  if (requested) return;
  requested = true;
  setTimeout(() => {
    if (child.connected) child.send("quit");
  }, drainDelay);
};
process.on("SIGINT", requestQuit);
process.on("SIGTERM", requestQuit);
child.once("message", () => {
  process.stderr.write("FAROL_SECOND_INSTANCE_RESULT:primary-started\n");
  process.stdout.write("TERMINAL_FIXTURE_READY\n");
});
child.once("exit", (code, signal) => {
  const confirmed = requested && code === 0 && signal === null;
  process.stdout.write(
    confirmed
      ? "DESCENDANT_DRAIN_CONFIRMED\n"
      : "DESCENDANT_DRAIN_UNCONFIRMED\n",
  );
  process.exit(confirmed ? 0 : 2);
});
