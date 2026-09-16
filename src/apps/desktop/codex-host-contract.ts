import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const CLOSE_ON_EXEC =
  (fsConstants as typeof fsConstants & { O_CLOEXEC?: number }).O_CLOEXEC ?? 0;
const MAX_SCHEMA_BYTES = 4 * 1_024 * 1_024;
const SCHEMA_FILES = [
  "v2/ThreadStartParams.json",
  "DynamicToolCallParams.json",
  "ServerRequest.json",
  "ClientRequest.json",
  "v2/ThreadListParams.json",
  "v2/ThreadReadResponse.json",
] as const;

type JsonRecord = Record<string, unknown>;

export type CodexHostContract = Readonly<{
  version: string;
  protocol: "codex-app-server/v2";
  schemaSha256: string;
  capabilities: Readonly<{
    dynamicTools: true;
    correlatedToolCalls: true;
    descendantObservation: true;
    collabObservation: true;
    compaction: true;
  }>;
}>;

function contractError(code: string): never {
  throw new Error(code);
}

function record(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function child(value: unknown, ...keys: string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (!record(current) || !(key in current)) return undefined;
    current = current[key];
  }
  return current;
}

function array(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function hasMethod(schema: unknown, method: string): boolean {
  return array(child(schema, "oneOf")).some((candidate) =>
    array(child(candidate, "properties", "method", "enum")).includes(method),
  );
}

function hasThreadItem(schema: unknown, type: string): boolean {
  return array(child(schema, "definitions", "ThreadItem", "oneOf")).some(
    (candidate) =>
      array(child(candidate, "properties", "type", "enum")).includes(type),
  );
}

async function readSchemaFile(
  root: string,
  relativePath: (typeof SCHEMA_FILES)[number],
): Promise<Readonly<{ bytes: Buffer; value: JsonRecord }>> {
  const target = path.join(root, relativePath);
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

export async function inspectCodexHostContract(
  root: string,
  versionOutput: string,
): Promise<CodexHostContract> {
  if (!path.isAbsolute(root) || root.includes("\0")) {
    contractError("CODEX_HOST_SCHEMA_UNSAFE");
  }
  let rootInfo;
  try {
    rootInfo = await fs.lstat(root);
  } catch {
    contractError("CODEX_HOST_SCHEMA_UNSAFE");
  }
  const effectiveUser = process.geteuid?.();
  if (
    !rootInfo.isDirectory() ||
    rootInfo.isSymbolicLink() ||
    (effectiveUser !== undefined && rootInfo.uid !== effectiveUser)
  ) {
    contractError("CODEX_HOST_SCHEMA_UNSAFE");
  }

  const versionMatch =
    /^codex-cli ([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)\s*$/u.exec(
      versionOutput,
    );
  if (!versionMatch?.[1]) contractError("CODEX_HOST_VERSION_INVALID");

  const entries = await Promise.all(
    SCHEMA_FILES.map(async (relativePath) => ({
      relativePath,
      ...(await readSchemaFile(root, relativePath)),
    })),
  );
  const schemas = new Map(
    entries.map((entry) => [entry.relativePath, entry.value] as const),
  );
  const threadStart = schemas.get("v2/ThreadStartParams.json");
  const dynamicCall = schemas.get("DynamicToolCallParams.json");
  const serverRequest = schemas.get("ServerRequest.json");
  const clientRequest = schemas.get("ClientRequest.json");
  const threadList = schemas.get("v2/ThreadListParams.json");
  const threadRead = schemas.get("v2/ThreadReadResponse.json");

  if (
    child(threadStart, "properties", "dynamicTools", "items", "$ref") !==
    "#/definitions/DynamicToolSpec"
  ) {
    contractError("CODEX_HOST_DYNAMIC_TOOLS_UNAVAILABLE");
  }
  const requiredCallFields = new Set(
    array(child(dynamicCall, "required")).filter(
      (value): value is string => typeof value === "string",
    ),
  );
  if (
    !["threadId", "turnId", "callId", "tool", "arguments"].every((field) =>
      requiredCallFields.has(field),
    ) ||
    !hasMethod(serverRequest, "item/tool/call")
  ) {
    contractError("CODEX_HOST_TOOL_CORRELATION_UNAVAILABLE");
  }
  if (
    child(threadList, "properties", "parentThreadId") === undefined ||
    child(threadList, "properties", "ancestorThreadId") === undefined ||
    child(
      threadRead,
      "definitions",
      "Thread",
      "properties",
      "parentThreadId",
    ) === undefined
  ) {
    contractError("CODEX_HOST_DESCENDANT_OBSERVATION_UNAVAILABLE");
  }
  if (!hasThreadItem(threadRead, "collabAgentToolCall")) {
    contractError("CODEX_HOST_AGENT_OBSERVATION_UNAVAILABLE");
  }
  if (!hasMethod(clientRequest, "thread/compact/start")) {
    contractError("CODEX_HOST_COMPACTION_UNAVAILABLE");
  }

  const digest = createHash("sha256");
  digest.update(versionMatch[1]);
  digest.update("\0");
  for (const entry of entries) {
    digest.update(entry.relativePath);
    digest.update("\0");
    digest.update(entry.bytes);
    digest.update("\0");
  }
  return {
    version: versionMatch[1],
    protocol: "codex-app-server/v2",
    schemaSha256: digest.digest("hex"),
    capabilities: {
      dynamicTools: true,
      correlatedToolCalls: true,
      descendantObservation: true,
      collabObservation: true,
      compaction: true,
    },
  };
}
