import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { StagedChatGptAttachment } from "../../src/apps/desktop/chatgpt-attachment-staging";

const electronMock = vi.hoisted(() => ({
  fromPartition: vi.fn(),
}));
const attachmentMock = vi.hoisted(() => ({
  upload: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: class {},
  session: { fromPartition: electronMock.fromPartition },
}));

vi.mock("../../src/apps/desktop/chatgpt-attachment-upload", () => ({
  uploadChatGptAttachments: attachmentMock.upload,
}));

import {
  ChatGptRoute,
  type ChatGptRouteSurfaceFactory,
} from "../../src/apps/desktop/chatgpt-route";

const prepared = {
  ready: true,
  baselineAssistantCount: 0,
  baselineUserCount: 0,
} as const;

const attachment: StagedChatGptAttachment = {
  name: "evidence.md",
  mimeType: "text/markdown",
  bytes: 8,
  sha256: "a".repeat(64),
  stagedPath: "/private/tmp/evidence.md",
};

function route(): ChatGptRoute {
  return new ChatGptRoute({
    homeUrl: "https://chatgpt.com/",
    initialUrl: "https://chatgpt.com/",
    e2eOrigin: null,
    parent: () => null,
  });
}

function taskRoute(executeJavaScript: ReturnType<typeof vi.fn>): ChatGptRoute {
  const candidate = route();
  vi.spyOn(candidate, "open").mockResolvedValue({ status: "opened" });
  vi.spyOn(candidate, "observe").mockResolvedValue({
    state: "authenticated",
    code: null,
  });
  Reflect.set(candidate, "routeWindow", {
    isDestroyed: () => false,
    webContents: {
      executeJavaScript,
      getURL: () => "https://chatgpt.com/",
    },
  });
  return candidate;
}

function streamingTaskRoute(
  executeJavaScript: ReturnType<typeof vi.fn>,
): ChatGptRoute {
  const candidate = new ChatGptRoute({
    homeUrl: "https://chatgpt.com/",
    initialUrl: "https://chatgpt.com/",
    e2eOrigin: null,
    parent: () => null,
    taskPollMs: 1,
    taskTimeoutMs: 1_000,
  });
  vi.spyOn(candidate, "open").mockResolvedValue({ status: "opened" });
  vi.spyOn(candidate, "observe").mockResolvedValue({
    state: "authenticated",
    code: null,
  });
  Reflect.set(candidate, "routeWindow", {
    isDestroyed: () => false,
    webContents: {
      executeJavaScript,
      getURL: () => "https://chatgpt.com/",
    },
  });
  return candidate;
}

function harden(
  routeCandidate: ChatGptRoute,
  sharedSession: EventEmitter,
): void {
  const hardenSession = Reflect.get(routeCandidate, "hardenSession") as (
    this: ChatGptRoute,
    routeSession: EventEmitter,
  ) => void;
  hardenSession.call(routeCandidate, sharedSession);
  Reflect.set(routeCandidate, "routeSession", sharedSession);
}

function embeddedSurface() {
  let url = "about:blank";
  const contents = Object.assign(new EventEmitter(), {
    getURL: () => url,
    isDestroyed: () => false,
    setWindowOpenHandler: vi.fn(),
  });
  const closing = new Set<() => void>();
  const closed = new Set<() => void>();
  return {
    kind: "embedded" as const,
    webContents: contents,
    isDestroyed: vi.fn(() => false),
    loadURL: vi.fn(async (nextUrl: string) => {
      url = nextUrl;
    }),
    reveal: vi.fn(),
    focus: vi.fn(),
    setTitle: vi.fn(),
    destroy: vi.fn(() => {
      for (const listener of closing) listener();
      for (const listener of closed) listener();
    }),
    onPageTitleUpdated: vi.fn(),
    onClosing: vi.fn((listener: () => void) => closing.add(listener)),
    onClosed: vi.fn((listener: () => void) => closed.add(listener)),
  };
}

