export function isCanonicalAbsolutePath(value: string): boolean {
  if (!value.startsWith("/") || value.includes("\0")) return false;
  if (value === "/") return true;
  if (value.length > 1 && value.endsWith("/")) return false;
  return value.split("/").every((part, index) => {
    if (index === 0) return part === "";
    return part !== "" && part !== "." && part !== "..";
  });
}

export function isWithin(root: string, candidate: string): boolean {
  if (!isCanonicalAbsolutePath(root) || !isCanonicalAbsolutePath(candidate)) {
    return false;
  }
  if (root === "/") return true;
  return candidate === root || candidate.startsWith(`${root}/`);
}

const exclusionPathComponentCollator = new Intl.Collator("en-US", {
  usage: "search",
  sensitivity: "base",
});

export function comparableWithin(root: string, candidate: string): boolean {
  if (!isCanonicalAbsolutePath(root) || !isCanonicalAbsolutePath(candidate)) {
    return false;
  }
  // The filesystem root contains every absolute path. Splitting it gives
  // ["", ""], which would match nothing: a root-scoped grant would silently
  // drop its exclusions and an exclusion of "/" would deny nothing. The Go
  // twin (authority.ComparableWithin) answers true here as well.
  if (root === "/") return true;
  const rootParts = root.split("/");
  const candidateParts = candidate.split("/");
  return (
    rootParts.length <= candidateParts.length &&
    rootParts.every(
      (part, index) =>
        exclusionPathComponentCollator.compare(
          part,
          candidateParts[index] ?? "",
        ) === 0,
    )
  );
}
