import path from "node:path";
import { z } from "zod";

import type { ProductAgentScopeSelection } from "../../modules/chat/contract/product-task";

const absolutePath = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => path.isAbsolute(value) && path.normalize(value) === value);

export const ProductAgentResolvedScopeSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("subtree"), root: absolutePath }),
  z.strictObject({
    mode: z.literal("exact"),
    root: absolutePath,
    paths: z
      .array(absolutePath)
      .min(1)
      .max(32)
      .refine((paths) => new Set(paths).size === paths.length),
  }),
]);

export const ProductAgentResolvedExclusionsSchema = z
  .array(absolutePath)
  .max(32)
  .refine((paths) => new Set(paths).size === paths.length);

export type ProductAgentResolvedScope = z.infer<
  typeof ProductAgentResolvedScopeSchema
>;

export type ResolvedProductAgentScope = Readonly<{
  scope: ProductAgentResolvedScope;
  excludedPaths: string[];
}>;

function within(root: string, candidate: string): boolean {
  return root === "/" || candidate === root || candidate.startsWith(`${root}/`);
}

const pathComponentCollator = new Intl.Collator("en-US", {
  usage: "search",
  sensitivity: "base",
});

function comparableWithin(root: string, candidate: string): boolean {
  const rootParts = root.split("/");
  const candidateParts = candidate.split("/");
  return (
    rootParts.length <= candidateParts.length &&
    rootParts.every(
      (part, index) =>
        pathComponentCollator.compare(part, candidateParts[index] ?? "") === 0,
    )
  );
}

function aliasesConfiguredExclusion(
  excludedPaths: readonly string[],
  candidate: string,
): boolean {
  return excludedPaths.some((excluded) => {
    const comparableOverlap =
      comparableWithin(excluded, candidate) ||
      comparableWithin(candidate, excluded);
    const lexicalOverlap =
      within(excluded, candidate) || within(candidate, excluded);
    return comparableOverlap && !lexicalOverlap;
  });
}

function denied(excludedPaths: readonly string[], candidate: string): boolean {
  return excludedPaths.some((excluded) => within(excluded, candidate));
}

function resolveRelative(root: string, relative: string): string | null {
  const candidate = path.join(root, ...relative.split("/"));
  return absolutePath.safeParse(candidate).success && within(root, candidate)
    ? candidate
    : null;
}

export function productAgentScopeMatchesWorkspace(
  workspaceRoot: string,
  configuredExcludedPaths: readonly string[],
  value: ResolvedProductAgentScope,
): boolean {
  if (
    !absolutePath.safeParse(workspaceRoot).success ||
    !configuredExcludedPaths.every(
      (excluded) =>
        absolutePath.safeParse(excluded).success &&
        within(workspaceRoot, excluded),
    ) ||
    !ProductAgentResolvedScopeSchema.safeParse(value.scope).success ||
    !ProductAgentResolvedExclusionsSchema.safeParse(value.excludedPaths).success
  ) {
    return false;
  }
  const { scope, excludedPaths } = value;
  if (!within(workspaceRoot, scope.root)) return false;
  if (aliasesConfiguredExclusion(configuredExcludedPaths, scope.root)) {
    return false;
  }
  if (scope.mode === "exact") {
    return (
      scope.root === workspaceRoot &&
      excludedPaths.length === 0 &&
      scope.paths.every(
        (candidate) =>
          within(workspaceRoot, candidate) &&
          !denied(configuredExcludedPaths, candidate) &&
          !aliasesConfiguredExclusion(configuredExcludedPaths, candidate),
      )
    );
  }
  return (
    !denied(configuredExcludedPaths, scope.root) &&
    excludedPaths.every(
      (excluded) => within(scope.root, excluded) && excluded !== scope.root,
    )
  );
}

export function resolveProductAgentScope(
  workspaceRoot: string,
  configuredExcludedPaths: readonly string[],
  selection: ProductAgentScopeSelection,
): ResolvedProductAgentScope | null {
  if (!absolutePath.safeParse(workspaceRoot).success) return null;
  const relativeRoot =
    selection.mode === "subtree"
      ? resolveRelative(workspaceRoot, selection.relativeRoot)
      : workspaceRoot;
  if (!relativeRoot) return null;
  const relativePaths =
    selection.mode === "exact"
      ? selection.relativePaths.map((candidate) =>
          resolveRelative(workspaceRoot, candidate),
        )
      : [];
  if (relativePaths.some((candidate) => candidate === null)) return null;
  const excludedPaths =
    selection.mode === "exact"
      ? []
      : selection.excludedPaths.map((candidate) =>
          resolveRelative(workspaceRoot, candidate),
        );
  if (excludedPaths.some((candidate) => candidate === null)) return null;
  const resolved: ResolvedProductAgentScope = {
    scope:
      selection.mode === "exact"
        ? {
            mode: "exact",
            root: workspaceRoot,
            paths: relativePaths as string[],
          }
        : { mode: "subtree", root: relativeRoot },
    excludedPaths: excludedPaths as string[],
  };
  return productAgentScopeMatchesWorkspace(
    workspaceRoot,
    configuredExcludedPaths,
    resolved,
  )
    ? resolved
    : null;
}

export function productAgentInitialPaths(
  scope: ProductAgentResolvedScope,
): readonly string[] {
  return scope.mode === "subtree" ? [scope.root] : [...scope.paths];
}
