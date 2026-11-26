import { fail, validId } from "./check.ts";

export const segmentBytes = 65536;

export type Segment = Readonly<{ text: string; segmentId: string }>;

/**
 * One immutable provider message is one segment. Split only to obey wire byte
 * limits; each piece has a stable segment key, never a DOM index. Pieces are
 * emitted in order as they complete, so a refused key stops the later ones.
 */
export function split(
  id: string,
  text: string,
  emit: (segment: Segment) => void,
): void {
  let part = "",
    partIndex = 0;
  const flush = (): void => {
    if (!part) return;
    const segmentId =
      Buffer.byteLength(text) <= segmentBytes
        ? id
        : `${id}/part/${partIndex++}`;
    if (!validId(segmentId)) fail("chat_browser_segment_id_limit", "unknown");
    emit({ text: part, segmentId });
    part = "";
  };
  let bytes = 0;
  for (const character of text) {
    const width = Buffer.byteLength(character);
    if (bytes + width > segmentBytes) {
      flush();
      bytes = 0;
    }
    part += character;
    bytes += width;
  }
  flush();
}
