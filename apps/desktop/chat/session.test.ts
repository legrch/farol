import type { BrowserWindow, OpenDialogOptions } from "electron";
import { describe, expect, it, vi } from "vitest";
import type { ChatGptConversationRecord } from "../../../src/apps/desktop/chatgpt-conversation-store";
import type { ChatGptTaskJournalResult } from "../../../src/apps/desktop/chatgpt-task-journal";
import {
  createChatGptSession,
  type ChatGptSessionFailureCode,
  type ChatGptSessionPorts,
} from "./session";

// The ChatGPT session state over scripted owners. Main's `let`s are fields the
// ports read afresh and write through the setters, the store, route, journal
// and dialog are fakes, and every effect appends to one ordered log. No window,
// provider, journal file or installed profile runs.
type Failure = Readonly<{ failure: ChatGptSessionFailureCode }>;
type Store = NonNullable<
  ReturnType<ChatGptSessionPorts<Failure>["chatGptConversationStore"]>
>;

const operationId = "7d9a9a52-5d7c-4d6b-9d1e-0c9c5a0f4a11";
const conversationUrl = "https://chatgpt.com/c/abc";

function record(
  state: ChatGptConversationRecord["state"],
): ChatGptConversationRecord {
  return state === "retained"
    ? {
        schema: 1,
        state,
        operationId,
        conversationUrl,
        reason: null,
        updatedAt: "2026-11-24T10:00:00.000Z",
      }
    : {
        schema: 1,
        state,
        operationId,
        conversationUrl: null,
        reason: "CHATGPT_CONVERSATION_URL_UNAVAILABLE",
        updatedAt: "2026-11-24T10:00:00.000Z",
      };
}

function journalResult(
  state: ChatGptTaskJournalResult["state"],
  code: string | null = null,
): ChatGptTaskJournalResult {
  return {
    state,
    code,
    deltaCount: 0,
    observedCharacters: 0,
    attachmentCount: 0,
    totalBytes: 0,
    stagingCleanup: null,
  };
}

function fakeStore(
  events: string[],
  loaded: ChatGptConversationRecord | null = null,
  overrides: Partial<Store> = {},
): Store {
  return {
    load: vi.fn(() => {
      events.push("store.load");
      return Promise.resolve(loaded);
    }),
    retain: vi.fn((input) => {
      events.push(`store.retain ${input.operationId} ${input.conversationUrl}`);
      return Promise.resolve();
    }),
    markUnresolved: vi.fn((id: string) => {
      events.push(`store.markUnresolved ${id}`);
      return Promise.resolve();
    }),
    ...overrides,
  };
}

function build(
  options: Readonly<{
    store?: Store | null;
    conversation?: ChatGptConversationRecord | null;
    route?: { currentConversationUrl: () => string | null } | null;
    readonly?: boolean;
    direct?: boolean;
    journal?: { discardPrepared: (id: string) => Promise<void> } | null;
    window?: BrowserWindow | null;
    env?: Record<string, string | undefined>;
    dialog?: (
      window: BrowserWindow,
      options: OpenDialogOptions,
    ) => Promise<{ canceled: boolean; filePaths: string[] }>;
  }> = {},
) {
  const events: string[] = [];
  const state = {
    store: options.store === undefined ? fakeStore(events) : options.store,
    conversation: options.conversation ?? null,
    route:
      options.route === undefined
        ? { currentConversationUrl: () => conversationUrl as string | null }
        : options.route,
    readonly: options.readonly ?? false,
    direct: options.direct ?? false,
    journal: options.journal ?? null,
    window: options.window ?? null,
    env: options.env ?? {},
  };
  const dialog = vi.fn(
    options.dialog ??
      (() => Promise.resolve({ canceled: true, filePaths: [] as string[] })),
  );
  const ports: ChatGptSessionPorts<Failure> = {
    chatGptConversationStore: () => state.store,
    setChatGptConversationStore: (value) => {
      events.push("set store null");
      state.store = value;
    },
    chatGptConversation: () => state.conversation,
    setChatGptConversation: (value) => {
      events.push(`set conversation ${value?.state ?? "null"}`);
      state.conversation = value;
    },
    chatGptRoute: () => state.route,
    goReadonlyConversation: () => (state.readonly ? {} : null),
    directChatStart: () => (state.direct ? {} : null),
    chatGptTaskJournal: () => state.journal,
    window: () => state.window,
    activeDesktopIdentity: { chatGptPartition: "persist:farol-test" },
    buildIdentity: { buildId: "build-7" },
    configurationFailure: (error) => ({ failure: error }),
    showOpenDialog: dialog,
    env: state.env,
  };
  return { state, events, dialog, subject: createChatGptSession(ports) };
}

