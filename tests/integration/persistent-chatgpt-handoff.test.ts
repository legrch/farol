import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalChatGptConversationUrl } from "../../src/apps/desktop/chatgpt-page-policy";
import {
  PersistentChatGptHandoff,
  type SavedChatBrowser,
  type SavedChatJournal,
  type SavedChatRequest,
} from "../../src/modules/chat/app/service/persistent-chatgpt-handoff";
import { Sha256SavedChatDigester } from "../../src/modules/chat/infra/native/sha256-saved-chat-digester";
import { PrivateSavedChatJournal } from "../../src/modules/chat/infra/repo/private-saved-chat-journal";

const canonical = (url: string) => canonicalChatGptConversationUrl(url, null);
const url = "https://chatgpt.com/c/12345678-1234-4123-8123-123456789abc";
const digester = new Sha256SavedChatDigester();
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
  const rawRoot = await fs.mkdtemp(path.join(os.tmpdir(), "farol-saved-chat-"));
  roots.push(rawRoot);
  const root = await fs.realpath(rawRoot);
  await fs.chmod(root, 0o700);
  const journal = new PrivateSavedChatJournal(root, canonical);
  const calls: string[] = [];
  let readiness: Awaited<ReturnType<SavedChatBrowser["prepare"]>> = "ready";
  let send: Awaited<ReturnType<SavedChatBrowser["sendOnce"]>> = {
    status: "candidate",
    conversationUrl: url,
  };
  let reopen: Awaited<ReturnType<SavedChatBrowser["reopen"]>> = {
    status: "verified",
    titleVerified: false,
  };
  let sentMessage: string | null = null;
  let sendDigest: string | null = null;
  let beforeSend: (() => Promise<void>) | undefined;
  let throwAt: "prepare" | "send" | "reopen" | null = null;
  const browser: SavedChatBrowser = {
    async prepare() {
      calls.push("prepare");
      if (throwAt === "prepare") throw new Error("ACK_LOST");
      return readiness;
    },
    async sendOnce(message, digest) {
      calls.push("send");
      if (throwAt === "send") throw new Error("ACK_LOST");
      await beforeSend?.();
      sentMessage = message;
      sendDigest = digest;
      return send;
    },
    async reopen(candidate, firstDigest, titleDigest) {
      calls.push(`reopen:${candidate}`);
      if (throwAt === "reopen") throw new Error("READ_UNAVAILABLE");
      expect(candidate).toBe(url);
      expect(firstDigest).toBe(digester.digest(sentMessage ?? ""));
      expect(titleDigest).toBe(digester.digest("Intended title"));
      return reopen;
    },
  };
  const service = (
    customJournal: SavedChatJournal = new PrivateSavedChatJournal(
      root,
      canonical,
    ),
  ) =>
    new PersistentChatGptHandoff(customJournal, browser, digester, canonical);
  const request: SavedChatRequest = {
    key: randomUUID(),
    title: "Intended title",
    firstMessage: "Hello\r\nworld",
  };
  return {
    root,
    journal,
    browser,
    calls,
    service,
    request,
    sent: () => ({ message: sentMessage, digest: sendDigest }),
    setReadiness(value: typeof readiness) {
      readiness = value;
    },
    setSend(value: typeof send) {
      send = value;
    },
    setReopen(value: typeof reopen) {
      reopen = value;
    },
    onBeforeSend(value: () => Promise<void>) {
      beforeSend = value;
    },
    throwAt(value: typeof throwAt) {
      throwAt = value;
    },
  };
}

function withJournalFault(
  base: SavedChatJournal,
  overrides: Partial<SavedChatJournal>,
): SavedChatJournal {
  return {
    reserve: (key, record) => base.reserve(key, record),
    read: (key) => base.read(key),
    markSendIntent: (key, digest) => base.markSendIntent(key, digest),
    recordCandidate: (key, digest, candidate) =>
      base.recordCandidate(key, digest, candidate),
    recordVerified: (key, digest, title) =>
      base.recordVerified(key, digest, title),
    recordRefused: (key, digest, code) => base.recordRefused(key, digest, code),
    ...overrides,
  };
}

