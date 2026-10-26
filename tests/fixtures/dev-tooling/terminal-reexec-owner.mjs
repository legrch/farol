// Real outer Node relay; only the selected interpreter is a synthetic fixture.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { reExecUnderDeclaredToolchain } from "../../../tooling/dev.mjs";

// Separate the broadcast and forwarded delivery deterministically. This
// exercises the possible scheduler ordering without relying on coalescing.
const on = process.on.bind(process),
  remove = process.removeListener.bind(process);
const delayed = new Map();
process.on = function (name, listener) {
  if (name !== "SIGINT" && name !== "SIGTERM") return on(name, listener);
  const wrapped = (...args) => setTimeout(() => listener(...args), 100);
  delayed.set(listener, wrapped);
  return on(name, wrapped);
};
process.removeListener = function (name, listener) {
  return remove(name, delayed.get(listener) ?? listener);
};
await reExecUnderDeclaredToolchain(
  {
    binDir: path.dirname(process.execPath),
    nodeBin: fileURLToPath(
      new URL("./terminal-reexec-target.mjs", import.meta.url),
    ),
  },
  [],
);