const ownerWindow = { id: "owner" } as unknown as BrowserWindow;

describe("conversation state", () => {
  it("is unavailable without a store, whatever the record says", () => {
    const { subject } = build({
      store: null,
      conversation: record("retained"),
    });
    expect(subject.conversationState()).toBe("unavailable");
    expect(subject.continuity()).toBe("unavailable");
  });

  it.each([
    [null, "new", "not_observed"],
    [record("retained"), "retained", "retained"],
    [record("unresolved"), "review_required", "review_required"],
  ] as const)(
    "reads %o as %s and continuity %s",
    (conversation, state, continuity) => {
      const { subject } = build({ conversation });
      expect(subject.conversationState()).toBe(state);
      expect(subject.continuity()).toBe(continuity);
    },
  );

  it("reads the owners afresh at every call", () => {
    const { subject, state } = build();
    expect(subject.conversationState()).toBe("new");
    state.conversation = record("retained");
    expect(subject.conversationState()).toBe("retained");
    state.conversation = record("unresolved");
    expect(subject.conversationState()).toBe("review_required");
    state.store = null;
    expect(subject.conversationState()).toBe("unavailable");
  });
});

describe("conversation admission failure", () => {
  it("refuses while a read-only conversation is running", () => {
    const { subject } = build({ readonly: true });
    expect(subject.admissionFailure()).toEqual({
      failure: "CHATGPT_TASK_IN_PROGRESS",
    });
  });

  it("refuses while a direct chat start is running", () => {
    const { subject } = build({ direct: true });
    expect(subject.admissionFailure()).toEqual({
      failure: "CHATGPT_TASK_IN_PROGRESS",
    });
  });

  it("puts the running task before an unavailable store", () => {
    const { subject } = build({ store: null, direct: true });
    expect(subject.admissionFailure()).toEqual({
      failure: "CHATGPT_TASK_IN_PROGRESS",
    });
  });

  it("refuses without a store", () => {
    const { subject } = build({ store: null });
    expect(subject.admissionFailure()).toEqual({
      failure: "CHATGPT_CONVERSATION_STATE_FAILED",
    });
  });

  it("refuses an unresolved conversation", () => {
    const { subject } = build({ conversation: record("unresolved") });
    expect(subject.admissionFailure()).toEqual({
      failure: "CHATGPT_CONVERSATION_REVIEW_REQUIRED",
    });
  });

  it.each([null, record("retained")] as const)(
    "admits when the conversation is %o",
    (conversation) => {
      const { subject } = build({ conversation });
      expect(subject.admissionFailure()).toBeNull();
    },
  );

  it("follows a task that starts after the first call", () => {
    const { subject, state } = build();
    expect(subject.admissionFailure()).toBeNull();
    state.readonly = true;
    expect(subject.admissionFailure()).toEqual({
      failure: "CHATGPT_TASK_IN_PROGRESS",
    });
  });
});

