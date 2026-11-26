import type { ShellOutcome } from "./shelloutput";

export type ShellResponse =
  | Readonly<{ ok: true; value: ShellOutcome }>
  | Readonly<{ ok: false; error: Readonly<{ code: string; retry: "never" }> }>;

export function refusal(code: string): ShellResponse {
  return { ok: false, error: { code, retry: "never" } };
}
