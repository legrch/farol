import fs from "node:fs";
import { Script } from "node:vm";
const { readFile } = fs.promises;
const source = await readFile("src/apps/desktop/main.ts", "utf8");
new Script(source).runInThisContext();