describe("app pre-submit observation", () => {
  it.each([
    "CHATGPT_APP_SELECTION_MISSING",
    "CHATGPT_APP_SELECTION_AMBIGUOUS",
    "CHATGPT_APP_SELECTION_CONFLICT",
    "CHATGPT_APP_SELECTION_LOST",
    "CHATGPT_COMPOSER_DRAFT_PRESENT",
  ])("reports %s as an authenticated binding block", (code) => {
    const { subject } = build();
    expect(subject.preSubmitObservation(code)).toEqual({
      state: "authenticated",
      profile: "chatgpt.app-partition/1",
      runtimeGeneration: "persist:farol-test:build-7",
      buildId: "build-7",
      protocol: "chatgpt-page-app-binding-block/1",
    });
  });

  it.each([null, "CHATGPT_PAGE_UNREACHABLE", "", "chatgpt_app_selection_lost"])(
    "reports nothing for %o",
    (code) => {
      const { subject } = build();
      expect(subject.preSubmitObservation(code)).toBeNull();
    },
  );
});

describe("journal observation", () => {
  it("reports a completed task as authenticated recovery", () => {
    const { subject } = build();
    expect(subject.journalObservation(journalResult("completed"))).toEqual({
      state: "authenticated",
      profile: "chatgpt.app-partition/1",
      runtimeGeneration: "persist:farol-test:build-7",
      buildId: "build-7",
      protocol: "chatgpt-page-task-recovery/1",
    });
  });

  it("reports a task that found no account as signed out", () => {
    const { subject } = build();
    expect(
      subject.journalObservation(journalResult("not_authenticated")),
    ).toEqual({ state: "signed_out" });
  });

  it("keeps an unknown outcome unknown whatever the code", () => {
    const { subject } = build();
    expect(
      subject.journalObservation(
        journalResult("outcome_unknown", "CHATGPT_APP_SELECTION_LOST"),
      ),
    ).toEqual({ state: "outcome_unknown" });
  });

  it("reports a binding block before the submit as the binding block", () => {
    const { subject } = build();
    expect(
      subject.journalObservation(
        journalResult("failed_before_submit", "CHATGPT_COMPOSER_DRAFT_PRESENT"),
      ),
    ).toMatchObject({
      state: "authenticated",
      protocol: "chatgpt-page-app-binding-block/1",
    });
  });

  it("reports an unreachable page", () => {
    const { subject } = build();
    expect(
      subject.journalObservation(
        journalResult("failed_before_submit", "CHATGPT_PAGE_UNREACHABLE"),
      ),
    ).toEqual({ state: "unreachable" });
  });

  it.each([
    ["failed_before_submit", "CHATGPT_SOMETHING_ELSE"],
    ["failed_before_submit", null],
    ["send_requested", null],
    ["send_requested", "CHATGPT_PAGE_UNREACHABLE"],
  ] as const)(
    "reports %s / %s as unsupported or unreachable by code",
    (state, code) => {
      const { subject } = build();
      expect(subject.journalObservation(journalResult(state, code))).toEqual(
        code === "CHATGPT_PAGE_UNREACHABLE"
          ? { state: "unreachable" }
          : { state: "unsupported" },
      );
    },
  );
});

