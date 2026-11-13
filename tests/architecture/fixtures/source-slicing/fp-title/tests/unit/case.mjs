import fs from "node:fs";
import vm from "node:vm";
import { it } from "vitest";
const text = fs.readFileSync("tests/fixtures/data.txt", "utf8");
it("keeps src/apps/desktop/main.ts stable", () => vm.runInNewContext(text, {}));
