import { createHash } from "node:crypto";
import { z } from "zod";

const MAX_DESCRIPTOR_BYTES = 256 * 1_024;
const MAX_SCHEMA_DEPTH = 32;
const MAX_SCHEMA_NODES = 4_096;
const MAX_TOOL_COUNT = 512;
const MAX_ARGUMENT_BYTES = 64 * 1_024;
const TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/u;

const schemaKeywords = new Set([
  "$schema",
  "$ref",
  "$defs",
  "definitions",
  "$id",
  "id",
  "$comment",
  "$anchor",
  "$vocabulary",
  "type",
  "enum",
  "const",
  "anyOf",
  "oneOf",
  "allOf",
  "not",
  "properties",
  "required",
  "additionalProperties",
  "patternProperties",
  "propertyNames",
  "minProperties",
  "maxProperties",
  "items",
  "prefixItems",
  "additionalItems",
  "minItems",
  "maxItems",
  "uniqueItems",
  "contains",
  "minContains",
  "maxContains",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "nullable",
  "title",
  "description",
  "default",
  "examples",
  "readOnly",
  "writeOnly",
  "deprecated",
]);

type ToolDescriptor = Readonly<{
  name: string;
  namespace: string | null;
  description: string | null;
  parameters: unknown;
  validator: z.ZodType;
}>;

export type CodexNativeToolInventoryEntry = Readonly<{
  name: string;
  namespace: string | null;
}>;

export type CodexNativeToolCatalogue = Readonly<{
  fingerprint: string;
  tools: Readonly<{
    name: string;
    namespace: string | null;
    description: string | null;
    parameters: unknown;
  }>[];
  unsupported: Readonly<{
    type: string;
    name: string | null;
  }>[];
}>;

export type CodexNativeToolRequest = Readonly<{
  name: string;
  namespace?: string;
  arguments: Readonly<Record<string, unknown>>;
}>;

export type ResolvedCodexNativeToolCall = Readonly<{
  name: string;
  namespace: string | null;
  arguments: Readonly<Record<string, unknown>>;
  encodedArguments: string;
}>;

