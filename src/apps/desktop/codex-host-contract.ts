import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

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
const HANDOFF_SCHEMA_FILES = [
  "v2/ProjectListParams.json",
  "v2/ProjectListResponse.json",
  "v2/ThreadStartParams.json",
  "v2/ThreadStartResponse.json",
  "v2/TurnStartParams.json",
  "v2/TurnStartResponse.json",
  "v2/ThreadReadParams.json",
  "v2/ThreadReadResponse.json",
  "v2/ThreadTurnsListParams.json",
  "v2/ThreadTurnsListResponse.json",
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

type SchemaField = Readonly<{
  schema: string;
  path: readonly string[];
  shape: string;
}>;

function hasShape(schema: unknown, shape: string): boolean {
  if (!record(schema)) return false;
  if (shape.startsWith("ref:")) {
    const ref = `#/definitions/${shape.slice(4)}`;
    return (
      schema.$ref === ref ||
      array(schema.allOf).some((part) => child(part, "$ref") === ref)
    );
  }
  if (shape.startsWith("nullable-ref:")) {
    const ref = `#/definitions/${shape.slice(13)}`;
    return (
      array(schema.anyOf).some((part) => child(part, "$ref") === ref) &&
      array(schema.anyOf).some((part) => child(part, "type") === "null")
    );
  }
  if (shape.startsWith("array:")) {
    return (
      schema.type === "array" &&
      child(schema, "items", "$ref") === `#/definitions/${shape.slice(6)}`
    );
  }
  const expected = shape.split("|");
  const actual =
    typeof schema.type === "string" ? [schema.type] : array(schema.type);
  return (
    expected.length === actual.length &&
    expected.every((type) => actual.includes(type))
  );
}

function hasFieldShapes(
  schemas: ReadonlyMap<string, JsonRecord>,
  fields: readonly SchemaField[],
): boolean {
  return fields.every(({ schema, path: fieldPath, shape }) =>
    hasShape(child(schemas.get(schema), ...fieldPath), shape),
  );
}

const HANDOFF_FIELDS: readonly SchemaField[] = (
  [
    ["ProjectListParams", "cursor", "string|null"],
    ["ProjectListParams", "limit", "integer|null"],
    ["ProjectListResponse", "data", "array:Project"],
    ["ProjectListResponse", "nextCursor", "string|null"],
    ["ThreadStartParams", "projectId", "string|null"],
    ["ThreadStartParams", "cwd", "string|null"],
    ["ThreadStartParams", "ephemeral", "boolean|null"],
    ["ThreadStartParams", "model", "string|null"],
    ["ThreadStartParams", "allowProviderModelFallback", "boolean"],
    ["ThreadStartParams", "sandbox", "nullable-ref:SandboxMode"],
    ["ThreadStartParams", "approvalPolicy", "nullable-ref:AskForApproval"],
    ["ThreadStartResponse", "thread", "ref:Thread"],
    ["ThreadStartResponse", "cwd", "ref:AbsolutePathBuf"],
    ["ThreadStartResponse", "model", "string"],
    ["ThreadStartResponse", "sandbox", "ref:SandboxPolicy"],
    ["ThreadStartResponse", "approvalPolicy", "ref:AskForApproval"],
    ["TurnStartParams", "threadId", "string"],
    ["TurnStartParams", "input", "array:UserInput"],
    ["TurnStartParams", "cwd", "string|null"],
    ["TurnStartParams", "model", "string|null"],
    ["TurnStartParams", "effort", "nullable-ref:ReasoningEffort"],
    ["TurnStartParams", "sandboxPolicy", "nullable-ref:SandboxPolicy"],
    ["TurnStartParams", "approvalPolicy", "nullable-ref:AskForApproval"],
    ["TurnStartResponse", "turn", "ref:Turn"],
    ["ThreadReadParams", "threadId", "string"],
    ["ThreadReadParams", "includeTurns", "boolean"],
    ["ThreadReadResponse", "thread", "ref:Thread"],
    ["ThreadTurnsListParams", "threadId", "string"],
    ["ThreadTurnsListParams", "cursor", "string|null"],
    ["ThreadTurnsListParams", "limit", "integer|null"],
    ["ThreadTurnsListParams", "itemsView", "nullable-ref:TurnItemsView"],
    ["ThreadTurnsListResponse", "data", "array:Turn"],
    ["ThreadTurnsListResponse", "nextCursor", "string|null"],
  ] as readonly (readonly [string, string, string])[]
).map(([schema, name, shape]) => ({
  schema: `v2/${schema}.json`,
  path: ["properties", name],
  shape,
}));

const HANDOFF_DEFINITION_FIELDS: readonly SchemaField[] = (
  [
    ["ProjectListResponse", "Project", "id", "string"],
    ["ProjectListResponse", "Project", "roots", "array:ProjectRoot"],
    ["ProjectListResponse", "ProjectRoot", "path", "ref:AbsolutePathBuf"],
    ["ThreadStartResponse", "Thread", "id", "string"],
    ["ThreadStartResponse", "Thread", "projectId", "string|null"],
    ["ThreadStartResponse", "Thread", "cwd", "ref:AbsolutePathBuf"],
    ["ThreadStartResponse", "Thread", "model", "string|null"],
    ["TurnStartResponse", "Turn", "id", "string"],
    ["ThreadReadResponse", "Thread", "id", "string"],
    ["ThreadReadResponse", "Thread", "projectId", "string|null"],
    ["ThreadReadResponse", "Thread", "cwd", "ref:AbsolutePathBuf"],
    ["ThreadReadResponse", "Thread", "model", "string|null"],
    ["ThreadTurnsListResponse", "Turn", "id", "string"],
    ["ThreadTurnsListResponse", "Turn", "status", "ref:TurnStatus"],
  ] as readonly (readonly [string, string, string, string])[]
).map(([schema, definition, name, shape]) => ({
  schema: `v2/${schema}.json`,
  path: ["definitions", definition, "properties", name],
  shape,
}));

function hasRequestMethod(
  schema: unknown,
  method: string,
  params: string,
  standaloneParams: unknown,
): boolean {
  if (!matchingDefinitionGraph(schema, standaloneParams, params)) return false;
  return array(child(schema, "oneOf")).some(
    (candidate) =>
      array(child(candidate, "properties", "method", "enum")).includes(
        method,
      ) &&
      ["id", "method", "params"].every((name) =>
        array(child(candidate, "required")).includes(name),
      ) &&
      child(candidate, "properties", "params", "$ref") ===
        `#/definitions/${params}`,
  );
}

function referencedDefinitions(value: unknown): string[] | null {
  const found: string[] = [];
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const next = pending.pop();
    if (Array.isArray(next)) {
      for (const item of next) pending.push(item);
    } else if (record(next)) {
      if ("$ref" in next) {
        if (
          typeof next.$ref !== "string" ||
          !/^#\/definitions\/[A-Za-z0-9_]+$/u.test(next.$ref)
        )
          return null;
        found.push(next.$ref.slice("#/definitions/".length));
      }
      for (const item of Object.values(next)) pending.push(item);
    }
  }
  return found;
}