describe("conversation retention", () => {
  it.each(["not_authenticated", "failed_before_submit"] as const)(
    "keeps the continuity as it is after %s and touches nothing",
    async (taskState) => {
      const { subject, events, state } = build({
        conversation: record("retained"),
      });
      await expect(subject.retain(operationId, taskState)).resolves.toBe(
        "retained",
      );
      state.conversation = null;
      await expect(subject.retain(operationId, taskState)).resolves.toBe(
        "not_observed",
      );
      state.store = null;
      await expect(subject.retain(operationId, taskState)).resolves.toBe(
        "unavailable",
      );
      expect(events).toEqual([]);
    },
  );

  it.each(["completed", "outcome_unknown"] as const)(
    "retains the conversation address after %s",
    async (taskState) => {
      const events: string[] = [];
      const loaded = record("retained");
      const built = build({ store: fakeStore(events, loaded) });
      await expect(built.subject.retain(operationId, taskState)).resolves.toBe(
        "retained",
      );
      expect(events).toEqual([
        `store.retain ${operationId} ${conversationUrl}`,
        "store.load",
      ]);
      expect(built.events).toEqual(["set conversation retained"]);
      expect(built.state.conversation).toEqual(loaded);
    },
  );

  it("marks the conversation unresolved when the route has no address", async () => {
    const events: string[] = [];
    const loaded = record("unresolved");
    const built = build({
      store: fakeStore(events, loaded),
      route: { currentConversationUrl: () => null },
    });
    await expect(built.subject.retain(operationId, "completed")).resolves.toBe(
      "review_required",
    );
    expect(events).toEqual([
      `store.markUnresolved ${operationId}`,
      "store.load",
    ]);
    expect(built.state.conversation).toEqual(loaded);
    expect(built.events).toEqual(["set conversation unresolved"]);
  });

  it("is unavailable without a store", async () => {
    const built = build({ store: null });
    await expect(built.subject.retain(operationId, "completed")).resolves.toBe(
      "unavailable",
    );
    expect(built.events).toEqual([]);
  });

  it("is unavailable without a route, before any store call", async () => {
    const events: string[] = [];
    const built = build({ store: fakeStore(events), route: null });
    await expect(built.subject.retain(operationId, "completed")).resolves.toBe(
      "unavailable",
    );
    expect(events).toEqual([]);
    expect(built.events).toEqual([]);
  });

  it("lets a route that cannot answer reject, with the owners untouched", async () => {
    const events: string[] = [];
    const built = build({
      store: fakeStore(events),
      conversation: record("retained"),
      route: {
        currentConversationUrl: () => {
          throw new Error("ROUTE_GONE");
        },
      },
    });
    await expect(
      built.subject.retain(operationId, "completed"),
    ).rejects.toThrow("ROUTE_GONE");
    expect(events).toEqual([]);
    expect(built.state.store).not.toBeNull();
    expect(built.state.conversation).toEqual(record("retained"));
  });

  it.each([
    [
      "marking it unresolved",
      { markUnresolved: () => Promise.reject(new Error("DISK")) },
      null,
    ],
    [
      "retaining it",
      { retain: () => Promise.reject(new Error("DISK")) },
      "https://chatgpt.com/c/abc",
    ],
    [
      "loading it back",
      { load: () => Promise.reject(new Error("DISK")) },
      "https://chatgpt.com/c/abc",
    ],
  ] as const)(
    "clears the store and the record when %s fails",
    async (_label, override, address) => {
      const events: string[] = [];
      const built = build({
        store: fakeStore(events, record("retained"), override),
        conversation: record("retained"),
        route: { currentConversationUrl: () => address },
      });
      await expect(
        built.subject.retain(operationId, "completed"),
      ).resolves.toBe("unavailable");
      expect(built.state.store).toBeNull();
      expect(built.state.conversation).toBeNull();
      expect(built.events.slice(-2)).toEqual([
        "set store null",
        "set conversation null",
      ]);
    },
  );

  it("reads the store again after the save, and finds it cleared", async () => {
    // Main read the store again after each await. A save that failed in the
    // meantime cleared it, so the second read threw inside the try.
    const events: string[] = [];
    const first = fakeStore(events, record("retained"));
    const built = build({ store: first });
    (first.retain as ReturnType<typeof vi.fn>).mockImplementation(() => {
      built.state.store = null;
      return Promise.resolve();
    });
    await expect(built.subject.retain(operationId, "completed")).resolves.toBe(
      "unavailable",
    );
    expect(first.load).not.toHaveBeenCalled();
    expect(built.state.conversation).toBeNull();
    expect(built.events).toEqual(["set store null", "set conversation null"]);
  });

  it("loads from the store that is there after the save, not the one it started with", async () => {
    const events: string[] = [];
    const first = fakeStore(events, record("unresolved"));
    const second = fakeStore(events, record("retained"));
    const built = build({ store: first });
    (first.retain as ReturnType<typeof vi.fn>).mockImplementation(() => {
      built.state.store = second;
      return Promise.resolve();
    });
    await expect(built.subject.retain(operationId, "completed")).resolves.toBe(
      "retained",
    );
    expect(first.load).not.toHaveBeenCalled();
    expect(second.load).toHaveBeenCalledOnce();
    expect(built.state.conversation).toEqual(record("retained"));
  });
});

