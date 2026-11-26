import path from "node:path";

export function plainPath(value: string): boolean {
  return (
    path.isAbsolute(value) &&
    path.normalize(value) === value &&
    value !== "/" &&
    value.length <= 4_096 &&
    !/[\0\n\r"\\]/u.test(value)
  );
}

export function validDeniedPath(relative: string): boolean {
  return (
    relative.length > 0 &&
    !relative.startsWith("/") &&
    !relative.endsWith("/") &&
    !relative.includes("\\") &&
    relative
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}

// A repository-relative path this route is willing to name in a request or
// render in a result: no NUL, CR, LF or backslash, no absolute or traversal
// shape. Git itself admits more into an index (a backslash, a newline); such
// a path is refused as `WORKSPACE_TRACKED_PATH_UNSUPPORTED` rather than
// smuggled through a snapshot request or a rendered line.
export function validTrackedPath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 4_096 &&
    !value.startsWith("/") &&
    !/[\0\r\n\\]/u.test(value) &&
    path.normalize(value) === value &&
    value
      .split("/")
      .every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

// One path component, folded the way the helper's `_comparable` folds it
// (NFC, then a case fold): macOS volumes compare names case- and
// normalisation-insensitively, so `Private/x` and a decomposed `privé/x`
// name the same objects as `private/x` and `privé/x`. Folding here means a
// tracked path that is a case or normalisation variant of a denied prefix is
// excluded on this side before it is ever named to the helper, which would
// refuse it (`SNAPSHOT_PATH_REFUSED` -> `WORKSPACE_PATH_REFUSED`) -- the
// same decision, reached first where it is cheapest. `toUpperCase` then
// `toLowerCase` is the closest full case fold JavaScript offers (it maps `ß`
// to `ss` and a final sigma to `σ` as Python's `casefold` does).
function comparableSegment(segment: string): string {
  return segment.normalize("NFC").toUpperCase().toLowerCase();
}

export function isUnderAnyPrefix(
  relativePath: string,
  prefixes: readonly string[],
): boolean {
  const segments = relativePath.split("/").map(comparableSegment);
  return prefixes.some((prefix) => {
    const prefixSegments = prefix.split("/").map(comparableSegment);
    return (
      prefixSegments.length <= segments.length &&
      prefixSegments.every((segment, index) => segments[index] === segment)
    );
  });
}
