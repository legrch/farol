import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
let root = fs.mkdtempSync(path.join(os.tmpdir(), "farol-x-"));
root = path.resolve(import.meta.dirname, "../..");
vm.runInNewContext(
  fs.readFileSync(path.join(root, "src/apps/desktop/main.ts"), "utf8"),
  {},
);
