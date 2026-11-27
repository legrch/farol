import { z } from "zod";

export const CanonicalTimestampSchema = z.string().refine((value) => {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
});

export const CanonicalAbsolutePathSchema = z.string().refine((value) => {
  if (!value.startsWith("/") || value.includes("\0")) return false;
  if (value === "/") return true;
  if (value.endsWith("/")) return false;
  return value.split("/").every((part, index) => {
    if (index === 0) return part === "";
    return part !== "" && part !== "." && part !== "..";
  });
});

export const IdentifierSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );

// Correlates one issued folder check with its persisted access witness.
export const WorkspaceAccessCheckIdSchema = IdentifierSchema;

export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export const ProductRelativePathSchema = z.string().refine((value) => {
  if (
    value.length === 0 ||
    value.length > 4_096 ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\")
  ) {
    return false;
  }
  return value.split("/").every((part) => {
    if (part === "" || part === "." || part === "..") return false;
    return [...part].every((character) => {
      const code = character.codePointAt(0);
      return code !== undefined && code >= 32 && code !== 127;
    });
  });
});

export const ProductScopeRelativePathSchema = z
  .string()
  .refine(
    (value) =>
      value === "." || ProductRelativePathSchema.safeParse(value).success,
  );

export const ProductSearchPatternSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) =>
    [...value].every((character) => {
      const code = character.codePointAt(0);
      return code !== undefined && code >= 32 && code !== 127;
    }),
  );

export const ProductWorkspaceEntrySchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => {
    const name = value.endsWith("/") ? value.slice(0, -1) : value;
    return (
      name.length > 0 &&
      !name.includes("/") &&
      ProductRelativePathSchema.safeParse(name).success
    );
  });
