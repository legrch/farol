import { decodedTurnMetadata, record } from "./shape";

// How the provider recognizes a compaction request and the stream it answers
// a streamed one with. It reads the request and builds events; it sends none.

function compactionTrigger(candidate: unknown): boolean {
  return (
    record(candidate) &&
    Object.keys(candidate).length === 1 &&
    candidate.type === "compaction_trigger"
  );
}

// The host's codec decides what counts as compaction metadata; the provider
// hands it in, since a neighbouring module's codec is not this module's to
// import.
export type CompactionMetadataTest = (candidate: unknown) => boolean;

export function streamedCompactionRequestWith(
  isMetadata: CompactionMetadataTest,
  candidate: unknown,
  metadataHeader?: string,
): boolean {
  let headerCompaction = false;
  if (metadataHeader) {
    try {
      headerCompaction = isMetadata(JSON.parse(metadataHeader));
    } catch {
      // An unreadable header is not a recognized compaction declaration.
    }
  }
  return (
    headerCompaction ||
    isMetadata(decodedTurnMetadata(candidate)) ||
    (record(candidate) &&
      Array.isArray(candidate.input) &&
      compactionTrigger(candidate.input.at(-1)))
  );
}

export function compactionMetadataHeader(
  request: Readonly<{ headers: Readonly<Record<string, unknown>> }>,
): string | undefined {
  const value = request.headers["x-codex-turn-metadata"];
  return typeof value === "string" ? value : undefined;
}

// The events of a streamed compaction, in the order they are written.
export function compactionEvents(
  responseId: string,
  model: string,
  item: unknown,
): ReadonlyArray<Readonly<{ event: string; data: Record<string, unknown> }>> {
  return [
    {
      event: "response.created",
      data: {
        type: "response.created",
        response: { id: responseId, model, status: "in_progress", output: [] },
      },
    },
    {
      event: "response.output_item.added",
      data: { type: "response.output_item.added", output_index: 0, item },
    },
    {
      event: "response.output_item.done",
      data: { type: "response.output_item.done", output_index: 0, item },
    },
    {
      event: "response.completed",
      data: {
        type: "response.completed",
        response: {
          id: responseId,
          model,
          status: "completed",
          output: [item],
        },
      },
    },
  ];
}
