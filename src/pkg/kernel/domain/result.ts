export type Failure<Code extends string> = Readonly<{
  ok: false;
  error: Readonly<{
    code: Code;
    retry: "never" | "safe";
  }>;
}>;

export type Success<Value> = Readonly<{ ok: true; value: Value }>;
export type Result<Value, Code extends string> = Success<Value> | Failure<Code>;

export function success<Value>(value: Value): Success<Value> {
  return { ok: true, value };
}

export function failure<Code extends string>(
  code: Code,
  retry: "never" | "safe" = "never",
): Failure<Code> {
  return { ok: false, error: { code, retry } };
}