beforeEach(() => {
  const routeSession = Object.assign(new EventEmitter(), {
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
  });
  electronMock.fromPartition.mockReset();
  electronMock.fromPartition.mockReturnValue(routeSession);
  attachmentMock.upload.mockReset();
  attachmentMock.upload.mockResolvedValue({ status: "ready" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ChatGPT route submission boundary", () => {
  it("keeps a lost send acknowledgement outcome unknown without retrying", async () => {
    let submissions = 0;
    const executeJavaScript = vi
      .fn()
      .mockResolvedValueOnce(prepared)
      .mockImplementationOnce(async () => {
        submissions += 1;
        throw new Error("bridge lost after click");
      });

    await expect(
      taskRoute(executeJavaScript).runReadonlyTask("read the selected file"),
    ).resolves.toMatchObject({
      state: "outcome_unknown",
      code: "CHATGPT_TASK_ERROR",
    });
    expect(submissions).toBe(1);
    expect(executeJavaScript).toHaveBeenCalledTimes(2);
  });

  it("treats a malformed send acknowledgement as unknown without retrying", async () => {
    const executeJavaScript = vi
      .fn()
      .mockResolvedValueOnce(prepared)
      .mockResolvedValueOnce({ malformed: true });
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(3_000)
      .mockReturnValueOnce(6_000)
      .mockReturnValue(9_000);

    await expect(
      taskRoute(executeJavaScript).runReadonlyTask("read the selected file"),
    ).resolves.toMatchObject({
      state: "outcome_unknown",
      code: "CHATGPT_TASK_ERROR",
    });
    expect(executeJavaScript).toHaveBeenCalledTimes(2);
  });

  it("keeps a positively observed pre-click refusal retry-safe", async () => {
    const executeJavaScript = vi
      .fn()
      .mockResolvedValueOnce(prepared)
      .mockResolvedValueOnce({ activated: false });
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(3_000)
      .mockReturnValueOnce(6_000)
      .mockReturnValue(9_000);

    await expect(
      taskRoute(executeJavaScript).runReadonlyTask("read the selected file"),
    ).resolves.toMatchObject({
      state: "failed_before_submit",
      code: "CHATGPT_SUBMIT_UNAVAILABLE",
    });
    expect(executeJavaScript).toHaveBeenCalledTimes(2);
  });

  it("uses the same unknown boundary after an attachment upload", async () => {
    let submissions = 0;
    const executeJavaScript = vi
      .fn()
      .mockResolvedValueOnce(prepared)
      .mockImplementationOnce(async () => {
        submissions += 1;
        throw new Error("bridge lost after attachment send");
      });

    await expect(
      taskRoute(executeJavaScript).runReadonlyTask("inspect evidence", [
        attachment,
      ]),
    ).resolves.toMatchObject({
      state: "outcome_unknown",
      code: "CHATGPT_TASK_ERROR",
    });
    expect(attachmentMock.upload).toHaveBeenCalledTimes(1);
    expect(submissions).toBe(1);
    expect(executeJavaScript).toHaveBeenCalledTimes(2);
  });
});

describe("ChatGPT route streaming observation", () => {
  const probe = (
    assistantText: string,
    input: Readonly<{ busy: boolean; sendVisible: boolean }>,
  ) => ({
    assistantCount: 1,
    assistantCharacters: assistantText.length,
    assistantText,
    userCount: 1,
    busy: input.busy,
    sendVisible: input.sendVisible,
    signInVisible: false,
    errorVisible: false,
  });

  it("delivers exact incremental text before the terminal result", async () => {
    const executeJavaScript = vi
      .fn()
      .mockResolvedValueOnce(prepared)
      .mockResolvedValueOnce({ activated: true })
      .mockResolvedValueOnce(probe("Hel", { busy: true, sendVisible: false }))
      .mockResolvedValueOnce(probe("Hello", { busy: true, sendVisible: false }))
      .mockResolvedValueOnce(probe("Hello", { busy: false, sendVisible: true }))
      .mockResolvedValueOnce(probe("Hello", { busy: false, sendVisible: true }))
      .mockResolvedValueOnce(
        probe("Hello", { busy: false, sendVisible: true }),
      );
    const deltas: unknown[] = [];

    await expect(
      streamingTaskRoute(executeJavaScript).runReadonlyTask(
        "reply with a greeting",
        [],
        {
          onTextDelta: (delta) => {
            deltas.push(delta);
          },
        },
      ),
    ).resolves.toEqual({
      state: "completed",
      code: null,
      deltaCount: 2,
      observedCharacters: 5,
      outputText: "Hello",
    });
    expect(deltas).toEqual([
      {
        sequence: 1,
        delta: "Hel",
        text: "Hel",
        observedCharacters: 3,
      },
      {
        sequence: 2,
        delta: "lo",
        text: "Hello",
        observedCharacters: 5,
      },
    ]);
  });

  it("refuses a non-prefix rewrite after text was delivered", async () => {
    const executeJavaScript = vi
      .fn()
      .mockResolvedValueOnce(prepared)
      .mockResolvedValueOnce({ activated: true })
      .mockResolvedValueOnce(probe("Alpha", { busy: true, sendVisible: false }))
      .mockResolvedValueOnce(
        probe("Omega", { busy: true, sendVisible: false }),
      );
    const deltas: unknown[] = [];

    await expect(
      streamingTaskRoute(executeJavaScript).runReadonlyTask("reply once", [], {
        onTextDelta: (delta) => {
          deltas.push(delta);
        },
      }),
    ).resolves.toEqual({
      state: "outcome_unknown",
      code: "CHATGPT_TASK_OUTPUT_CHANGED",
      deltaCount: 1,
      observedCharacters: 5,
      outputText: "Alpha",
    });
    expect(deltas).toHaveLength(1);
  });
});

describe("ChatGPT embedded task surface", () => {
  it("retains an exact owned conversation binding before the surface reopens", () => {
    const candidate = new ChatGptRoute({
      homeUrl: "https://chatgpt.com/",
      initialUrl: "https://chatgpt.com/c/task-owned-after-restart",
      e2eOrigin: null,
      parent: () => null,
    });

    expect(candidate.currentConversationUrl()).toBeNull();
    expect(candidate.retainedConversationUrl()).toBe(
      "https://chatgpt.com/c/task-owned-after-restart",
    );
  });

  it("clears the durable conversation binding when the source is retired", () => {
    const onConversationChanged = vi.fn();
    const candidate = new ChatGptRoute({
      homeUrl: "https://chatgpt.com/",
      initialUrl: "https://chatgpt.com/c/task-owned-before-retirement",
      e2eOrigin: null,
      parent: () => null,
      onConversationChanged,
    });

    candidate.resetConversation();

    expect(candidate.retainedConversationUrl()).toBeNull();
    expect(onConversationChanged).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("uses the injected task-owned surface without creating a separate window", async () => {
    const surface = embeddedSurface();
    const surfaceFactory = vi.fn(() => surface);
    const candidate = new ChatGptRoute({
      homeUrl: "https://chatgpt.com/",
      initialUrl: "https://chatgpt.com/c/task-owned-surface",
      e2eOrigin: null,
      parent: () => null,
      surfaceFactory: surfaceFactory as unknown as ChatGptRouteSurfaceFactory,
    });

    await expect(candidate.open()).resolves.toEqual({ status: "opened" });
    expect(surfaceFactory).toHaveBeenCalledTimes(1);
    expect(surfaceFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "ChatGPT · Farol Next",
        webPreferences: expect.objectContaining({
          partition: "persist:farol-next-chatgpt",
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        }),
      }),
    );
    expect(surface.loadURL).toHaveBeenCalledWith(
      "https://chatgpt.com/c/task-owned-surface",
    );
    expect(surface.reveal).toHaveBeenCalledTimes(1);
    expect(surface.focus).toHaveBeenCalledTimes(1);

    candidate.dispose();
    expect(surface.destroy).toHaveBeenCalledTimes(1);
  });
});

describe("ChatGPT shared partition lifecycle", () => {
  it("keeps one download guard across repeated route disposal", () => {
    const sharedSession = new EventEmitter() as EventEmitter & {
      setPermissionRequestHandler: ReturnType<typeof vi.fn>;
      setPermissionCheckHandler: ReturnType<typeof vi.fn>;
    };
    sharedSession.setMaxListeners(0);
    sharedSession.setPermissionRequestHandler = vi.fn();
    sharedSession.setPermissionCheckHandler = vi.fn();

    for (let cycle = 0; cycle < 25; cycle += 1) {
      const candidate = route();
      harden(candidate, sharedSession);
      candidate.dispose();
    }

    expect(sharedSession.listenerCount("will-download")).toBe(1);
    const event = { preventDefault: vi.fn() };
    sharedSession.emit("will-download", event);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(sharedSession.setPermissionRequestHandler).toHaveBeenCalledTimes(1);
    expect(sharedSession.setPermissionCheckHandler).toHaveBeenCalledTimes(1);
  });
});