function matchingDefinitionGraph(
  client: unknown,
  standalone: unknown,
  rootName: string,
): boolean {
  if (!record(standalone)) return false;
  const clientDefinitions = child(client, "definitions");
  const standaloneDefinitions = child(standalone, "definitions");
  if (!record(clientDefinitions)) return false;
  const pending = [rootName];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const name = pending.pop()!;
    if (seen.has(name)) continue;
    if (seen.size >= 512) return false;
    seen.add(name);
    const embedded = clientDefinitions[name];
    const expected =
      name === rootName
        ? Object.fromEntries(
            Object.entries(standalone).filter(
              ([key]) => !["$schema", "definitions", "title"].includes(key),
            ),
          )
        : record(standaloneDefinitions)
          ? standaloneDefinitions[name]
          : undefined;
    if (
      !record(embedded) ||
      !record(expected) ||
      !isDeepStrictEqual(embedded, expected)
    )
      return false;
    const references = referencedDefinitions(embedded);
    if (references === null) return false;
    for (const reference of references) pending.push(reference);
  }
  return true;
}

function hasEnumValues(schema: unknown, ...values: string[]): boolean {
  if (!record(schema)) return false;
  const candidates = schema.oneOf ? array(schema.oneOf) : [schema];
  return values.every((value) =>
    candidates.some(
      (candidate) =>
        child(candidate, "type") === "string" &&
        array(child(candidate, "enum")).includes(value),
    ),
  );
}

