// Wire form of a stored record: one JSON line, bounded in bytes. Pure; nothing
// here touches the filesystem.

export function serializeRecord(
  value: unknown,
  maximumBytes: number,
  oversizedCode: string,
): string {
  const serialized = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > maximumBytes) {
    throw new Error(oversizedCode);
  }
  return serialized;
}
