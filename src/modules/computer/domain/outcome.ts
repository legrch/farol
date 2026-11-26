import type {
  AuthorityErrorCode,
  AuthorityFailureSource,
  AuthorityResult,
} from "./model";

export function success<Value>(value: Value): AuthorityResult<Value> {
  return { ok: true, value };
}

export function failure<Value = never>(
  code: AuthorityErrorCode,
  source: AuthorityFailureSource,
): AuthorityResult<Value> {
  return { ok: false, error: { code, source, retry: "never" } };
}