function supportsHandoffValues(
  client: unknown,
  turnsResponse: unknown,
): boolean {
  const definitions = child(client, "definitions");
  const textInput = array(child(definitions, "UserInput", "oneOf")).some(
    (variant) =>
      array(child(variant, "properties", "type", "enum")).includes("text") &&
      child(variant, "properties", "text", "type") === "string" &&
      hasRequired(variant, "type", "text"),
  );
  return (
    hasEnumValues(
      child(definitions, "SandboxMode"),
      "read-only",
      "workspace-write",
    ) &&
    hasEnumValues(
      child(definitions, "AskForApproval"),
      "untrusted",
      "on-request",
    ) &&
    hasEnumValues(child(definitions, "TurnItemsView"), "notLoaded") &&
    child(definitions, "ReasoningEffort", "type") === "string" &&
    textInput &&
    hasEnumValues(
      child(turnsResponse, "definitions", "TurnStatus"),
      "completed",
      "interrupted",
      "failed",
      "inProgress",
    )
  );
}

function hasRequired(schema: unknown, ...names: string[]): boolean {
  return names.every((name) => array(child(schema, "required")).includes(name));
}

const HANDOFF_REQUIRED: readonly (readonly [
  string,
  readonly string[],
  readonly string[],
])[] = [
  ["ProjectListResponse", [], ["data"]],
  ["ProjectListResponse", ["Project"], ["id", "roots"]],
  ["ProjectListResponse", ["ProjectRoot"], ["path"]],
  [
    "ThreadStartResponse",
    [],
    ["thread", "cwd", "model", "sandbox", "approvalPolicy"],
  ],
  ["ThreadStartResponse", ["Thread"], ["id", "projectId", "cwd"]],
  ["TurnStartParams", [], ["threadId", "input"]],
  ["TurnStartResponse", [], ["turn"]],
  ["TurnStartResponse", ["Turn"], ["id"]],
  ["ThreadReadParams", [], ["threadId"]],
  ["ThreadReadResponse", [], ["thread"]],
  ["ThreadReadResponse", ["Thread"], ["id", "projectId", "cwd"]],
  ["ThreadTurnsListParams", [], ["threadId"]],
  ["ThreadTurnsListResponse", [], ["data"]],
  ["ThreadTurnsListResponse", ["Turn"], ["id", "status"]],
];

function hasRequiredFields(schemas: ReadonlyMap<string, JsonRecord>): boolean {
  return HANDOFF_REQUIRED.every(([file, definition, names]) =>
    hasRequired(
      child(
        schemas.get(`v2/${file}.json`),
        ...(definition.length ? ["definitions", ...definition] : []),
      ),
      ...names,
    ),
  );
}

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
  if (
    !(
      [
        ["project/list", "ProjectListParams"],
        ["thread/start", "ThreadStartParams"],
        ["thread/read", "ThreadReadParams"],
        ["thread/turns/list", "ThreadTurnsListParams"],
        ["turn/start", "TurnStartParams"],
      ] as readonly (readonly [string, string])[]
    ).every(([method, params]) =>
      hasRequestMethod(
        client,
        method,
        params,
        schemas.get(`v2/${params}.json`),
      ),
    ) ||
    !hasFieldShapes(schemas, HANDOFF_FIELDS) ||
    !hasFieldShapes(schemas, HANDOFF_DEFINITION_FIELDS) ||
    !hasRequiredFields(schemas) ||
    !supportsHandoffValues(
      client,
      schemas.get("v2/ThreadTurnsListResponse.json"),
    )
  ) {
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
