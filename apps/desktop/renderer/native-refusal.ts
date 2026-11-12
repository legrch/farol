import { z } from "zod";

// Diagnostic classes only. Never retain native messages, paths or argv/env.
export const nativeRefusalReasons = [
  "admission_policy",
  "confinement_policy",
  "executable_integrity",
  "workspace_root_identity",
  "cwd_fence",
  "directory_policy",
  "filesystem_policy",
  "runtime_integrity",
  "helper_preflight",
  "unclassified",
] as const;
export const NativeRefusalReasonSchema = z.enum(nativeRefusalReasons);
export type NativeRefusalReason = z.infer<typeof NativeRefusalReasonSchema>;

export function nativeRefusalReason(
  code: unknown,
  value: unknown,
): NativeRefusalReason | undefined {
  if (code !== "PROCESS_NATIVE_REFUSED") return undefined;
  const parsed = NativeRefusalReasonSchema.safeParse(value);
  return parsed.success ? parsed.data : "unclassified";
}

/** Normalize only a diagnostic on an otherwise untrusted JSON envelope. The
 * caller still validates and correlates the entire response before use. */
export function normalizeNativeRefusalResponse(value: unknown): void {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return;
  const result = (value as Record<string, unknown>).result;
  if (result === null || typeof result !== "object" || Array.isArray(result))
    return;
  const out = result as Record<string, unknown>;
  if (out.status === "refused" && out.code === "PROCESS_NATIVE_REFUSED") {
    out.nativeRefusalReason = nativeRefusalReason(
      out.code,
      out.nativeRefusalReason,
    );
  }
}
