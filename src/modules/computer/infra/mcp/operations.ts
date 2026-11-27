import { DEFAULT_READ_WINDOW_BYTES } from "./fileinput";

// The fixed operation each read-only tool asks of the Computer contract. The
// caller supplies only what the tool's schema accepted.

export function listOperation(relativePath: string) {
  return { kind: "workspace.list" as const, relativePath };
}

export function searchOperation(relativePath: string, pattern: string) {
  return { kind: "workspace.search" as const, relativePath, pattern };
}

// A window is asked for when either end is given; the other end defaults, so
// the answer is a page and never mistaken for the whole file.
export function readOperation(
  relativePath: string,
  offset?: number,
  length?: number,
) {
  return {
    kind: "workspace.read" as const,
    relativePath,
    ...(offset === undefined && length === undefined
      ? {}
      : {
          range: {
            offset: offset ?? 0,
            length: length ?? DEFAULT_READ_WINDOW_BYTES,
          },
        }),
  };
}

export function gitOperation(command: "git.status" | "git.head") {
  return {
    kind: "verification.run" as const,
    command,
    relativePath: "." as const,
  };
}
