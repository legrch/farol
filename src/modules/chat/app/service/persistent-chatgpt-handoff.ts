/** A saved ChatGPT conversation is distinct from a Codex task and Consult. */
export type SavedChatRequest = Readonly<{
  key: string;
  title: string;
  firstMessage: string;
}>;

export type SavedChatRecord = Readonly<{
  requestDigest: string;
  firstMessageDigest: string;
  requestedTitleDigest: string;
  phase: "reserved" | "send_intent" | "candidate" | "verified" | "refused";
  conversationUrl?: string | undefined;
  titleVerified?: boolean | undefined;
  refusalCode?: string | undefined;
}>;

export type SavedChatResult =
  | Readonly<{
      status: "verified";
      dispatchId: string;
      conversationUrl: string;
      titleVerified: boolean;
    }>
  | Readonly<{ status: "refused"; code: string; dispatchId: string }>
  | Readonly<{ status: "outcome_unknown"; dispatchId: string }>
  | Readonly<{ status: "unknown" }>;

export interface SavedChatDigester {
  utf8Length(value: string): number;
  digest(value: string): string;
  requestDigest(request: SavedChatRequest): string;
}

export interface SavedChatJournal {
  /** Only the new reservation owner may progress toward the first send. */
  reserve(key: string, record: SavedChatRecord): Promise<"new" | "existing">;
  read(key: string): Promise<SavedChatRecord | null>;
  /** Write-once stage transitions; a lost acknowledgement stays unknown. */
  markSendIntent(key: string, requestDigest: string): Promise<boolean>;
  recordCandidate(
    key: string,
    requestDigest: string,
    url: string,
  ): Promise<boolean>;
  recordVerified(
    key: string,
    requestDigest: string,
    titleVerified: boolean,
  ): Promise<boolean>;
  recordRefused(
    key: string,
    requestDigest: string,
    code: string,
  ): Promise<boolean>;
}

export interface SavedChatBrowser {
  /** Own isolated signed-in, normal, empty surface; no provider effect. */
  prepare(): Promise<
    "ready" | "sign_in_required" | "not_normal_empty" | "unavailable"
  >;
  /** Dispose a prepared surface if durable send admission cannot be recorded. */
  closePrepared?(): Promise<void>;
  /** Checks inserted bytes and crosses at most one Send boundary. */
  sendOnce(
    message: string,
    digest: string,
  ): Promise<
    | Readonly<{ status: "candidate"; conversationUrl: string }>
    | Readonly<{ status: "not_sent"; code: string }>
    | Readonly<{ status: "outcome_unknown" }>
  >;
  /** New read-only helper after the sending helper has exited. */
  reopen(
    conversationUrl: string,
    firstMessageDigest: string,
    requestedTitleDigest: string,
  ): Promise<
    | Readonly<{ status: "verified"; titleVerified: boolean }>
    | Readonly<{ status: "unverified" }>
  >;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

/** No URL supplied by the caller is ever used for a browser navigation. */
export class PersistentChatGptHandoff {
  constructor(
    private readonly journal: SavedChatJournal,
    private readonly browser: SavedChatBrowser,
    private readonly digester: SavedChatDigester,
    private readonly canonicalUrl: (url: string) => string | null,
  ) {}

