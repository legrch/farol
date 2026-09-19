// A tiny fixture process for dev.mjs's signal-escalation tests. It ignores
// SIGINT and SIGTERM outright (unlike a real app, which would usually quit
// on one of them), so a test can observe every step of the escalation -
// SIGINT, then SIGTERM, then the uncatchable SIGKILL that finally ends it -
// instead of the child exiting early and cutting the sequence short.
process.on("SIGINT", () => {
  process.stdout.write("child: ignoring SIGINT\n");
});
process.on("SIGTERM", () => {
  process.stdout.write("child: ignoring SIGTERM\n");
});
process.stdout.write("child: ready\n");
setInterval(() => {}, 1000);
