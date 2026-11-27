import { describe, expect, it, vi } from "vitest";

import { uploadChatGptAttachments } from "../../src/apps/desktop/chatgpt-attachment-upload";

const attachments = [
  {
    name: "evidence.png",
    mimeType: "image/png" as const,
    bytes: 68,
    sha256: "a".repeat(64),
    stagedPath: "/private/staging/evidence.png",
  },
  {
    name: "notes.md",
    mimeType: "text/markdown" as const,
    bytes: 20,
    sha256: "b".repeat(64),
    stagedPath: "/private/staging/notes.md",
  },
] as const;

function harness(
  scripts: readonly unknown[],
  attached = false,
): Readonly<{
  contents: Parameters<typeof uploadChatGptAttachments>[0];
  executeJavaScript: ReturnType<typeof vi.fn>;
  sendCommand: ReturnType<typeof vi.fn>;
  attach: ReturnType<typeof vi.fn>;
  detach: ReturnType<typeof vi.fn>;
}> {
  let isAttached = attached;
  const executeJavaScript = vi.fn();
  for (const result of scripts) executeJavaScript.mockResolvedValueOnce(result);
  const sendCommand = vi.fn(async (method: string) => {
    if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
    if (method === "DOM.querySelector") return { nodeId: 2 };
    return {};
  });
  const attach = vi.fn(() => {
    isAttached = true;
  });
  const detach = vi.fn(() => {
    isAttached = false;
  });
  return {
    contents: {
      executeJavaScript,
      debugger: {
        isAttached: () => isAttached,
        attach,
        detach,
        sendCommand,
      },
    },
    executeJavaScript,
    sendCommand,
    attach,
    detach,
  };
}

describe("ChatGPT attachment upload", () => {
  it("sets the exact staged files and waits for visible completed chips", async () => {
    const test = harness([
      { found: true },
      {
        inputCount: 2,
        namesVisible: true,
        sendReady: true,
        errorVisible: false,
      },
    ]);

    await expect(
      uploadChatGptAttachments(test.contents, attachments),
    ).resolves.toEqual({ status: "ready" });
    expect(test.attach).toHaveBeenCalledWith("1.3");
    expect(test.sendCommand).toHaveBeenCalledWith("DOM.setFileInputFiles", {
      nodeId: 2,
      files: attachments.map((attachment) => attachment.stagedPath),
    });
    expect(test.detach).toHaveBeenCalledTimes(1);
  });

  it("never sets files when the turn is cancelled while a debugger command is pending", async () => {
    let cancelled = false;
    const test = harness([{ found: true }]);
    let release: () => void = () => undefined;
    test.sendCommand.mockImplementation(async (method: string) => {
      if (method === "DOM.getDocument") {
        // The Cancel arrives while this read of the page is pending.
        await new Promise<void>((resolve) => {
          release = resolve;
          cancelled = true;
        });
        return { root: { nodeId: 1 } };
      }
      if (method === "DOM.querySelector") return { nodeId: 2 };
      return {};
    });
    const upload = uploadChatGptAttachments(test.contents, attachments, {
      cancelled: () => cancelled,
    });
    await vi.waitFor(() => expect(release).not.toBe(undefined));
    await new Promise((resolve) => setTimeout(resolve, 5));
    release();
    await expect(upload).resolves.toMatchObject({ status: "failed" });
    const methods = test.sendCommand.mock.calls.map(([method]) => method);
    expect(methods).not.toContain("DOM.setFileInputFiles");
    expect(methods).not.toContain("DOM.removeAttribute");
    // The debugger it attached is released.
    expect(test.detach).toHaveBeenCalledTimes(1);
  });

  it("touches nothing when the turn is cancelled while the input probe is pending", async () => {
    let cancelled = false;
    const test = harness([]);
    let answer: (value: unknown) => void = () => undefined;
    test.executeJavaScript.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
          cancelled = true;
        }),
    );
    const upload = uploadChatGptAttachments(test.contents, attachments, {
      cancelled: () => cancelled,
    });
    await vi.waitFor(() => expect(test.executeJavaScript).toHaveBeenCalled());
    answer({ found: true });
    await expect(upload).resolves.toMatchObject({ status: "failed" });
    expect(test.attach).not.toHaveBeenCalled();
    expect(test.sendCommand).not.toHaveBeenCalled();
  });

  it("sends no script at all for a turn cancelled before the upload starts", async () => {
    const test = harness([]);
    await expect(
      uploadChatGptAttachments(test.contents, attachments, {
        cancelled: () => true,
      }),
    ).resolves.toMatchObject({ status: "failed" });
    expect(test.executeJavaScript).not.toHaveBeenCalled();
    expect(test.attach).not.toHaveBeenCalled();
  });

  it("classifies a partial upload error before submit", async () => {
    const test = harness([
      { found: true },
      {
        inputCount: 1,
        namesVisible: false,
        sendReady: false,
        errorVisible: true,
      },
    ]);

    await expect(
      uploadChatGptAttachments(test.contents, attachments),
    ).resolves.toEqual({
      status: "failed",
      code: "CHATGPT_ATTACHMENT_UPLOAD_FAILED",
    });
  });

  it("fails when the page never exposes an attachment control", async () => {
    const test = harness([{ found: false }, { found: false }]);
    let now = 0;

    await expect(
      uploadChatGptAttachments(test.contents, attachments, {
        inputTimeoutMs: 1,
        uploadTimeoutMs: 1,
        pollMs: 1,
        now: () => now,
        wait: async () => {
          now += 1;
        },
      }),
    ).resolves.toEqual({
      status: "failed",
      code: "CHATGPT_ATTACHMENT_CONTROL_UNAVAILABLE",
    });
    expect(test.sendCommand).not.toHaveBeenCalled();
  });
});