describe("saved ChatGPT handoff intent and replay", () => {
  it("records a durable send intent before one normal-chat send and proves a separate reopen", async () => {
    const { journal, service, request, calls, sent, onBeforeSend } =
      await fixture();
    onBeforeSend(async () => {
      expect(await journal.read(request.key)).toMatchObject({
        phase: "send_intent",
        firstMessageDigest: digester.digest("Hello\nworld"),
      });
    });
    expect(await service().create(request)).toEqual({
      status: "verified",
      dispatchId: request.key,
      conversationUrl: url,
      titleVerified: false,
    });
    expect(sent()).toEqual({
      message: "Hello\nworld",
      digest: digester.digest("Hello\nworld"),
    });
    expect(calls).toEqual(["prepare", "send", `reopen:${url}`]);
    expect(await service().status(request.key)).toEqual({
      status: "verified",
      dispatchId: request.key,
      conversationUrl: url,
      titleVerified: false,
    });
    expect(await service().create(request)).toMatchObject({
      status: "verified",
    });
    expect(calls).toHaveLength(3);
    expect(JSON.stringify(await journal.read(request.key))).not.toContain(
      "Hello",
    );
  });

  it("never retries a lost send acknowledgement, even across service restart", async () => {
    const { journal, service, request, calls, setSend } = await fixture();
    setSend({ status: "outcome_unknown" });
    expect(await service().create(request)).toEqual({
      status: "outcome_unknown",
      dispatchId: request.key,
    });
    expect(await journal.read(request.key)).toMatchObject({
      phase: "send_intent",
    });
    expect(await service().create(request)).toEqual({
      status: "outcome_unknown",
      dispatchId: request.key,
    });
    expect(await service().status(request.key, true)).toEqual({
      status: "outcome_unknown",
      dispatchId: request.key,
    });
    expect(calls).toEqual(["prepare", "send"]);
  });

  it("serializes concurrent same-key creates so only one can cross Send", async () => {
    const state = await fixture();
    const outcomes = await Promise.all([
      state.service().create(state.request),
      state.service().create(state.request),
    ]);
    expect(outcomes.some((outcome) => outcome.status === "verified")).toBe(
      true,
    );
    expect(state.calls.filter((call) => call === "send")).toHaveLength(1);
    expect(await state.service().status(state.request.key)).toMatchObject({
      status: "verified",
      conversationUrl: url,
    });
  });

  it("keeps prepare, send, and read-only reopen failures unknown without a second effect", async () => {
    for (const phase of ["prepare", "send", "reopen"] as const) {
      const state = await fixture();
      state.throwAt(phase);
      expect(await state.service().create(state.request)).toEqual({
        status: "outcome_unknown",
        dispatchId: state.request.key,
      });
      expect(await state.journal.read(state.request.key)).toMatchObject({
        phase:
          phase === "prepare"
            ? "reserved"
            : phase === "send"
              ? "send_intent"
              : "candidate",
      });
      const sends = state.calls.filter((call) => call === "send").length;
      expect(await state.service().create(state.request)).toMatchObject({
        status: "outcome_unknown",
      });
      expect(state.calls.filter((call) => call === "send")).toHaveLength(sends);
    }
  });

  it("does not send or publish success after uncertain stage writes", async () => {
    for (const failedStage of [
      "markSendIntent",
      "recordCandidate",
      "recordVerified",
    ] as const) {
      const state = await fixture();
      const fault = withJournalFault(state.journal, {
        [failedStage]: async () => false,
      });
      expect(await state.service(fault).create(state.request)).toEqual({
        status: "outcome_unknown",
        dispatchId: state.request.key,
      });
      expect(await state.journal.read(state.request.key)).toMatchObject({
        phase:
          failedStage === "markSendIntent"
            ? "reserved"
            : failedStage === "recordCandidate"
              ? "send_intent"
              : "candidate",
      });
      expect(state.calls.filter((call) => call === "send")).toHaveLength(
        failedStage === "markSendIntent" ? 0 : 1,
      );
    }
  });

  it("rejects an invalid digest before any browser or journal effect", async () => {
    const state = await fixture();
    const invalid = new (class extends Sha256SavedChatDigester {
      override digest() {
        return "bad";
      }
    })();
    const service = new PersistentChatGptHandoff(
      state.journal,
      state.browser,
      invalid,
      canonical,
    );
    expect(await service.create(state.request)).toEqual({
      status: "refused",
      code: "SAVED_CHAT_DIGEST_INVALID",
      dispatchId: state.request.key,
    });
    expect(await state.journal.read(state.request.key)).toBeNull();
    expect(state.calls).toEqual([]);
  });

  it("does not reinterpret an explicit no-send acknowledgement after the intent boundary", async () => {
    const state = await fixture();
    state.setSend({ status: "not_sent", code: "NO_SEND_CONTROL" });
    expect(await state.service().create(state.request)).toEqual({
      status: "outcome_unknown",
      dispatchId: state.request.key,
    });
    expect(await state.journal.read(state.request.key)).toMatchObject({
      phase: "send_intent",
    });
    expect(await state.service().create(state.request)).toMatchObject({
      status: "outcome_unknown",
    });
    expect(state.calls.filter((call) => call === "send")).toHaveLength(1);
  });

  it("keeps a candidate URL unknown until read-only history/reopen proof succeeds", async () => {
    const { journal, service, request, calls, setReopen } = await fixture();
    setReopen({ status: "unverified" });
    expect(await service().create(request)).toEqual({
      status: "outcome_unknown",
      dispatchId: request.key,
    });
    expect(await journal.read(request.key)).toMatchObject({
      phase: "candidate",
      conversationUrl: url,
    });
    expect(await service().status(request.key)).toEqual({
      status: "outcome_unknown",
      dispatchId: request.key,
    });
    setReopen({ status: "verified", titleVerified: true });
    expect(await service().status(request.key, true)).toEqual({
      status: "verified",
      dispatchId: request.key,
      conversationUrl: url,
      titleVerified: true,
    });
    expect(calls).toEqual([
      "prepare",
      "send",
      `reopen:${url}`,
      `reopen:${url}`,
    ]);
  });

  it("rejects malformed browser proof without writing a verified receipt", async () => {
    const state = await fixture();
    state.setReopen({ status: "verified" } as Awaited<
      ReturnType<SavedChatBrowser["reopen"]>
    >);
    expect(await state.service().create(state.request)).toEqual({
      status: "outcome_unknown",
      dispatchId: state.request.key,
    });
    expect(await state.journal.read(state.request.key)).toMatchObject({
      phase: "candidate",
      conversationUrl: url,
    });
  });

  it("refuses signed-out and non-normal surfaces before any send", async () => {
    for (const readiness of [
      "sign_in_required",
      "not_normal_empty",
      "unavailable",
    ] as const) {
      const state = await fixture();
      state.setReadiness(readiness);
      expect(await state.service().create(state.request)).toEqual({
        status: "refused",
        code:
          readiness === "sign_in_required"
            ? "SAVED_CHAT_SIGN_IN_REQUIRED"
            : readiness === "not_normal_empty"
              ? "SAVED_CHAT_NORMAL_EMPTY_REQUIRED"
              : "SAVED_CHAT_BROWSER_UNAVAILABLE",
        dispatchId: state.request.key,
      });
      expect(state.calls).toEqual(["prepare"]);
      expect(await state.service().create(state.request)).toMatchObject({
        status: "refused",
      });
      expect(state.calls).toHaveLength(1);
    }
  });

  it("never promotes a noncanonical conversation URL or a second key payload", async () => {
    const state = await fixture();
    state.setSend({ status: "candidate", conversationUrl: `${url}?share=1` });
    expect(await state.service().create(state.request)).toMatchObject({
      status: "outcome_unknown",
    });
    expect(state.calls).toEqual(["prepare", "send"]);
    expect(
      await state.service().create({ ...state.request, title: "Other" }),
    ).toEqual({
      status: "refused",
      code: "SAVED_CHAT_KEY_CONFLICT",
      dispatchId: state.request.key,
    });
  });

  it("rejects oversized UTF-8 input and malformed keys without opening the browser", async () => {
    const state = await fixture();
    expect(
      await state
        .service()
        .create({ ...state.request, firstMessage: "🙂".repeat(2049) }),
    ).toMatchObject({
      status: "refused",
      code: "SAVED_CHAT_INPUT_INVALID",
    });
    expect(
      await state.service().create({ ...state.request, key: "bad" }),
    ).toMatchObject({
      status: "refused",
      code: "SAVED_CHAT_INPUT_INVALID",
    });
    expect(await state.service().status("bad")).toEqual({ status: "unknown" });
    expect(await state.service().status(randomUUID())).toEqual({
      status: "unknown",
    });
    expect(
      await state.service().create({
        ...state.request,
        key: state.request.key.toUpperCase(),
      }),
    ).toMatchObject({ status: "refused", code: "SAVED_CHAT_INPUT_INVALID" });
    expect(state.calls).toEqual([]);
  });

  it("refuses private-state symlinks and corrupt records without another send", async () => {
    const state = await fixture();
    await fs.chmod(state.root, 0o755);
    expect(await state.service().create(state.request)).toMatchObject({
      status: "outcome_unknown",
    });
    expect(state.calls).toEqual([]);
    await fs.chmod(state.root, 0o700);
    await fs.writeFile(
      path.join(state.root, `${state.request.key}.reserve.json`),
      "{}",
      { mode: 0o600 },
    );
    expect(await state.service().create(state.request)).toMatchObject({
      status: "outcome_unknown",
    });
    expect(state.calls).toEqual([]);
  });

  it("rejects a symlinked journal root and a hardlinked reservation", async () => {
    const state = await fixture();
    const alias = path.join(state.root, "alias");
    await fs.symlink(state.root, alias);
    const linkedRoot = new PrivateSavedChatJournal(alias, canonical);
    await expect(linkedRoot.read(state.request.key)).rejects.toThrow(
      "SAVED_CHAT_ROOT_UNTRUSTED",
    );
    expect(await state.service().create(state.request)).toMatchObject({
      status: "verified",
    });
    const reserve = path.join(state.root, `${state.request.key}.reserve.json`);
    await fs.link(reserve, path.join(state.root, "foreign-hardlink"));
    await expect(state.journal.read(state.request.key)).rejects.toThrow(
      "SAVED_CHAT_FILE_UNTRUSTED",
    );
    expect(await state.service().status(state.request.key)).toMatchObject({
      status: "outcome_unknown",
    });
  });

  it("enforces write-once journal stages and exact digest/URL transitions", async () => {
    const state = await fixture();
    const key = state.request.key;
    const digest = digester.requestDigest({
      ...state.request,
      firstMessage: "Hello\nworld",
    });
    const record = {
      requestDigest: digest,
      firstMessageDigest: digester.digest("Hello\nworld"),
      requestedTitleDigest: digester.digest(state.request.title),
      phase: "reserved" as const,
    };
    await expect(
      state.journal.reserve(key, { ...record, requestDigest: "bad" }),
    ).rejects.toThrow("SAVED_CHAT_RECORD_INVALID");
    expect(await state.journal.read(key)).toBeNull();
    expect(await state.journal.markSendIntent(key, digest)).toBe(false);
    expect(await state.journal.recordCandidate(key, digest, url)).toBe(false);
    expect(await state.journal.recordVerified(key, digest, false)).toBe(false);
    expect(
      await state.journal.recordRefused(key, digest, "SAVED_CHAT_DENIED"),
    ).toBe(false);
    expect(await state.journal.reserve(key, record)).toBe("new");
    expect(await state.journal.reserve(key, record)).toBe("existing");
    expect(await state.journal.markSendIntent(key, "0".repeat(64))).toBe(false);
    expect(await state.journal.recordCandidate(key, digest, url)).toBe(false);
    expect(await state.journal.recordVerified(key, digest, false)).toBe(false);
    expect(await state.journal.recordRefused(key, digest, "invalid")).toBe(
      false,
    );
    expect(await state.journal.markSendIntent(key, digest)).toBe(true);
    expect(await state.journal.markSendIntent(key, digest)).toBe(false);
    expect(
      await state.journal.recordCandidate(key, digest, `${url}?share=1`),
    ).toBe(false);
    expect(
      await state.journal.recordRefused(key, digest, "SAVED_CHAT_DENIED"),
    ).toBe(false);
    expect(await state.journal.recordCandidate(key, digest, url)).toBe(true);
    expect(await state.journal.recordCandidate(key, digest, url)).toBe(false);
    expect(await state.journal.recordVerified(key, digest, true)).toBe(true);
    expect(await state.journal.recordVerified(key, digest, false)).toBe(false);
    expect(await state.journal.read(key)).toMatchObject({
      phase: "verified",
      conversationUrl: url,
      titleVerified: true,
    });
  });
});
