import { array, child, record, type JsonRecord } from "./json";

export function hasMethod(schema: unknown, method: string): boolean {
  return array(child(schema, "oneOf")).some((candidate) =>
    array(child(candidate, "properties", "method", "enum")).includes(method),
  );
}

export function hasThreadItem(schema: unknown, type: string): boolean {
  return array(child(schema, "definitions", "ThreadItem", "oneOf")).some(
    (candidate) =>
      array(child(candidate, "properties", "type", "enum")).includes(type),
  );
}

export type SchemaField = Readonly<{
  schema: string;
  path: readonly string[];
  shape: string;
}>;

export function hasShape(schema: unknown, shape: string): boolean {
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

export function hasFieldShapes(
  schemas: ReadonlyMap<string, JsonRecord>,
  fields: readonly SchemaField[],
): boolean {
  return fields.every(({ schema, path: fieldPath, shape }) =>
    hasShape(child(schemas.get(schema), ...fieldPath), shape),
  );
}

export function hasEnumValues(schema: unknown, ...values: string[]): boolean {
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

export function hasRequired(schema: unknown, ...names: string[]): boolean {
  return names.every((name) => array(child(schema, "required")).includes(name));
}
