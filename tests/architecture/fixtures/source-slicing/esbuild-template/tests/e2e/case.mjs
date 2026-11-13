import fs from "node:fs/promises";
import path from "node:path";
import { buildSync } from "esbuild";

const root = path.resolve(import.meta.dirname, "../..");
const source = await fs.readFile(
  path.join(root, "src/apps/desktop/main.ts"),
  "utf8",
);
const begin = source.indexOf("export const");
const end = source.indexOf(";", begin);
buildSync({
  stdin: {
    resolveDir: root,
    sourcefile: "fixture.ts",
    loader: "ts",
    contents: `
import assert from 'node:assert/strict';
${source.slice(begin, end)}
assert.ok(answer);
`,
  },
  write: false,
});
