import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The ChatGPT session state lives in apps/desktop/chat/session.ts and is tested
// there with injected ports. Nothing else checks which main-process state each
// port reads or writes, so a swapped getter or setter would pass every other
// test. This asserts the wiring as text; it executes nothing from main.ts.

const mainSource = path.resolve(
  import.meta.dirname,
  "../../src/apps/desktop/main.ts",
);

async function factoryBody(): Promise<{ source: string; body: string }> {
  const source = await readFile(mainSource, "utf8");
  const begin = source.indexOf("function chatGptSession() {");
  expect(begin).toBeGreaterThanOrEqual(0);
  const body = source
    .slice(begin, source.indexOf("\n}\n", begin) + 2)
    .replace(/\s+/g, " ");
  return { source, body };
}

describe("ChatGPT session wiring in main", () => {
  it("lends each main-process let as a late getter", async () => {
    const { source, body } = await factoryBody();
    for (const name of [
      "chatGptConversationStore",
      "chatGptConversation",
      "chatGptRoute",
      "goReadonlyConversation",
      "directChatStart",
      "chatGptTaskJournal",
      "window",
    ])
      expect(body).toContain(`${name}: () => ${name},`);
    // The lets stay declared in main: their other readers are untouched.
    for (const declaration of [
      "let chatGptConversationStore: PrivateChatGptConversationStore | null = null;",
      "let chatGptConversation: ChatGptConversationRecord | null = null;",
      "let chatGptRoute: ChatGptRoute | null = null;",
      "let goReadonlyConversation: GoReadonlyConversation | null = null;",
      "let directChatStart: DirectChatStart | null = null;",
      "let chatGptTaskJournal: PrivateChatGptTaskJournal | null = null;",
      "let window: BrowserWindow | null = null;",
    ])
      expect(source).toContain(declaration);
    expect(source).toContain("let chatGptSessionCache");
  });

  it("gives each setter an assignment to the let it names", async () => {
    const { body } = await factoryBody();
    for (const [setter, name] of Object.entries({
      setChatGptConversationStore: "chatGptConversationStore",
      setChatGptConversation: "chatGptConversation",
    }))
      expect(body).toContain(`${setter}: (value) => { ${name} = value; },`);
    // Only these two lets are assigned by the session, and no other.
    expect(body.match(/\(value\) => \{/g)).toHaveLength(2);
  });

  it("shares each const owner and main helper by reference", async () => {
    const { source, body } = await factoryBody();
    for (const name of [
      "activeDesktopIdentity",
      "buildIdentity",
      "configurationFailure",
    ]) {
      expect(body).toContain(` ${name},`);
      // A shared owner must stay a const or a function, not become a lent `let`.
      expect(source).not.toMatch(new RegExp(`\\nlet ${name}\\b`));
    }
  });

  it("opens the real dialog and reads the real environment", async () => {
    const { body } = await factoryBody();
    expect(body).toContain(
      "showOpenDialog: (owner, options) => dialog.showOpenDialog(owner, options),",
    );
    expect(body).toContain("env: process.env,");
  });

  it("keeps only thin wrappers in main, each reaching the one lazily built instance", async () => {
    const { source } = await factoryBody();
    for (const [header, call] of [
      [
        'function chatGptConversationState():\n  "new" | "retained" | "review_required" | "unavailable" {',
        "chatGptSession().conversationState()",
      ],
      [
        "function chatGptConversationAdmissionFailure(): ProductConfigurationResult | null {",
        "chatGptSession().admissionFailure()",
      ],
      [
        'function chatGptConversationContinuity():\n  "retained" | "not_observed" | "review_required" | "unavailable" {',
        "chatGptSession().continuity()",
      ],
      [
        "function chatGptAppPreSubmitObservation(code: string | null) {",
        "chatGptSession().preSubmitObservation(code)",
      ],
      [
        'function retainChatGptConversation(\n  operationId: string,\n  taskState:\n    | "completed"\n    | "not_authenticated"\n    | "failed_before_submit"\n    | "outcome_unknown",\n): Promise<"retained" | "not_observed" | "review_required" | "unavailable"> {',
        "chatGptSession().retain(operationId, taskState)",
      ],
      [
        "function chatGptJournalObservation(result: ChatGptTaskJournalResult) {",
        "chatGptSession().journalObservation(result)",
      ],
      [
        "function discardPreparedChatGptTask(operationId: string): Promise<boolean> {",
        "chatGptSession().discardPrepared(operationId)",
      ],
      [
        'function selectedChatGptAttachmentPaths(): Promise<\n  readonly string[] | "cancelled" | "invalid"\n> {',
        "chatGptSession().selectedAttachmentPaths()",
      ],
      [
        "function attachmentStagingFailure(error: unknown): ProductConfigurationResult {",
        "chatGptSession().attachmentStagingFailure(error)",
      ],
    ] as const) {
      const begin = source.indexOf(header);
      expect(begin, header).toBeGreaterThanOrEqual(0);
      expect(source.slice(begin, source.indexOf("\n}\n", begin) + 3)).toBe(
        `${header}\n  return ${call};\n}\n`,
      );
    }
    // The call sites that remain in main still reach them by the same names,
    // and the configuration ports are still given the main wrappers.
    expect(source).toContain(
      "chatgptConversationState: chatGptConversationState(),",
    );
    expect(source).toContain(
      "chatGptJournalObservation(recoverableChatGptTask.result),",
    );
    for (const port of [
      "chatGptConversationContinuity,",
      "chatGptConversationAdmissionFailure,",
      "retainChatGptConversation,",
      "chatGptJournalObservation,",
      "chatGptAppPreSubmitObservation,",
      "attachmentStagingFailure,",
      "discardPreparedChatGptTask,",
      "selectedChatGptAttachmentPaths,",
    ])
      expect(source).toContain(`\n    ${port}\n`);
  });

  it("leaves none of the moved bodies behind", async () => {
    const { source } = await factoryBody();
    for (const fragment of [
      "const chatGptAppPreSubmitCodes",
      "chatgpt-page-app-binding-block/1",
      "chatgpt-page-task-recovery/1",
      "CHATGPT_CONVERSATION_REVIEW_REQUIRED",
      "CHATGPT_CONVERSATION_STATE_FAILED",
      "markUnresolved(",
      "FAROL_E2E_ATTACHMENTS",
      "Choose up to four attachments",
      "ATTACHMENT_TYPE_UNSUPPORTED",
      "CHATGPT_ATTACHMENT_STAGING_FAILED",
    ])
      expect(source).not.toContain(fragment);
  });
});
