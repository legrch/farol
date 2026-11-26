import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const optionName = "requireAppForManualMessages";
const owner = "src/apps/desktop/chatgpt-route.ts";

function walk(dir: string, out: string[]): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (
      /\.(ts|tsx|mts|cts)$/.test(entry.name) &&
      !/\.test\./.test(entry.name)
    )
      out.push(full);
  }
  return out;
}

function productionSources(): string[] {
  return [
    ...walk(path.join(root, "src"), []),
    ...walk(path.join(root, "apps"), []),
  ].map((file) => path.relative(root, file).split(path.sep).join("/"));
}

const identifier = new RegExp(`\\b${optionName}\\b`);

function mentions(files: string[]): string[] {
  return files.filter((file) =>
    identifier.test(fs.readFileSync(path.join(root, file), "utf8")),
  );
}

describe("protected ChatGPT route option", () => {
  it("scanner finds the declaration, so the guard cannot pass vacuously", () => {
    const files = productionSources();
    expect(files).toContain(owner);
    expect(mentions(files)).toContain(owner);
  });

  it("is not enabled or referenced by any other production source", () => {
    const offenders = mentions(productionSources()).filter(
      (file) => file !== owner,
    );
    expect(
      offenders,
      `${optionName} turns on the protected sign-in/submission surface, whose ` +
        "open-timeout teardown can let a surface with unconfirmed destruction " +
        "escape route custody (backlog item 7). Production must not use it " +
        "until a per-route surface registry keeps every surface and popup in " +
        `custody until confirmed destruction. Offending files: ${offenders.join(", ")}`,
    ).toEqual([]);
  });
});
