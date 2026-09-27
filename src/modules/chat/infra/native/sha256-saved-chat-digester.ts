import { createHash } from "node:crypto";

import type {
  SavedChatDigester,
  SavedChatRequest,
} from "../../app/service/persistent-chatgpt-handoff";

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

export class Sha256SavedChatDigester implements SavedChatDigester {
  utf8Length(value: string): number {
    return Buffer.byteLength(value, "utf8");
  }

  digest(value: string): string {
    return sha256(value);
  }

  requestDigest(request: SavedChatRequest): string {
    return sha256(
      JSON.stringify([request.key, request.title, request.firstMessage]),
    );
  }
}
