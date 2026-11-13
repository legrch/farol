import fs from "node:fs";
import vm from "node:vm";
const root = process.cwd();
const resolve = vi.fn(() => "/tmp/elsewhere");
const source = fs.readFileSync(
  resolve(root, "src/apps/desktop/main.ts"),
  "utf8",
);
vm.runInNewContext(source, {});
