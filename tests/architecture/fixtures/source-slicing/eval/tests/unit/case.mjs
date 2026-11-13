import fs from "node:fs";
const source = fs.readFileSync(
  new URL("../../src/apps/desktop/main.ts", import.meta.url),
  "utf8",
);
(0, eval)(source.slice(0, 10));
