import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { contractError, record, type JsonRecord } from "./json";

const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const CLOSE_ON_EXEC =
  (fsConstants as typeof fsConstants & { O_CLOEXEC?: number }).O_CLOEXEC ?? 0;
const MAX_SCHEMA_BYTES = 4 * 1_024 * 1_024;

export async function readSchemaFile(
  root: string,
  relativePath: string,
): Promise<Readonly<{ bytes: Buffer; value: JsonRecord }>> {
  const target = path.join(root, relativePath);
  // O_NOFOLLOW protects the leaf; reject redirects through a parent directory too.
  for (const parent of [root, path.dirname(target)]) {
    let info;
    try {
      info = await fs.lstat(parent);
    } catch {
      contractError("CODEX_HOST_SCHEMA_UNSAFE");
    }
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (process.geteuid?.() !== undefined && info.uid !== process.geteuid())
    ) {
      contractError("CODEX_HOST_SCHEMA_UNSAFE");
    }
  }
  let handle;
  try {
    handle = await fs.open(
      target,
      fsConstants.O_RDONLY | NO_FOLLOW | CLOSE_ON_EXEC,
    );
  } catch {
    contractError("CODEX_HOST_SCHEMA_UNSAFE");
  }
  try {
    const info = await handle.stat();
    const effectiveUser = process.geteuid?.();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.size < 2 ||
      info.size > MAX_SCHEMA_BYTES ||
      (effectiveUser !== undefined && info.uid !== effectiveUser)
    ) {
      contractError("CODEX_HOST_SCHEMA_UNSAFE");
    }
    const bytes = await handle.readFile();
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    } catch {
      contractError("CODEX_HOST_SCHEMA_INVALID");
    }
    if (!record(parsed)) contractError("CODEX_HOST_SCHEMA_INVALID");
    return { bytes, value: parsed };
  } finally {
    await handle.close();
  }
}
