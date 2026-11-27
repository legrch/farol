// The one place that decides whether an absolute path lies inside another.
//
// Hand-rolled `candidate.startsWith(`${root}/`)` checks are wrong at the
// filesystem root: the prefix becomes `//`, which no canonical path carries,
// so a root-scoped workspace contained nothing. Splitting `/` on `/` fails the
// same way (it gives ["", ""]). Every containment test on a workspace root, a
// scope or an exclusion goes through here so that `/` is handled once.
//
// Two relations, which differ on purpose:
//   - `isWithin` is exact: case and Unicode form matter. It decides what a
//     grant POSITIVELY contains and must never broaden one.
//   - `comparableWithin` compares components case-insensitively (en-US base
//     sensitivity), the way macOS volumes do. It decides DENIALS, where an
//     alias of a denied name must be denied too.
// The `*Lexically` forms skip the canonical-path check, for a caller that
// already validated both paths against its own, looser schema and must keep
// that behaviour for every non-root input.

export function isCanonicalAbsolutePath(value: string): boolean {
  if (!value.startsWith("/") || value.includes("\0")) return false;
  if (value === "/") return true;
  if (value.length > 1 && value.endsWith("/")) return false;
  return value.split("/").every((part, index) => {
    if (index === 0) return part === "";
    return part !== "" && part !== "." && part !== "..";
  });
}

export function containsLexically(root: string, candidate: string): boolean {
  if (root === "/") return true;
  return candidate === root || candidate.startsWith(`${root}/`);
}

export function isWithin(root: string, candidate: string): boolean {
  if (!isCanonicalAbsolutePath(root) || !isCanonicalAbsolutePath(candidate)) {
    return false;
  }
  return containsLexically(root, candidate);
}

const componentCollator = new Intl.Collator("en-US", {
  usage: "search",
  sensitivity: "base",
});

export function comparableContainsLexically(
  root: string,
  candidate: string,
): boolean {
  if (root === "/") return true;
  const rootParts = root.split("/");
  const candidateParts = candidate.split("/");
  return (
    rootParts.length <= candidateParts.length &&
    rootParts.every(
      (part, index) =>
        componentCollator.compare(part, candidateParts[index] ?? "") === 0,
    )
  );
}

export function comparableWithin(root: string, candidate: string): boolean {
  if (!isCanonicalAbsolutePath(root) || !isCanonicalAbsolutePath(candidate)) {
    return false;
  }
  return comparableContainsLexically(root, candidate);
}

// The part of `candidate` below `root`, or "." for the root itself. Slicing
// `root.length + 1` is wrong for `/`, whose own trailing slash is its prefix.
export function relativeBelow(root: string, candidate: string): string | null {
  if (candidate === root) return ".";
  if (!containsLexically(root, candidate)) return null;
  return candidate.slice(root === "/" ? 1 : root.length + 1);
}