describe("discarding a prepared task", () => {
  it("is false without a journal", async () => {
    const { subject } = build();
    await expect(subject.discardPrepared(operationId)).resolves.toBe(false);
  });

  it("discards the operation and says so", async () => {
    const discardPrepared = vi.fn(() => Promise.resolve());
    const { subject } = build({ journal: { discardPrepared } });
    await expect(subject.discardPrepared(operationId)).resolves.toBe(true);
    expect(discardPrepared).toHaveBeenCalledExactlyOnceWith(operationId);
  });

  it("is false, and not repeated, when the journal refuses", async () => {
    const discardPrepared = vi.fn(() =>
      Promise.reject(new Error("CHATGPT_TASK_JOURNAL_TRANSITION")),
    );
    const { subject } = build({ journal: { discardPrepared } });
    await expect(subject.discardPrepared(operationId)).resolves.toBe(false);
    expect(discardPrepared).toHaveBeenCalledOnce();
  });

  it("reads the journal afresh", async () => {
    const discardPrepared = vi.fn(() => Promise.resolve());
    const { subject, state } = build();
    await expect(subject.discardPrepared(operationId)).resolves.toBe(false);
    state.journal = { discardPrepared };
    await expect(subject.discardPrepared(operationId)).resolves.toBe(true);
  });
});

describe("attachment selection", () => {
  const e2e = (attachments: string | undefined) => ({
    FAROL_E2E: "1",
    FAROL_E2E_ATTACHMENTS: attachments,
  });

  it("takes one to four absolute paths from the e2e fixture, without a dialog", async () => {
    for (const paths of [
      ["/tmp/a.txt"],
      ["/tmp/a.txt", "/tmp/b.png", "/tmp/c.pdf", "/tmp/d.md"],
    ]) {
      const { subject, dialog } = build({
        env: e2e(JSON.stringify(paths)),
        window: ownerWindow,
      });
      await expect(subject.selectedAttachmentPaths()).resolves.toEqual(paths);
      expect(dialog).not.toHaveBeenCalled();
    }
  });

  it.each([
    ["missing", undefined],
    ["not json", "{"],
    ["not an array", '"/tmp/a.txt"'],
    ["empty", "[]"],
    ["five", JSON.stringify(["/a", "/b", "/c", "/d", "/e"])],
    ["relative", JSON.stringify(["a.txt"])],
    ["one relative of two", JSON.stringify(["/a.txt", "b.txt"])],
    ["not strings", JSON.stringify([1])],
  ])("refuses an e2e fixture that is %s", async (_label, attachments) => {
    const { subject, dialog } = build({
      env: e2e(attachments),
      window: ownerWindow,
    });
    await expect(subject.selectedAttachmentPaths()).resolves.toBe("invalid");
    expect(dialog).not.toHaveBeenCalled();
  });

  it("uses the dialog when the e2e flag is not exactly 1", async () => {
    const { subject, dialog } = build({
      env: { FAROL_E2E: "0", FAROL_E2E_ATTACHMENTS: '["/tmp/a.txt"]' },
      window: ownerWindow,
    });
    await expect(subject.selectedAttachmentPaths()).resolves.toBe("cancelled");
    expect(dialog).toHaveBeenCalledOnce();
  });

  it("refuses without a window and never opens a dialog", async () => {
    const { subject, dialog } = build({ window: null });
    await expect(subject.selectedAttachmentPaths()).resolves.toBe("invalid");
    expect(dialog).not.toHaveBeenCalled();
  });

  it("asks the owner's window with the fixed options", async () => {
    const { subject, dialog } = build({
      window: ownerWindow,
      dialog: () =>
        Promise.resolve({ canceled: false, filePaths: ["/Users/o/a.png"] }),
    });
    await expect(subject.selectedAttachmentPaths()).resolves.toEqual([
      "/Users/o/a.png",
    ]);
    expect(dialog).toHaveBeenCalledExactlyOnceWith(ownerWindow, {
      title: "Choose up to four attachments",
      buttonLabel: "Review Attachments",
      properties: ["openFile", "multiSelections"],
      filters: [
        {
          name: "Supported images and documents",
          extensions: ["png", "jpg", "jpeg", "webp", "pdf", "txt", "md"],
        },
      ],
      securityScopedBookmarks: false,
    });
  });

  it("reports a cancelled dialog, even one that carries paths", async () => {
    const { subject } = build({
      window: ownerWindow,
      dialog: () =>
        Promise.resolve({ canceled: true, filePaths: ["/Users/o/a.png"] }),
    });
    await expect(subject.selectedAttachmentPaths()).resolves.toBe("cancelled");
  });

  it.each([
    [0, "invalid"],
    [5, "invalid"],
  ] as const)("refuses %i chosen files", async (count, expected) => {
    const { subject } = build({
      window: ownerWindow,
      dialog: () =>
        Promise.resolve({
          canceled: false,
          filePaths: Array.from({ length: count }, (_, i) => `/f${i}`),
        }),
    });
    await expect(subject.selectedAttachmentPaths()).resolves.toBe(expected);
  });

  it("accepts four chosen files", async () => {
    const files = ["/a", "/b", "/c", "/d"];
    const { subject } = build({
      window: ownerWindow,
      dialog: () => Promise.resolve({ canceled: false, filePaths: files }),
    });
    await expect(subject.selectedAttachmentPaths()).resolves.toBe(files);
  });

  it("reads the window and the environment afresh", async () => {
    const { subject, state } = build({
      dialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
    });
    await expect(subject.selectedAttachmentPaths()).resolves.toBe("invalid");
    state.window = ownerWindow;
    await expect(subject.selectedAttachmentPaths()).resolves.toBe("cancelled");
  });
});

