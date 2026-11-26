export type JsonRecord = Record<string, unknown>;

export function contractError(code: string): never {
  throw new Error(code);
}

export function record(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function child(value: unknown, ...keys: string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (!record(current) || !(key in current)) return undefined;
    current = current[key];
  }
  return current;
}

export function array(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}
