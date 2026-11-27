import { hasRequestMethod } from "./graph";
import { array, child, record, type JsonRecord } from "./json";
import {
  hasEnumValues,
  hasFieldShapes,
  hasRequired,
  hasShape,
  type SchemaField,
} from "./shape";

export const HANDOFF_SCHEMA_FILES = [
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

export function supportsHandoff(
  client: unknown,
  schemas: ReadonlyMap<string, JsonRecord>,
): boolean {
  return (
    (
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
    ) &&
    hasFieldShapes(schemas, HANDOFF_FIELDS) &&
    supportsThreadItemsCursor(schemas.get("v2/ThreadItemsListParams.json")) &&
    hasFieldShapes(schemas, HANDOFF_DEFINITION_FIELDS) &&
    hasRequiredFields(schemas) &&
    supportsHandoffValues(
      client,
      schemas.get("v2/ThreadTurnsListResponse.json"),
      schemas.get("v2/ThreadItemsListResponse.json"),
      schemas.get("v2/ThreadStartResponse.json"),
      schemas.get("v2/ProjectListResponse.json"),
      schemas.get("v2/ThreadReadResponse.json"),
    )
  );
}
