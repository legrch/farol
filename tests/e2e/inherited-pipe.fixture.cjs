const fs = require("node:fs");
const { spawn } = require("node:child_process");

const pidFile = process.argv[2];
if (!pidFile) process.exit(2);

const descendant = spawn(
  process.execPath,
  ["-e", "setInterval(() => undefined, 1_000)"],
  { stdio: ["ignore", "inherit", "inherit"] },
);
fs.writeFileSync(pidFile, `${descendant.pid}\n`, { mode: 0o600 });
descendant.unref();
