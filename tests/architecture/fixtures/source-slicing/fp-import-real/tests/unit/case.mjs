import fs from "node:fs";
const index = fs.readFileSync("src/chat/index.ts", "utf8");
const names = [...index.matchAll(/from "\.\/(\w+)"/g)].map((match) => match[1]);
for (const name of names) await import(`../../src/chat/${name}.ts`);
