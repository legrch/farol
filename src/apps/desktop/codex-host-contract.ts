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
  "v2/TurnSteerParams.json",
  "v2/TurnSteerResponse.json",
  "v2/ThreadReadParams.json",
  "v2/ThreadReadResponse.json",
  "v2/ThreadTurnsListParams.json",
  "v2/ThreadTurnsListResponse.json",
  "v2/ThreadItemsListParams.json",
  "v2/ThreadItemsListResponse.json",
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

function supportsThreadItemsCursor(schema: unknown): boolean {
  const cursor = child(schema, "properties", "cursor");
  if (hasShape(cursor, "string|null")) return true;

  // The consumer sends only null and opaque response strings. Newer hosts
  // also accept item anchors; that alternative must not restrict the strings.
  const annotations = ["description", "title", "default", "$comment"];
  const onlyKeywords = (value: unknown, keywords: readonly string[]) =>
    record(value) &&
    Object.keys(value).every(
      (key) => keywords.includes(key) || annotations.includes(key),
    );
  if (!onlyKeywords(cursor, ["anyOf"])) return false;
  const alternatives = array(child(cursor, "anyOf"));
  if (
    alternatives.length !== 2 ||
    !alternatives.some(
      (part) =>
        onlyKeywords(part, ["$ref"]) &&
        child(part, "$ref") === "#/definitions/ThreadItemsListCursor",
    ) ||
    !alternatives.some(
      (part) => onlyKeywords(part, ["type"]) && child(part, "type") === "null",
    )
  )
    return false;
  const definition = child(schema, "definitions", "ThreadItemsListCursor");
  return (
    onlyKeywords(definition, ["anyOf"]) &&
    array(child(definition, "anyOf")).some(
      (part) =>
        onlyKeywords(part, ["type"]) && child(part, "type") === "string",
    )
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
    ["TurnSteerParams", "threadId", "string"],
    ["TurnSteerParams", "expectedTurnId", "string"],
    ["TurnSteerParams", "input", "array:UserInput"],
    ["TurnSteerParams", "clientUserMessageId", "string|null"],
    ["TurnSteerResponse", "turnId", "string"],
    ["ThreadReadParams", "threadId", "string"],
    ["ThreadReadParams", "includeTurns", "boolean"],
    ["ThreadReadResponse", "thread", "ref:Thread"],
    ["ThreadTurnsListParams", "threadId", "string"],
    ["ThreadTurnsListParams", "cursor", "string|null"],
    ["ThreadTurnsListParams", "limit", "integer|null"],
    ["ThreadTurnsListParams", "itemsView", "nullable-ref:TurnItemsView"],
    ["ThreadTurnsListResponse", "data", "array:Turn"],
    ["ThreadTurnsListResponse", "nextCursor", "string|null"],
    ["ThreadItemsListParams", "threadId", "string"],
    ["ThreadItemsListParams", "turnId", "string|null"],
    ["ThreadItemsListParams", "limit", "integer|null"],
    ["ThreadItemsListResponse", "data", "array:ThreadItemEntry"],
    ["ThreadItemsListResponse", "nextCursor", "string|null"],
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
    ["ThreadReadResponse", "Thread", "name", "string|null"],
    ["ThreadTurnsListResponse", "Turn", "id", "string"],
    ["ThreadTurnsListResponse", "Turn", "status", "ref:TurnStatus"],
    ["ThreadItemsListResponse", "ThreadItemEntry", "turnId", "string"],
    ["ThreadItemsListResponse", "ThreadItemEntry", "item", "ref:ThreadItem"],
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
      child(candidate, "type") === "object" &&
      array(child(candidate, "properties", "method", "enum")).includes(
        method,
      ) &&
      child(candidate, "properties", "method", "type") === "string" &&
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

function supportsSandboxPolicy(schema: unknown): boolean {
  const variants = array(child(schema, "oneOf"));
  const variant = (type: string): unknown =>
    variants.find(
      (candidate) =>
        child(candidate, "type") === "object" &&
        array(child(candidate, "properties", "type", "enum")).includes(type) &&
        child(candidate, "properties", "type", "type") === "string" &&
        hasRequired(candidate, "type"),
    );
  const readOnly = variant("readOnly");
  const workspaceWrite = variant("workspaceWrite");
  return (
    hasShape(child(readOnly, "properties", "networkAccess"), "boolean") &&
    hasShape(child(workspaceWrite, "properties", "networkAccess"), "boolean") &&
    hasShape(
      child(workspaceWrite, "properties", "writableRoots"),
      "array:AbsolutePathBuf",
    )
  );
}

function supportsHandoffValues(
  client: unknown,
  turnsResponse: unknown,
  itemsResponse: unknown,
  threadStartResponse: unknown,
  projectListResponse: unknown,
  threadReadResponse: unknown,
): boolean {
  const definitions = child(client, "definitions");
  const textInput = array(child(definitions, "UserInput", "oneOf")).some(
    (variant) =>
      child(variant, "type") === "object" &&
      array(child(variant, "properties", "type", "enum")).includes("text") &&
      child(variant, "properties", "text", "type") === "string" &&
      hasRequired(variant, "type", "text"),
  );
  const finalAnswer = array(
    child(itemsResponse, "definitions", "ThreadItem", "oneOf"),
  ).some(
    (variant) =>
      array(child(variant, "properties", "type", "enum")).includes(
        "agentMessage",
      ) &&
      hasRequired(variant, "id", "text", "type") &&
      hasShape(child(variant, "properties", "id"), "string") &&
      hasShape(child(variant, "properties", "text"), "string") &&
      hasShape(
        child(variant, "properties", "phase"),
        "nullable-ref:MessagePhase",
      ),
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
    finalAnswer &&
    hasEnumValues(
      child(itemsResponse, "definitions", "MessagePhase"),
      "final_answer",
    ) &&
    supportsSandboxPolicy(child(definitions, "SandboxPolicy")) &&
    supportsSandboxPolicy(
      child(threadStartResponse, "definitions", "SandboxPolicy"),
    ) &&
    [
      definitions,
      child(threadStartResponse, "definitions"),
      child(projectListResponse, "definitions"),
      child(threadReadResponse, "definitions"),
    ].every(
      (source) => child(source, "AbsolutePathBuf", "type") === "string",
    ) &&
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
  ["TurnSteerParams", [], ["threadId", "expectedTurnId", "input"]],
  ["TurnSteerResponse", [], ["turnId"]],
  ["ThreadReadParams", [], ["threadId"]],
  ["ThreadReadResponse", [], ["thread"]],
  ["ThreadReadResponse", ["Thread"], ["id", "projectId", "cwd"]],
  ["ThreadTurnsListParams", [], ["threadId"]],
  ["ThreadTurnsListResponse", [], ["data"]],
  ["ThreadTurnsListResponse", ["Turn"], ["id", "status"]],
  ["ThreadItemsListParams", [], ["threadId"]],
  ["ThreadItemsListResponse", [], ["data"]],
  ["ThreadItemsListResponse", ["ThreadItemEntry"], ["item", "turnId"]],
];

function hasRequiredFields(schemas: ReadonlyMap<string, JsonRecord>): boolean {
  return HANDOFF_REQUIRED.every(([file, definition, names]) => {
    const schema = child(
      schemas.get(`v2/${file}.json`),
      ...(definition.length ? ["definitions", ...definition] : []),
    );
    return child(schema, "type") === "object" && hasRequired(schema, ...names);
  });
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
        ["thread/items/list", "ThreadItemsListParams"],
        ["turn/start", "TurnStartParams"],
        ["turn/steer", "TurnSteerParams"],
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
    !supportsThreadItemsCursor(schemas.get("v2/ThreadItemsListParams.json")) ||
    !hasFieldShapes(schemas, HANDOFF_DEFINITION_FIELDS) ||
    !hasRequiredFields(schemas) ||
    !supportsHandoffValues(
      client,
      schemas.get("v2/ThreadTurnsListResponse.json"),
      schemas.get("v2/ThreadItemsListResponse.json"),
      schemas.get("v2/ThreadStartResponse.json"),
      schemas.get("v2/ProjectListResponse.json"),
      schemas.get("v2/ThreadReadResponse.json"),
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
