import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The ChatGPT read-only and attachment pending-task helpers live in
// apps/desktop/chat/readonly.ts and are tested there with injected ports.
// Nothing else checks which main-process state each port reads or writes, that
// the one WeakMap of confirmations is still shared rather than copied, or that
// every consumer still gets the helpers by their old names, so a swapped getter
// or a port left on a stale copy would pass every other test. This asserts the
// wiring as text; it executes nothing from main.ts.

const mainSource = path.resolve(
  import.meta.dirname,
  "../../src/apps/desktop/main.ts",
);
const verificationSource = path.resolve(
  import.meta.dirname,
  "../../src/apps/desktop/verification.ts",
);

function flat(text: string): string {
  return text.replace(/\s+/g, " ");
}

async function factoryBody(): Promise<{ source: string; body: string }> {
  const source = await readFile(mainSource, "utf8");
  const begin = source.indexOf("function readonlyHost() {");
  expect(begin).toBeGreaterThanOrEqual(0);
  const body = flat(source.slice(begin, source.indexOf("\n}\n", begin) + 2));
  return { source, body };
}

describe("ChatGPT read-only host wiring in main", () => {
  it("lends each main-process let as a late getter and keeps it declared", async () => {
    const { source, body } = await factoryBody();
    for (const name of [
      "goChatStartupProfile",
      "desktopGoCore",
      "pendingChatGptReadonlyTask",
    ])
      expect(body).toContain(`${name}: () => ${name},`);
    // The lets stay declared in main: their other readers are untouched.
    for (const declaration of [
      "let goChatStartupProfile: ReturnType<typeof captureChatStartupProfile> = null;",
      "let pendingChatGptReadonlyTask: PendingChatGptReadonlyTask | null = null;",
      "let pendingChatGptAttachmentTask: PendingChatGptAttachmentTask | null = null;",
    ])
      expect(source).toContain(declaration);
    expect(source).toMatch(/\nlet desktopGoCore\b/);
    expect(source).toContain("let readonlyHostCache");
  });

  it("gives the one setter an assignment to the let it names, and lends no other", async () => {
    const { body } = await factoryBody();
    expect(body).toContain(
      "setPendingChatGptReadonlyTask: (value) => { pendingChatGptReadonlyTask = value; },",
    );
    expect(body.match(/\(value\) => \{/g)).toHaveLength(1);
    // The attachment task is never reached by the host: only main owns it.
    expect(body).not.toContain("pendingChatGptAttachmentTask");
  });

  it("shares each WeakMap by reference, one instance of each, and never copies it", async () => {
    const { source, body } = await factoryBody();
    expect(body).toContain(
      " readonlyAccountConfirmations, readonlyDiscardAttempts,",
    );
    // Each is keyed by the pending task's identity, so exactly one is built.
    for (const name of [
      "readonlyAccountConfirmations",
      "readonlyDiscardAttempts",
    ]) {
      expect(
        source.match(new RegExp(`\\nconst ${name} = new WeakMap<`, "g")),
      ).toHaveLength(1);
      expect(source.match(new RegExp(`${name} = `, "g"))).toHaveLength(1);
      expect(source).not.toMatch(new RegExp(`new WeakMap\\(\\s*${name}`));
      expect(source).not.toMatch(new RegExp(`\\.\\.\\.${name}`));
    }
    expect(
      flat(source).match(/new WeakMap< PendingChatGptReadonlyTask,/g),
    ).toHaveLength(2);
    // The configuration ports are lent the same confirmations, by the same name.
    expect(source).toContain("\n    readonlyAccountConfirmations,\n");
    // Main only declares it and lends it: only the host reads or writes it.
    expect(source.match(/readonlyDiscardAttempts/g)).toHaveLength(2);
  });

  it("shares the discard helper by reference and keeps the authority construction in the desktop composition", async () => {
    const { source, body } = await factoryBody();
    expect(body).toContain(" discardPreparedChatGptTask, }");
    expect(source).toMatch(/\nfunction discardPreparedChatGptTask\(/);
    // The host holds no authority port: the read-only verification authority is
    // built by the desktop composition (verification.ts, wired from main),
    // against the real authority types.
    for (const name of [
      "nativeWorkspace",
      "deriveTaskGrant",
      "createParticipantAuthority",
      "InMemoryAuthorityRepository",
      "InMemoryComputerApprovalRepository",
      "RunReadonlyComputerAction",
    ])
      expect(body).not.toContain(name);
    const authority = await readFile(verificationSource, "utf8");
    expect(source).toContain(
      "createVerificationWorkspaceAction(nativeWorkspace);",
    );
    expect(authority).toContain(
      "const approvalCapabilities: AuthorityCapability[] = [",
    );
    expect(authority).toContain("const approval: ComputerApproval = {");
    expect(authority).toContain("const admission: TaskAdmission = {");
    expect(authority).toContain(
      "const grant = deriveTaskGrant(approval, admission, Date.now());",
    );
    expect(source).toContain(
      'import { createReadonlyHost } from "../../../apps/desktop/chat/readonly";',
    );
  });

  it("keeps only thin wrappers in main, each reaching the one lazily built instance", async () => {
    const { source } = await factoryBody();
    for (const [header, call] of [
      [
        "function chatGptReadonlyTaskPreview( pending: PendingChatGptReadonlyTask, ): Readonly<Record<string, unknown>> {",
        "readonlyHost().chatGptReadonlyTaskPreview(pending)",
      ],
      [
        "function chatGptAttachmentTaskPreview( pending: PendingChatGptAttachmentTask, ): Readonly<Record<string, unknown>> {",
        "readonlyHost().chatGptAttachmentTaskPreview(pending)",
      ],
      [
        "function withdrawGoReadonlyAdmission( admission: ChatComputerAdmissionResponse | undefined, ): Promise<boolean> {",
        "readonlyHost().withdrawGoReadonlyAdmission(admission)",
      ],
      [
        "function discardPreparedReadonlyTask( pending: PendingChatGptReadonlyTask, ): Promise<boolean> {",
        "readonlyHost().discardPreparedReadonlyTask(pending)",
      ],
    ] as const) {
      const text = flat(source);
      const begin = text.indexOf(header);
      expect(begin, header).toBeGreaterThanOrEqual(0);
      expect(text.slice(begin, text.indexOf("} ", begin) + 1)).toBe(
        `${header} return ${call}; }`,
      );
    }
    // The consumers still reach them by the same names: the configuration
    // ports and the workspace ports are given the main wrappers.
    for (const port of [
      "chatGptAttachmentTaskPreview,",
      "chatGptReadonlyTaskPreview,",
      "discardPreparedReadonlyTask,",
      "withdrawGoReadonlyAdmission,",
      "verificationWorkspaceAction,",
    ])
      expect(source).toContain(`\n    ${port}\n`);
  });

  it("leaves none of the moved bodies behind", async () => {
    const { source } = await factoryBody();
    for (const fragment of [
      "chatgpt.readonly-task-preview",
      "chatgpt.attachment-task-preview",
      "withdrawReadIntent",
      "MAX_CHATGPT_CONTEXT_CHARACTERS",
    ])
      expect(source).not.toContain(fragment);
  });

  it("clears the pending read-only task only through the two setter ports", async () => {
    const { source } = await factoryBody();
    // Main's only assignments are the host's setter and the configuration
    // setter; the moved discard no longer assigns the let itself.
    expect(source.match(/\n\s*pendingChatGptReadonlyTask = /g)).toHaveLength(2);
  });
});