describe("attachment staging failure", () => {
  it.each([
    ["ATTACHMENT_TYPE_UNSUPPORTED", "CHATGPT_ATTACHMENT_TYPE_UNSUPPORTED"],
    ["ATTACHMENT_TOO_LARGE", "CHATGPT_ATTACHMENT_TOO_LARGE"],
    ["ATTACHMENT_TOTAL_TOO_LARGE", "CHATGPT_ATTACHMENT_TOO_LARGE"],
    ["ATTACHMENT_SOURCE_MISSING", "CHATGPT_ATTACHMENT_REFERENCE_MISSING"],
    ["ATTACHMENT_REFERENCE_MISSING", "CHATGPT_ATTACHMENT_REFERENCE_MISSING"],
    ["ATTACHMENT_REFERENCE_CHANGED", "CHATGPT_ATTACHMENT_REFERENCE_MISSING"],
    ["ATTACHMENT_SELECTION_INVALID", "CHATGPT_ATTACHMENT_SELECTION_INVALID"],
    ["ATTACHMENT_DUPLICATE_NAME", "CHATGPT_ATTACHMENT_SELECTION_INVALID"],
    ["ATTACHMENT_EMPTY", "CHATGPT_ATTACHMENT_SELECTION_INVALID"],
    ["ATTACHMENT_SOURCE_UNSAFE", "CHATGPT_ATTACHMENT_SELECTION_INVALID"],
    ["SOMETHING_ELSE", "CHATGPT_ATTACHMENT_STAGING_FAILED"],
    ["", "CHATGPT_ATTACHMENT_STAGING_FAILED"],
  ])("maps the error %s to %s", (message, failure) => {
    const { subject } = build();
    expect(subject.attachmentStagingFailure(new Error(message))).toEqual({
      failure,
    });
  });

  it.each([
    "ATTACHMENT_TYPE_UNSUPPORTED",
    null,
    undefined,
    { message: "ATTACHMENT_EMPTY" },
  ])("treats %o, which is not an Error, as a staging failure", (error) => {
    const { subject } = build();
    expect(subject.attachmentStagingFailure(error)).toEqual({
      failure: "CHATGPT_ATTACHMENT_STAGING_FAILED",
    });
  });
});
