// What the driver does with the text a summary turn returned, before the
// checkpoint domain validates it: the JSON parse, and the removal of any
// attachment availability the model claimed but nothing verified.

export type ParsedOutput =
  Readonly<{ ok: true; candidate: unknown }> | Readonly<{ ok: false }>;

export function parseSummaryOutput(
  outputText: string | null | undefined,
): ParsedOutput {
  try {
    return { ok: true, candidate: JSON.parse(outputText ?? "") };
  } catch {
    return { ok: false };
  }
}

export function withoutUnverifiedAttachmentAvailability<
  Content extends {
    attachmentRefs: readonly (object & { availability: string })[];
  },
>(content: Content): Content {
  return {
    ...content,
    attachmentRefs: content.attachmentRefs.map((attachment) => ({
      ...attachment,
      availability: "unavailable",
    })),
  };
}
