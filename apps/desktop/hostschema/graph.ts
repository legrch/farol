import { isDeepStrictEqual } from "node:util";
import { array, child, record } from "./json";

export function hasRequestMethod(
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
