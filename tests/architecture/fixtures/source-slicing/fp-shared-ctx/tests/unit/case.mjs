import fs from "node:fs";
const ctx = {};
ctx.text = fs.readFileSync("src/chat/index.ts", "utf8");
ctx.name = "session";
process.env.INDEX = ctx.text;
await import(`../../src/chat/${ctx.name}.ts`);
