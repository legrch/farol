import { readFileSync as r } from "node:fs";
import { runInNewContext as run } from "node:vm";
run(r("src/apps/desktop/main.ts", "utf8"), {});
