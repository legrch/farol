import { maxFrameBytes, validUnicode } from "./wire.ts";

export function frame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length === 0 || body.length > maxFrameBytes)
    throw Error("invalid frame size");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

// Admission occurs at each header before body allocation; no aggregate chunk copies.
export class Decoder {
  private header = Buffer.alloc(4);
  private headerSize = 0;
  private body: Buffer | undefined;
  private bodySize = 0;
  push(chunk: Buffer, accept: (value: unknown) => void): void {
    let offset = 0;
    while (offset < chunk.length) {
      if (!this.body) {
        const count = Math.min(4 - this.headerSize, chunk.length - offset);
        chunk.copy(this.header, this.headerSize, offset, offset + count);
        this.headerSize += count;
        offset += count;
        if (this.headerSize < 4) continue;
        const size = this.header.readUInt32BE();
        if (size === 0 || size > maxFrameBytes)
          throw Error("invalid frame size");
        this.body = Buffer.alloc(size);
        this.bodySize = 0;
      }
      const count = Math.min(
        this.body.length - this.bodySize,
        chunk.length - offset,
      );
      chunk.copy(this.body, this.bodySize, offset, offset + count);
      this.bodySize += count;
      offset += count;
      if (this.bodySize === this.body.length) {
        const bytes = this.body;
        this.body = undefined;
        this.headerSize = 0;
        this.bodySize = 0;
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        accept(parseJSON(text));
      }
    }
  }
  finish(): void {
    if (this.headerSize || this.body) throw Error("truncated frame");
  }
}

// JSON.parse alone discards duplicate keys. This bounded token pass rejects them.
export function parseJSON(text: string): unknown {
  let pos = 0;
  const space = (): void => {
    while (/\s/u.test(text[pos] ?? "") && pos < text.length) pos++;
  };
  const string = (): string => {
    const start = pos++;
    let escaped = false;
    while (pos < text.length) {
      const char = text[pos++];
      if (!escaped && char === '"') {
        const value = JSON.parse(text.slice(start, pos)) as string;
        if (!validUnicode(value)) throw Error("invalid Unicode string");
        return value;
      }
      if (!escaped && char === "\\") escaped = true;
      else escaped = false;
    }
    throw Error("invalid JSON string");
  };
  const value = (depth: number): void => {
    if (depth > 32) throw Error("JSON depth exceeded");
    space();
    const char = text[pos];
    if (char === '"') {
      string();
      return;
    }
    if (char === "{" || char === "[") {
      const object = char === "{";
      pos++;
      space();
      const end = object ? "}" : "]";
      const keys = new Set<string>();
      if (text[pos] === end) {
        pos++;
        return;
      }
      while (pos < text.length) {
        if (object) {
          space();
          if (text[pos] !== '"') throw Error("invalid JSON key");
          const key = string();
          if (keys.has(key)) throw Error("duplicate JSON key");
          keys.add(key);
          space();
          if (text[pos++] !== ":") throw Error("invalid JSON object");
        }
        value(depth + 1);
        space();
        const next = text[pos++];
        if (next === end) return;
        if (next !== ",") throw Error("invalid JSON container");
      }
      throw Error("truncated JSON");
    }
    const token =
      /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(
        text.slice(pos),
      )?.[0];
    if (!token) throw Error("invalid JSON value");
    pos += token.length;
  };
  value(0);
  space();
  if (pos !== text.length) throw Error("trailing JSON");
  return JSON.parse(text) as unknown;
}