  async create(request: SavedChatRequest): Promise<SavedChatResult> {
    const firstMessage = request.firstMessage.replace(/\r\n?/gu, "\n");
    if (
      !UUID.test(request.key) ||
      request.title.length === 0 ||
      request.title.length > 80 ||
      /[\r\n\x00-\x1f\x7f]/u.test(request.title) ||
      firstMessage.length === 0 ||
      this.digester.utf8Length(firstMessage) > 8192
    )
      return {
        status: "refused",
        code: "SAVED_CHAT_INPUT_INVALID",
        dispatchId: request.key,
      };
    const requestDigest = this.digester.requestDigest({
      ...request,
      firstMessage,
    });
    const firstMessageDigest = this.digester.digest(firstMessage);
    const requestedTitleDigest = this.digester.digest(request.title);
    if (
      !SHA256.test(requestDigest) ||
      !SHA256.test(firstMessageDigest) ||
      !SHA256.test(requestedTitleDigest)
    )
      return {
        status: "refused",
        code: "SAVED_CHAT_DIGEST_INVALID",
        dispatchId: request.key,
      };
    const initial: SavedChatRecord = {
      requestDigest,
      firstMessageDigest,
      requestedTitleDigest,
      phase: "reserved",
    };
    try {
      const ownership = await this.journal.reserve(request.key, initial);
      if (ownership === "existing") {
        const existing = await this.journal.read(request.key);
        if (existing?.requestDigest !== requestDigest)
          return {
            status: "refused",
            code: "SAVED_CHAT_KEY_CONFLICT",
            dispatchId: request.key,
          };
        return this.project(request.key, existing);
      }
    } catch {
      return { status: "outcome_unknown", dispatchId: request.key };
    }
    // A reservation exists before any browser surface is opened. Even a
    // pre-effect crash is not replayed automatically under the same key.
    let readiness: Awaited<ReturnType<SavedChatBrowser["prepare"]>>;
    try {
      readiness = await this.browser.prepare();
    } catch {
      return { status: "outcome_unknown", dispatchId: request.key };
    }
    if (readiness !== "ready") {
      const code =
        readiness === "sign_in_required"
          ? "SAVED_CHAT_SIGN_IN_REQUIRED"
          : readiness === "not_normal_empty"
            ? "SAVED_CHAT_NORMAL_EMPTY_REQUIRED"
            : "SAVED_CHAT_BROWSER_UNAVAILABLE";
      try {
        if (await this.journal.recordRefused(request.key, requestDigest, code))
          return { status: "refused", code, dispatchId: request.key };
      } catch {
        // A refused preflight with an uncertain local receipt stays unknown.
      }
      return { status: "outcome_unknown", dispatchId: request.key };
    }
    try {
      if (!(await this.journal.markSendIntent(request.key, requestDigest))) {
        try {
          await this.browser.closePrepared?.();
        } catch {
          // The durable intent did not publish; cleanup cannot authorize Send.
        }
        return { status: "outcome_unknown", dispatchId: request.key };
      }
    } catch {
      try {
        await this.browser.closePrepared?.();
      } catch {
        // A failed disposal does not make an uncertain receipt retryable.
      }
      return { status: "outcome_unknown", dispatchId: request.key };
    }
    let sent: Awaited<ReturnType<SavedChatBrowser["sendOnce"]>>;
    try {
      sent = await this.browser.sendOnce(firstMessage, firstMessageDigest);
    } catch {
      return { status: "outcome_unknown", dispatchId: request.key };
    }
    if (!sent || typeof sent !== "object" || sent.status !== "candidate")
      return { status: "outcome_unknown", dispatchId: request.key };
    if (typeof sent.conversationUrl !== "string")
      return { status: "outcome_unknown", dispatchId: request.key };
    const conversationUrl = this.canonicalUrl(sent.conversationUrl);
    if (conversationUrl === null || conversationUrl !== sent.conversationUrl)
      return { status: "outcome_unknown", dispatchId: request.key };
    try {
      if (
        !(await this.journal.recordCandidate(
          request.key,
          requestDigest,
          conversationUrl,
        ))
      )
        return { status: "outcome_unknown", dispatchId: request.key };
    } catch {
      return { status: "outcome_unknown", dispatchId: request.key };
    }
    return this.verifyRecorded(
      request.key,
      requestDigest,
      firstMessageDigest,
      requestedTitleDigest,
    );
  }

  async status(dispatchId: string, recheck = false): Promise<SavedChatResult> {
    if (!UUID.test(dispatchId)) return { status: "unknown" };
    let record: SavedChatRecord | null;
    try {
      record = await this.journal.read(dispatchId);
    } catch {
      return { status: "outcome_unknown", dispatchId };
    }
    if (record === null) return { status: "unknown" };
    if (!recheck || record.phase !== "candidate" || !record.conversationUrl)
      return this.project(dispatchId, record);
    if (this.canonicalUrl(record.conversationUrl) !== record.conversationUrl)
      return { status: "outcome_unknown", dispatchId };
    return this.verifyRecorded(
      dispatchId,
      record.requestDigest,
      record.firstMessageDigest,
      record.requestedTitleDigest,
    );
  }

  private async verifyRecorded(
    dispatchId: string,
    requestDigest: string,
    firstMessageDigest: string,
    requestedTitleDigest: string,
  ): Promise<SavedChatResult> {
    let record: SavedChatRecord | null;
    try {
      record = await this.journal.read(dispatchId);
      if (
        record?.requestDigest !== requestDigest ||
        record.phase !== "candidate" ||
        !record.conversationUrl ||
        this.canonicalUrl(record.conversationUrl) !== record.conversationUrl
      )
        return { status: "outcome_unknown", dispatchId };
      const proof = await this.browser.reopen(
        record.conversationUrl,
        firstMessageDigest,
        requestedTitleDigest,
      );
      if (
        !proof ||
        typeof proof !== "object" ||
        proof.status !== "verified" ||
        typeof proof.titleVerified !== "boolean"
      )
        return { status: "outcome_unknown", dispatchId };
      if (
        !(await this.journal.recordVerified(
          dispatchId,
          requestDigest,
          proof.titleVerified,
        ))
      )
        return { status: "outcome_unknown", dispatchId };
      return {
        status: "verified",
        dispatchId,
        conversationUrl: record.conversationUrl,
        titleVerified: proof.titleVerified,
      };
    } catch {
      return { status: "outcome_unknown", dispatchId };
    }
  }

  private project(
    dispatchId: string,
    record: SavedChatRecord,
  ): SavedChatResult {
    if (
      record.phase === "verified" &&
      record.conversationUrl &&
      this.canonicalUrl(record.conversationUrl) === record.conversationUrl
    )
      return {
        status: "verified",
        dispatchId,
        conversationUrl: record.conversationUrl,
        titleVerified: record.titleVerified === true,
      };
    if (record.phase === "refused" && record.refusalCode)
      return { status: "refused", code: record.refusalCode, dispatchId };
    return { status: "outcome_unknown", dispatchId };
  }
}
