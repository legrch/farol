import { randomUUID } from "node:crypto";

import type { StagedChatGptAttachment } from "./chatgpt-attachment-staging";

export type ChatGptAttachmentUploadErrorCode =
  | "CHATGPT_ATTACHMENT_CONTROL_UNAVAILABLE"
  | "CHATGPT_ATTACHMENT_UPLOAD_FAILED"
  | "CHATGPT_ATTACHMENT_UPLOAD_TIMEOUT";

export type ChatGptAttachmentUploadResult =
  | Readonly<{ status: "ready" }>
  | Readonly<{
      status: "failed";
      code: ChatGptAttachmentUploadErrorCode;
    }>;

type DebuggerFacade = Readonly<{
  isAttached(): boolean;
  attach(version: string): void;
  detach(): void;
  sendCommand(method: string, commandParams?: object): Promise<unknown>;
}>;

export type ChatGptAttachmentContents = Readonly<{
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
  debugger: DebuggerFacade;
}>;

type UploadOptions = Readonly<{
  inputTimeoutMs?: number;
  uploadTimeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
}>;

function findAttachmentInputScript(marker: string): string {
  return `(() => {
    const marker = ${JSON.stringify(marker)};
    const inputs = [...document.querySelectorAll('input[type="file"]')]
      .filter((element) => element instanceof HTMLInputElement && !element.disabled);
    const input = inputs.at(-1);
    if (input instanceof HTMLInputElement) {
      input.setAttribute('data-farol-attachment-input', marker);
      return { found: true };
    }
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
    };
    const trigger = [...document.querySelectorAll('button,[role="button"]')]
      .find((element) => {
        if (!visible(element)) return false;
        const label = [
          element.getAttribute('aria-label') || '',
          element.getAttribute('title') || '',
          element.textContent || ''
        ].join(' ');
        return /attach|upload|add (?:photos|files)/iu.test(label);
      });
    if (trigger instanceof HTMLElement) trigger.click();
    return { found: false };
  })()`;
}

function attachmentProbeScript(names: readonly string[]): string {
  return `(() => {
    const expected = ${JSON.stringify(names)};
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
    };
    const bodyText = document.body instanceof HTMLElement ? document.body.innerText : '';
    const inputCount = Math.max(0, ...[...document.querySelectorAll('input[type="file"]')]
      .map((element) => element instanceof HTMLInputElement ? element.files?.length || 0 : 0));
    const namesVisible = expected.every((name) => bodyText.includes(name));
    const send = [
      document.querySelector('[data-testid="send-button"]'),
      document.querySelector('button[aria-label="Send prompt"]'),
      document.querySelector('button[aria-label="Send message"]')
    ].find(visible);
    const explicitError = [
      document.querySelector('[data-testid="attachment-upload-error"]'),
      document.querySelector('[data-testid="file-upload-error"]')
    ].some(visible);
    return {
      inputCount,
      namesVisible,
      sendReady: send instanceof HTMLButtonElement && !send.disabled,
      errorVisible: explicitError || /failed to upload|upload failed|could(?: not|n't) upload|unsupported file/iu.test(bodyText)
    };
  })()`;
}

function inputProbe(value: unknown): value is { found: boolean } {
  return (
    typeof value === "object" &&
    value !== null &&
    "found" in value &&
    typeof value.found === "boolean"
  );
}

function uploadProbe(value: unknown): value is {
  inputCount: number;
  namesVisible: boolean;
  sendReady: boolean;
  errorVisible: boolean;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "inputCount" in value &&
    typeof value.inputCount === "number" &&
    "namesVisible" in value &&
    typeof value.namesVisible === "boolean" &&
    "sendReady" in value &&
    typeof value.sendReady === "boolean" &&
    "errorVisible" in value &&
    typeof value.errorVisible === "boolean"
  );
}

function nodeId(candidate: unknown, path: readonly string[]): number | null {
  let current = candidate;
  for (const key of path) {
    if (typeof current !== "object" || current === null || !(key in current)) {
      return null;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "number" && current > 0 ? current : null;
}

export async function uploadChatGptAttachments(
  contents: ChatGptAttachmentContents,
  attachments: readonly StagedChatGptAttachment[],
  options: UploadOptions = {},
): Promise<ChatGptAttachmentUploadResult> {
  const now = options.now ?? Date.now;
  const wait =
    options.wait ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const pollMs = options.pollMs ?? 100;
  const marker = `farol-${randomUUID()}`;
  const inputDeadline = now() + (options.inputTimeoutMs ?? 5_000);
  let found = false;
  while (now() < inputDeadline) {
    const probe = await contents.executeJavaScript(
      findAttachmentInputScript(marker),
      true,
    );
    if (!inputProbe(probe)) {
      return {
        status: "failed",
        code: "CHATGPT_ATTACHMENT_CONTROL_UNAVAILABLE",
      };
    }
    if (probe.found) {
      found = true;
      break;
    }
    await wait(pollMs);
  }
  if (!found) {
    return {
      status: "failed",
      code: "CHATGPT_ATTACHMENT_CONTROL_UNAVAILABLE",
    };
  }

  const wasAttached = contents.debugger.isAttached();
  try {
    if (!wasAttached) contents.debugger.attach("1.3");
    const document = await contents.debugger.sendCommand("DOM.getDocument", {
      depth: -1,
      pierce: true,
    });
    const rootId = nodeId(document, ["root", "nodeId"]);
    if (rootId === null) throw new Error("ATTACHMENT_DOCUMENT_MISSING");
    const selected = await contents.debugger.sendCommand("DOM.querySelector", {
      nodeId: rootId,
      selector: `input[data-farol-attachment-input="${marker}"]`,
    });
    const inputId = nodeId(selected, ["nodeId"]);
    if (inputId === null) throw new Error("ATTACHMENT_INPUT_MISSING");
    await contents.debugger.sendCommand("DOM.setFileInputFiles", {
      nodeId: inputId,
      files: attachments.map((attachment) => attachment.stagedPath),
    });
    await contents.debugger.sendCommand("DOM.removeAttribute", {
      nodeId: inputId,
      name: "data-farol-attachment-input",
    });
  } catch {
    return {
      status: "failed",
      code: "CHATGPT_ATTACHMENT_UPLOAD_FAILED",
    };
  } finally {
    if (!wasAttached && contents.debugger.isAttached()) {
      contents.debugger.detach();
    }
  }

  const uploadDeadline = now() + (options.uploadTimeoutMs ?? 20_000);
  while (now() < uploadDeadline) {
    const probe = await contents.executeJavaScript(
      attachmentProbeScript(attachments.map((attachment) => attachment.name)),
      true,
    );
    if (!uploadProbe(probe)) {
      return {
        status: "failed",
        code: "CHATGPT_ATTACHMENT_UPLOAD_FAILED",
      };
    }
    if (probe.errorVisible) {
      return {
        status: "failed",
        code: "CHATGPT_ATTACHMENT_UPLOAD_FAILED",
      };
    }
    if (probe.namesVisible && probe.sendReady) return { status: "ready" };
    await wait(pollMs);
  }
  return {
    status: "failed",
    code: "CHATGPT_ATTACHMENT_UPLOAD_TIMEOUT",
  };
}
