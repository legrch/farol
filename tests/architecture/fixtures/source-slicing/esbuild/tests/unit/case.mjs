import fs from "node:fs";
import { buildSync } from "esbuild";
const source = fs.readFileSync("src/apps/desktop/main.ts", "utf8");
buildSync({
  stdin: { contents: source.slice(0, 10), loader: "ts" },
  write: false,
});
