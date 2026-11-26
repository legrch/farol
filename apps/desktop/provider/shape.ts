// The content-free shape of a Codex provider request: which kinds of input,
// roles, tools and control markers it carried, never their values. The
// provider records these for diagnostics and reads the decoded turn metadata
// when it decides whether a request is a compaction.

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function inputKinds(candidate: unknown): string[] {
  if (!record(candidate)) return [];
  if (typeof candidate.input === "string") return ["string"];
  if (!Array.isArray(candidate.input)) return [];
  return candidate.input.map((item) =>
    record(item) && typeof item.type === "string" ? item.type : "unknown",
  );
}

export function inputRoles(candidate: unknown): string[] {
  if (!record(candidate) || !Array.isArray(candidate.input)) return [];
  return candidate.input.map((item) =>
    record(item) && typeof item.role === "string" ? item.role : "none",
  );
}

export function inputContentKinds(candidate: unknown): string[] {
  if (!record(candidate) || !Array.isArray(candidate.input)) return [];
  return candidate.input.flatMap((item, itemIndex) => {
    if (!record(item) || !Array.isArray(item.content)) return [];
    return item.content.map((part, partIndex) => {
      const kind =
        record(part) && typeof part.type === "string" ? part.type : "unknown";
      return `${itemIndex}:${partIndex}:${kind}`;
    });
  });
}

export function toolNames(candidate: unknown): string[] {
  if (!record(candidate) || !Array.isArray(candidate.tools)) return [];
  return candidate.tools.map((tool) => {
    if (!record(tool)) return "unknown";
    if (typeof tool.name === "string") return tool.name;
    return typeof tool.type === "string" ? tool.type : "unknown";
  });
}

export function metadataKeys(candidate: unknown): string[] {
  if (!record(candidate) || !record(candidate.client_metadata)) return [];
  return Object.keys(candidate.client_metadata).sort();
}

export function decodedTurnMetadata(
  candidate: unknown,
): Record<string, unknown> | null {
  if (!record(candidate) || !record(candidate.client_metadata)) return null;
  const raw = candidate.client_metadata["x-codex-turn-metadata"];
  let decoded: unknown = raw;
  if (typeof raw === "string") {
    try {
      decoded = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }
  return record(decoded) ? decoded : null;
}

export function compactionMarkerKind(candidate: unknown): string {
  const metadata = decodedTurnMetadata(candidate);
  if (!metadata || !("compaction" in metadata)) return "absent";
  if (metadata.compaction === true) return "true";
  if (metadata.compaction === false) return "false";
  return typeof metadata.compaction;
}

export function requestKindCompaction(candidate: unknown): boolean {
  return decodedTurnMetadata(candidate)?.request_kind === "compaction";
}

function controlShape(value: unknown): string[] {
  if (
    typeof value === "string" &&
    /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/u.test(value)
  ) {
    return [`string:${value}`];
  }
  if (!record(value)) return [Array.isArray(value) ? "array" : typeof value];
  return Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => {
      if (typeof entry === "boolean") return `${key}:boolean:${entry}`;
      if (
        typeof entry === "string" &&
        [
          "implementation",
          "kind",
          "mode",
          "name",
          "phase",
          "reason",
          "request_type",
          "strategy",
          "trigger",
          "type",
        ].includes(key) &&
        /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/u.test(entry)
      ) {
        return `${key}:string:${entry}`;
      }
      if (record(entry)) {
        return `${key}:object:${Object.keys(entry).sort().join(",")}`;
      }
      return `${key}:${Array.isArray(entry) ? "array" : typeof entry}`;
    });
}

export function compactionMarkerShape(candidate: unknown): string[] {
  return controlShape(decodedTurnMetadata(candidate)?.compaction);
}

export function requestKindShape(candidate: unknown): string[] {
  return controlShape(decodedTurnMetadata(candidate)?.request_kind);
}

export function turnMetadataKeys(candidate: unknown): string[] {
  const decoded = decodedTurnMetadata(candidate);
  return decoded ? Object.keys(decoded).sort() : [];
}
