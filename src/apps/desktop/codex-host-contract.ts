import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { hasRequestMethod } from "../../../apps/desktop/hostschema/graph";
import {
  HANDOFF_SCHEMA_FILES,
  supportsHandoff,
} from "../../../apps/desktop/hostschema/handoff";
import {
  array,
  child,
  contractError,
  type JsonRecord,
} from "../../../apps/desktop/hostschema/json";
import { readSchemaFile } from "../../../apps/desktop/hostschema/read";
import {
  hasEnumValues,
  hasMethod,
  hasRequired,
  hasShape,
  hasThreadItem,
} from "../../../apps/desktop/hostschema/shape";

const SCHEMA_FILES = [
  "v2/ThreadStartParams.json",
  "DynamicToolCallParams.json",
  "ServerRequest.json",
  "ClientRequest.json",
  "v2/ThreadListParams.json",
  "v2/ThreadReadResponse.json",
] as const;

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

async function inspectBaseHostSnapshot(
  root: string,
  versionOutput: string,
): Promise<
  Readonly<{ contract: CodexHostContract; clientRequest: JsonRecord }>
> {
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
  const schemas: Map<string, JsonRecord> = new Map(
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
  const contract: CodexHostContract = {
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
  return {
    contract,
    clientRequest: clientRequest ?? contractError("CODEX_HOST_SCHEMA_INVALID"),
  };
}

export async function inspectCodexHostContract(
  root: string,
  versionOutput: string,
): Promise<CodexHostContract> {
  return (await inspectBaseHostSnapshot(root, versionOutput)).contract;
}

export type CodexHandoffHostContract = Readonly<{
  version: string;
  protocol: "codex-app-server/v2";
  schemaSha256: string;
  projectBoundCreateStatus: true;
}>;

// The ordinary host probe validates binary identity and the base App Server
// contract. This additional source-only gate proves the experimental methods
// and response fields needed before a saved-project handoff can be wired.
// It never starts a task or reads a project from the owner's live profile.
export async function inspectCodexHandoffHostContract(
  root: string,
  versionOutput: string,
): Promise<CodexHandoffHostContract> {
  const snapshot = await inspectBaseHostSnapshot(root, versionOutput);
  const base = snapshot.contract;
  const entries = await Promise.all(
    HANDOFF_SCHEMA_FILES.map(async (relativePath) => ({
      relativePath,
      ...(await readSchemaFile(root, relativePath)),
    })),
  );
  const schemas: Map<string, JsonRecord> = new Map(
    entries.map((entry) => [entry.relativePath, entry.value] as const),
  );
  const client = snapshot.clientRequest;
  if (!supportsHandoff(client, schemas)) {
    contractError("CODEX_HOST_HANDOFF_UNAVAILABLE");
  }
  const digest = createHash("sha256");
  digest.update(base.schemaSha256);
  digest.update("\0");
  for (const entry of entries) {
    digest.update(entry.relativePath);
    digest.update("\0");
    digest.update(entry.bytes);
    digest.update("\0");
  }
  return {
    version: base.version,
    protocol: base.protocol,
    schemaSha256: digest.digest("hex"),
    projectBoundCreateStatus: true,
  };
}

/** Local schema evidence only; never enables a serving host's control capability. */
export async function inspectCodexTaskTitleHostContract(
  root: string,
  versionOutput: string,
) {
  const base = await inspectCodexHandoffHostContract(root, versionOutput);
  const client = await readSchemaFile(root, "ClientRequest.json");
  const params = await readSchemaFile(root, "v2/ThreadSetNameParams.json");
  const response = await readSchemaFile(root, "v2/ThreadSetNameResponse.json");
  if (
    !hasRequestMethod(
      client.value,
      "thread/name/set",
      "ThreadSetNameParams",
      params.value,
    ) ||
    params.value.type !== "object" ||
    !hasRequired(params.value, "threadId", "name") ||
    child(params.value, "properties", "threadId", "type") !== "string" ||
    child(params.value, "properties", "name", "type") !== "string" ||
    response.value.type !== "object"
  )
    contractError("CODEX_HOST_TITLE_UNAVAILABLE");
  const digest = createHash("sha256");
  digest.update(base.schemaSha256);
  for (const schema of [client, params, response]) {
    digest.update("\0");
    digest.update(schema.bytes);
  }
  return {
    ...base,
    titleUpdate: true as const,
    schemaSha256: digest.digest("hex"),
  };
}

/** Optional local schema evidence only; never issues the separate serving/read grant. */
export async function inspectCodexProjectTasksHostContract(
  root: string,
  versionOutput: string,
) {
  const base = await inspectCodexHandoffHostContract(root, versionOutput);
  const client = await readSchemaFile(root, "ClientRequest.json");
  const params = await readSchemaFile(root, "v2/ThreadListParams.json");
  const response = await readSchemaFile(root, "v2/ThreadListResponse.json");
  const fields = [
    ["projectId", "string|null"],
    ["cwd", "nullable-ref:ThreadListCwdFilter"],
    ["useStateDbOnly", "boolean"],
    ["archived", "boolean|null"],
    ["cursor", "string|null"],
    ["limit", "integer|null"],
    ["sortKey", "nullable-ref:ThreadSortKey"],
    ["sortDirection", "nullable-ref:SortDirection"],
  ] as const;
  const thread = child(response.value, "definitions", "Thread");
  if (
    !hasRequestMethod(
      client.value,
      "thread/list",
      "ThreadListParams",
      params.value,
    ) ||
    params.value.type !== "object" ||
    !fields.every(([key, shape]) =>
      hasShape(child(params.value, "properties", key), shape),
    ) ||
    !array(
      child(params.value, "definitions", "ThreadListCwdFilter", "anyOf"),
    ).some((candidate) => hasShape(candidate, "string")) ||
    child(params.value, "definitions", "ThreadSortKey", "type") !== "string" ||
    !array(
      child(params.value, "definitions", "ThreadSortKey", "enum"),
    ).includes("updated_at") ||
    child(params.value, "definitions", "SortDirection", "type") !== "string" ||
    !array(
      child(params.value, "definitions", "SortDirection", "enum"),
    ).includes("desc") ||
    response.value.type !== "object" ||
    !hasRequired(response.value, "data") ||
    !hasShape(child(response.value, "properties", "data"), "array:Thread") ||
    !hasShape(
      child(response.value, "properties", "nextCursor"),
      "string|null",
    ) ||
    child(thread, "type") !== "object" ||
    !hasRequired(thread, "id", "projectId", "cwd", "updatedAt") ||
    !(
      [
        ["id", "string"],
        ["projectId", "string|null"],
        ["cwd", "ref:AbsolutePathBuf"],
        ["name", "string|null"],
        ["model", "string|null"],
        ["updatedAt", "integer"],
      ] as const
    ).every(([key, shape]) =>
      hasShape(child(thread, "properties", key), shape),
    ) ||
    !hasShape(child(response.value, "definitions", "AbsolutePathBuf"), "string")
  )
    contractError("CODEX_HOST_PROJECT_TASKS_UNAVAILABLE");
  const digest = createHash("sha256");
  digest.update(base.schemaSha256);
  for (const schema of [client, params, response]) {
    digest.update("\0");
    digest.update(schema.bytes);
  }
  return {
    ...base,
    projectTaskMetadata: true as const,
    schemaSha256: digest.digest("hex"),
  };
}

export type CodexFollowupSchemaWitness = Readonly<{
  kind: "codex-followup-schema/v1";
  protocol: "codex-app-server/v2";
  baseSchemaSha256: string;
  schemaSha256: string;
}>;

/** Independent source evidence for completed-parent follow-up; no serving grant. */
export async function inspectCodexFollowupHostContract(
  root: string,
  versionOutput: string,
): Promise<CodexFollowupSchemaWitness> {
  const base = await inspectCodexHandoffHostContract(root, versionOutput);
  const names = [
    "ClientRequest.json",
    "v2/ThreadTurnsListParams.json",
    "v2/ThreadTurnsListResponse.json",
    "v2/TurnStartParams.json",
    "v2/TurnStartResponse.json",
  ] as const;
  const entries = await Promise.all(
    names.map(async (name) => ({
      name,
      ...(await readSchemaFile(root, name)),
    })),
  );
  const schemas = new Map(entries.map((entry) => [entry.name, entry.value]));
  const client = schemas.get("ClientRequest.json");
  const turns = schemas.get("v2/ThreadTurnsListParams.json");
  if (
    !hasRequestMethod(
      client,
      "thread/turns/list",
      "ThreadTurnsListParams",
      turns,
    ) ||
    !hasRequestMethod(
      client,
      "turn/start",
      "TurnStartParams",
      schemas.get("v2/TurnStartParams.json"),
    ) ||
    !hasShape(
      child(turns, "properties", "sortDirection"),
      "nullable-ref:SortDirection",
    ) ||
    !hasEnumValues(child(turns, "definitions", "SortDirection"), "desc")
  )
    contractError("CODEX_HOST_FOLLOWUP_UNAVAILABLE");
  // Refuse mixed snapshots. This does not certify a running provider or account.
  const after = await inspectCodexHandoffHostContract(root, versionOutput);
  if (after.schemaSha256 !== base.schemaSha256)
    contractError("CODEX_HOST_FOLLOWUP_UNAVAILABLE");
  const kind = "codex-followup-schema/v1" as const;
  const digest = createHash("sha256");
  digest.update(kind);
  digest.update("\0");
  digest.update(base.schemaSha256);
  digest.update("\0");
  for (const entry of entries) {
    digest.update(entry.name);
    digest.update("\0");
    digest.update(entry.bytes);
    digest.update("\0");
  }
  return {
    kind,
    protocol: base.protocol,
    baseSchemaSha256: base.schemaSha256,
    schemaSha256: digest.digest("hex"),
  };
}
