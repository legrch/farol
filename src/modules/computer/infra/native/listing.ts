import { TextDecoder } from "node:util";

import { validTrackedPath } from "./paths";

// One `git ls-files -z --stage` record: `<mode> <object> <stage>\t<path>`.
const TRACKED_RECORD =
  /^([0-7]{6}) (?:[0-9a-f]{40}|[0-9a-f]{64}) [0-3]\t([\s\S]+)$/u;
const GITLINK_MODE = "160000";

export type TrackedListing =
  | Readonly<{ kind: "ok"; paths: readonly string[] }>
  | Readonly<{ kind: "malformed" }>
  | Readonly<{ kind: "unsupported-path" }>;

// Splits `git ls-files -z --stage` output into validated,
// repository-relative tracked paths. `-z` NUL-terminates every record
// including the last, so a well-formed payload's final split segment is
// always empty. A gitlink (mode 160000, a submodule's commit) is dropped: it
// is not a file in this tree and the fixed status ignores submodules anyway.
// An unmerged path appears once per stage and is kept once. Output that is
// not a well-formed listing is `malformed`; a well-formed record naming a
// path this route will not carry is `unsupported-path`; neither is ever
// reinterpreted as "nothing tracked".
export function parseTrackedListing(stdout: Buffer): TrackedListing {
  if (stdout.length === 0) return { kind: "ok", paths: [] };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(stdout);
  } catch {
    return { kind: "malformed" };
  }
  const fields = text.split("\0");
  if (fields.length < 2 || fields[fields.length - 1] !== "") {
    return { kind: "malformed" };
  }
  const paths = new Set<string>();
  for (const field of fields.slice(0, -1)) {
    const match = TRACKED_RECORD.exec(field);
    const mode = match?.[1];
    const trackedPath = match?.[2];
    if (mode === undefined || trackedPath === undefined) {
      return { kind: "malformed" };
    }
    if (mode === GITLINK_MODE) continue;
    if (!validTrackedPath(trackedPath)) return { kind: "unsupported-path" };
    paths.add(trackedPath);
  }
  return { kind: "ok", paths: [...paths] };
}