function registryError(code: string): never {
  throw new Error(code);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function canonicalJson(value: unknown): string {
  const visit = (candidate: unknown): string => {
    if (candidate === null) return "null";
    if (typeof candidate === "string") return JSON.stringify(candidate);
    if (typeof candidate === "boolean") return candidate ? "true" : "false";
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) registryError("CODEX_TOOL_JSON_INVALID");
      return JSON.stringify(candidate);
    }
    if (Array.isArray(candidate)) {
      return `[${candidate.map((item) => visit(item)).join(",")}]`;
    }
    if (!record(candidate)) registryError("CODEX_TOOL_JSON_INVALID");
    return `{${Object.keys(candidate)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${visit(candidate[key])}`)
      .join(",")}}`;
  };
  return visit(value);
}

function inspectSchema(schema: unknown): void {
  let nodes = 0;
  const visit = (candidate: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_SCHEMA_NODES || depth > MAX_SCHEMA_DEPTH) {
      registryError("CODEX_TOOL_SCHEMA_UNSUPPORTED");
    }
    if (typeof candidate === "boolean") return;
    if (!record(candidate)) registryError("CODEX_TOOL_SCHEMA_INVALID");
    for (const key of Object.keys(candidate)) {
      if (!schemaKeywords.has(key)) {
        registryError("CODEX_TOOL_SCHEMA_UNSUPPORTED");
      }
    }
    const reference = candidate.$ref;
    if (
      reference !== undefined &&
      (typeof reference !== "string" || !reference.startsWith("#/"))
    ) {
      registryError("CODEX_TOOL_SCHEMA_UNSUPPORTED");
    }
    const pattern = candidate.pattern;
    if (typeof pattern === "string" && pattern.length > 1_024) {
      registryError("CODEX_TOOL_SCHEMA_UNSUPPORTED");
    }
    for (const key of [
      "not",
      "propertyNames",
      "additionalProperties",
      "items",
      "additionalItems",
      "contains",
    ]) {
      const nested = candidate[key];
      if (nested !== undefined) visit(nested, depth + 1);
    }
    for (const key of ["anyOf", "oneOf", "allOf", "prefixItems"]) {
      const nested = candidate[key];
      if (nested === undefined) continue;
      if (!Array.isArray(nested)) registryError("CODEX_TOOL_SCHEMA_INVALID");
      for (const item of nested) visit(item, depth + 1);
    }
    for (const key of [
      "properties",
      "patternProperties",
      "$defs",
      "definitions",
    ]) {
      const nested = candidate[key];
      if (nested === undefined) continue;
      if (!record(nested)) registryError("CODEX_TOOL_SCHEMA_INVALID");
      for (const item of Object.values(nested)) visit(item, depth + 1);
    }
  };
  visit(schema, 0);
}

function compile(parameters: unknown): z.ZodType {
  const encoded = canonicalJson(parameters);
  if (Buffer.byteLength(encoded) > MAX_DESCRIPTOR_BYTES) {
    registryError("CODEX_TOOL_SCHEMA_TOO_LARGE");
  }
  inspectSchema(parameters);
  try {
    return z.fromJSONSchema(parameters as never, { defaultTarget: "draft-7" });
  } catch {
    registryError("CODEX_TOOL_SCHEMA_UNSUPPORTED");
  }
}

function identity(namespace: string | null, name: string): string {
  return `${namespace ?? ""}\0${name}`;
}

function descriptor(
  raw: Record<string, unknown>,
  namespace: string | null,
): ToolDescriptor {
  if (
    raw.type !== "function" ||
    typeof raw.name !== "string" ||
    !TOOL_NAME.test(raw.name) ||
    (raw.description !== undefined &&
      (typeof raw.description !== "string" ||
        raw.description.length > 8_192)) ||
    !(record(raw.parameters) || typeof raw.parameters === "boolean") ||
    (raw.strict !== undefined && typeof raw.strict !== "boolean")
  ) {
    registryError("CODEX_TOOL_DESCRIPTOR_INVALID");
  }
  return {
    name: raw.name,
    namespace,
    description: typeof raw.description === "string" ? raw.description : null,
    parameters: structuredClone(raw.parameters),
    validator: compile(raw.parameters),
  };
}

export class CodexNativeToolRegistry {
  private constructor(
    readonly fingerprint: string,
    private readonly descriptors: ReadonlyMap<string, ToolDescriptor>,
    private readonly unsupported: readonly Readonly<{
      type: string;
      name: string | null;
    }>[],
  ) {}

  static parse(tools: readonly unknown[]): CodexNativeToolRegistry {
    if (tools.length > MAX_TOOL_COUNT) {
      registryError("CODEX_TOOL_CATALOGUE_INVALID");
    }
    const encoded = canonicalJson(tools);
    if (Buffer.byteLength(encoded) > MAX_DESCRIPTOR_BYTES) {
      registryError("CODEX_TOOL_CATALOGUE_TOO_LARGE");
    }
    const descriptors = new Map<string, ToolDescriptor>();
    const unsupported: Readonly<{ type: string; name: string | null }>[] = [];
    let count = 0;
    const add = (candidate: ToolDescriptor): void => {
      count += 1;
      const key = identity(candidate.namespace, candidate.name);
      if (count > MAX_TOOL_COUNT || descriptors.has(key)) {
        registryError("CODEX_TOOL_CATALOGUE_INVALID");
      }
      descriptors.set(key, candidate);
    };
    for (const entry of tools) {
      if (!record(entry)) registryError("CODEX_TOOL_DESCRIPTOR_INVALID");
      if (entry.type === "function") {
        add(descriptor(entry, null));
        continue;
      }
      if (entry.type !== "namespace") {
        if (
          typeof entry.type !== "string" ||
          !TOOL_NAME.test(entry.type) ||
          (entry.name !== undefined &&
            (typeof entry.name !== "string" || !TOOL_NAME.test(entry.name)))
        ) {
          registryError("CODEX_TOOL_DESCRIPTOR_INVALID");
        }
        unsupported.push({
          type: entry.type,
          name: typeof entry.name === "string" ? entry.name : null,
        });
        continue;
      }
      if (
        typeof entry.name !== "string" ||
        !TOOL_NAME.test(entry.name) ||
        !Array.isArray(entry.tools) ||
        entry.tools.length < 1
      ) {
        registryError("CODEX_TOOL_DESCRIPTOR_INVALID");
      }
      for (const child of entry.tools) {
        if (!record(child)) registryError("CODEX_TOOL_DESCRIPTOR_INVALID");
        add(descriptor(child, entry.name));
      }
    }
    return new CodexNativeToolRegistry(
      createHash("sha256").update(encoded).digest("hex"),
      descriptors,
      unsupported,
    );
  }

  inventory(): readonly CodexNativeToolInventoryEntry[] {
    return [...this.descriptors.values()].map(({ name, namespace }) => ({
      name,
      namespace,
    }));
  }

  describe(): CodexNativeToolCatalogue {
    return {
      fingerprint: this.fingerprint,
      tools: [...this.descriptors.values()].map(
        ({ name, namespace, description, parameters }) => ({
          name,
          namespace,
          description,
          parameters: structuredClone(parameters),
        }),
      ),
      unsupported: this.unsupported.map((entry) => ({ ...entry })),
    };
  }

  resolve(request: CodexNativeToolRequest): ResolvedCodexNativeToolCall {
    const namespace = request.namespace ?? null;
    if (
      !TOOL_NAME.test(request.name) ||
      (namespace !== null && !TOOL_NAME.test(namespace)) ||
      !record(request.arguments)
    ) {
      registryError("CODEX_TOOL_CALL_INVALID");
    }
    const candidate = this.descriptors.get(identity(namespace, request.name));
    if (!candidate) registryError("CODEX_TOOL_NOT_ADVERTISED");
    const encodedArguments = canonicalJson(request.arguments);
    if (Buffer.byteLength(encodedArguments) > MAX_ARGUMENT_BYTES) {
      registryError("CODEX_TOOL_ARGUMENTS_TOO_LARGE");
    }
    const parsed = candidate.validator.safeParse(request.arguments);
    if (!parsed.success) registryError("CODEX_TOOL_ARGUMENTS_INVALID");
    return {
      name: candidate.name,
      namespace: candidate.namespace,
      arguments: structuredClone(request.arguments),
      encodedArguments,
    };
  }
}
