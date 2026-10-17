import { randomUUID } from "node:crypto";
import { BridgeError, type Client } from "../bridge/client";
import {
  validate,
  type Context,
  type Json,
  type ChatArchivePage,
  type ChatArchiveReply,
} from "../bridge/wire";

// Mechanical private-pipe adapter. Go owns current authority, native custody and
// unconfirmed provenance; this adapter correlates and parses each one-shot read.
export class RecoveryArchiveReader {
  private readonly context: Context;
  constructor(
    private readonly client: Pick<Client, "request">,
    context: Context,
    private readonly namespace:
      "chat.archive" | "chat.retired" = "chat.archive",
  ) {
    if (
      (namespace !== "chat.archive" && namespace !== "chat.retired") ||
      !validate("Context", context)
    )
      throw new BridgeError("refused", "invalid_archive_context");
    this.context = Object.freeze({ ...context });
  }
  private async query(
    method: string,
    input: string,
    output: string,
    body: Json,
  ) {
    if (!validate(input, body))
      throw new BridgeError("refused", "invalid_archive_query");
    const id = randomUUID();
    const outcome = await this.client.request(method, body, {
      id,
      timeoutMs: 8000,
    });
    if (
      !validate("Outcome", outcome) ||
      outcome.requestId !== id ||
      outcome.operationId !== undefined ||
      outcome.context.profileId !== this.context.profileId ||
      outcome.context.backendGeneration !== this.context.backendGeneration
    )
      throw new BridgeError("unknown", "crossed_archive_response");
    if (outcome.status !== "ok")
      throw new BridgeError(
        outcome.status,
        outcome.code ?? "archive_read_unavailable",
      );
    if (outcome.code !== undefined || !validate(output, outcome.data))
      throw new BridgeError("unknown", "invalid_archive_response");
    return structuredClone(outcome.data);
  }
  async list(after: string): Promise<ChatArchivePage> {
    const page = (await this.query(
      `${this.namespace}.list`,
      "ChatArchiveListRequest",
      "ChatArchivePage",
      { after },
    )) as unknown as ChatArchivePage;
    let previous = after;
    for (const entry of page.entries) {
      if (entry.key <= previous)
        throw new BridgeError("unknown", "crossed_archive_page");
      previous = entry.key;
    }
    if (
      page.next !== "" &&
      (page.entries.length !== 32 || page.next !== previous)
    )
      throw new BridgeError("unknown", "invalid_archive_cursor");
    return page;
  }
  async read(key: string, digest: string): Promise<ChatArchiveReply> {
    const reply = (await this.query(
      `${this.namespace}.read`,
      "ChatArchiveReadRequest",
      "ChatArchiveReply",
      { key, digest },
    )) as unknown as ChatArchiveReply;
    if (
      reply.summary.key !== key ||
      reply.summary.digest !== digest ||
      Buffer.byteLength(reply.text, "utf8") !== reply.summary.bytes
    )
      throw new BridgeError("unknown", "crossed_archive_reply");
    return reply;
  }
}
