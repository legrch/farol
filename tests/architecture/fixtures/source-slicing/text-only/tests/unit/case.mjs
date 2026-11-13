import fs from "node:fs";
import { expect, it } from "vitest";
const source = fs.readFileSync("src/apps/desktop/main.ts", "utf8");
it("keeps the export", () => expect(source).toMatch(/export const answer/));
