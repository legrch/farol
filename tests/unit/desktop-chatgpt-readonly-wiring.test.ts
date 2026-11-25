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

  it("shares the one WeakMap of confirmations by reference and never copies it", async () => {
    const { source, body } = await factoryBody();
    expect(body).toContain(" readonlyAccountConfirmations,");
    expect(source).toMatch(
      /\nconst readonlyAccountConfirmations = new WeakMap</,
    );
    // It is keyed by the pending task's identity, so exactly one is built.
    expect(
      flat(source).match(/new WeakMap< PendingChatGptReadonlyTask,/g),
    ).toHaveLength(1);
    expect(source.match(/const readonlyAccountConfirmations = /g)).toHaveLength(
      1,
    );
    // The configuration ports are lent the same instance, by the same name.
    expect(source).toContain("\n    readonlyAccountConfirmations,\n");
    expect(source).not.toMatch(/new WeakMap\(\s*readonlyAccountConfirmations/);
    expect(source).not.toMatch(/\.\.\.readonlyAccountConfirmations/);
    // The discard memory is the host's alone: no second copy remains in main.
    expect(source).not.toContain("readonlyDiscardAttempts");
  });

  it("shares each const owner, constructor and main helper by reference", async () => {
    const { source, body } = await factoryBody();
    expect(body).toContain(
      " discardPreparedChatGptTask, nativeWorkspace, deriveTaskGrant, createParticipantAuthority, InMemoryAuthorityRepository, InMemoryComputerApprovalRepository, RunReadonlyComputerAction, }",
    );
    expect(source).toMatch(
      /\nconst nativeWorkspace = new NativeReadonlyWorkspace\(/,
    );
    expect(source).toMatch(/\nfunction discardPreparedChatGptTask\(/);
    // The authority constructors are still main's own imports, never a copy.
    expect(source).toContain(
      'import { RunReadonlyComputerAction } from "../../modules/computer/app/service/run-readonly-computer-action";',
    );
    expect(source).toContain(
      'import { InMemoryAuthorityRepository } from "../../modules/computer/infra/repo/in-memory-authorities";',
    );
    expect(source).toContain(
      'import { InMemoryComputerApprovalRepository } from "../../modules/computer/infra/repo/in-memory-computer-approvals";',
    );
    expect(flat(source)).toContain(
      'import { createParticipantAuthority, deriveTaskGrant, } from "../../modules/computer/domain/execution-authority";',
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
        "function verificationWorkspaceAction( settings: ProductSettings, workspace: ApprovedProductWorkspace, expiresAt: number, ): VerificationWorkspaceAction | null {",
        "readonlyHost().verificationWorkspaceAction( settings, workspace, expiresAt, )",
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
      'const ownerId = "owner-desktop";',
      "desktop-command-session",
      "desktop-command-task",
      "desktop-command-main",
      "desktop-command-authority-",
      "withdrawReadIntent",
      "approvalCapabilities",
      "identityBoundWorkspaces",
      "deriveTaskGrant(approval",
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
