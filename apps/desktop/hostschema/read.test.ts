import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSchemaFile } from "./read";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function root(): Promise<string> {
  const made = await fs.mkdtemp(path.join(os.tmpdir(), "farol-hostschema-"));
  roots.push(made);
  return made;
}

describe("host schema file read", () => {
  it("returns the bytes and the parsed record", async () => {
    const dir = await root();
    await fs.writeFile(path.join(dir, "a.json"), '{"a":1}\n', { mode: 0o600 });
    const read = await readSchemaFile(dir, "a.json");
    expect(read.value).toEqual({ a: 1 });
    expect(read.bytes.toString("utf8")).toBe('{"a":1}\n');
  });

  it("refuses a linked leaf", async () => {
    const dir = await root();
    await fs.writeFile(path.join(dir, "real.json"), "{}\n");
    await fs.symlink(path.join(dir, "real.json"), path.join(dir, "a.json"));
    await expect(readSchemaFile(dir, "a.json")).rejects.toThrow(
      "CODEX_HOST_SCHEMA_UNSAFE",
    );
  });

  it("refuses a missing file and a hard-linked file", async () => {
    const dir = await root();
    await expect(readSchemaFile(dir, "a.json")).rejects.toThrow(
      "CODEX_HOST_SCHEMA_UNSAFE",
    );
    await fs.writeFile(path.join(dir, "real.json"), "{}\n");
    await fs.link(path.join(dir, "real.json"), path.join(dir, "a.json"));
    await expect(readSchemaFile(dir, "a.json")).rejects.toThrow(
      "CODEX_HOST_SCHEMA_UNSAFE",
    );
  });

  it("refuses a file too small or too large", async () => {
    const dir = await root();
    await fs.writeFile(path.join(dir, "a.json"), "1");
    await expect(readSchemaFile(dir, "a.json")).rejects.toThrow(
      "CODEX_HOST_SCHEMA_UNSAFE",
    );
    await fs.writeFile(
      path.join(dir, "b.json"),
      Buffer.alloc(4 * 1_024 * 1_024 + 1, 32),
    );
    await expect(readSchemaFile(dir, "b.json")).rejects.toThrow(
      "CODEX_HOST_SCHEMA_UNSAFE",
    );
  });

  it("refuses a linked parent directory", async () => {
    const dir = await root();
    await fs.mkdir(path.join(dir, "real"));
    await fs.writeFile(path.join(dir, "real", "a.json"), "{}\n");
    await fs.symlink(path.join(dir, "real"), path.join(dir, "v2"));
    await expect(readSchemaFile(dir, "v2/a.json")).rejects.toThrow(
      "CODEX_HOST_SCHEMA_UNSAFE",
    );
  });

  it("refuses text that is not JSON or not an object", async () => {
    const dir = await root();
    await fs.writeFile(path.join(dir, "a.json"), "{nope");
    await expect(readSchemaFile(dir, "a.json")).rejects.toThrow(
      "CODEX_HOST_SCHEMA_INVALID",
    );
    await fs.writeFile(path.join(dir, "b.json"), "[1]\n");
    await expect(readSchemaFile(dir, "b.json")).rejects.toThrow(
      "CODEX_HOST_SCHEMA_INVALID",
    );
  });
});
