import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedChatgptPorts } from "../../../tests/support/chatgpt-configuration-ports";
import {
  fixtureBuildId,
  guidedSettingsFixture,
} from "../../../tests/fixtures/guided-onboarding";
import {
  ProductConfigurationResultSchema,
  ProductSettingsSchema,
  type ProductConfigurationResult,
} from "../../../src/pkg/product-settings/contract";
import type { AccountObservationConfirmation } from "../account-observation-confirmation";
import { BridgeError } from "../bridge/client";
import type { ReadConversationClient } from "../bridge/read-conversation";
import { DesktopAdmission } from "../host/admission";
import {
  createConfigurationChatgpt,
  type ChatgptConfigurationCommand,
  type DirectChatStart,
  type GoReadonlyConversation,
  type PendingChatGptAttachmentTask,
  type PendingChatGptReadonlyTask,
} from "./chatgpt";

// These scripted ports cover command routing, refusal order, reservation order
// and one-shot handling only. They do not qualify a real ChatGPT page, the Go
// core, the private journal, a native filesystem, a live provider or a
// production profile.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-24T10:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const operationId = uuid(1);
const sessionId = uuid(2);
const confirmationId = uuid(3);
const handleId = uuid(4);
const verifiedDigest = "c".repeat(64);

type Settings = ReturnType<typeof guidedSettingsFixture>;
type Patch = Readonly<{
  chatgpt?: object;
  computer?: object;
  computerSetup?: object;
  revision?: number;
}>;

function settings(patch: Patch = {}): Settings {
  const base = guidedSettingsFixture();
  return ProductSettingsSchema.parse({
    ...base,
    revision: patch.revision ?? base.revision,
    computer: { ...base.computer, ...patch.computer },
    setup: {
      ...base.setup,
      chatgpt: { ...base.setup.chatgpt, ...patch.chatgpt },
      computer: { ...base.setup.computer, ...patch.computerSetup },
    },
  });
}

type Snapshot =
  | Readonly<{ status: "ready"; settings: Settings }>
  | Readonly<{ status: "error"; error: string }>;
const ready = (patch?: Patch): Snapshot => ({
  status: "ready",
  settings: settings(patch),
});
const unavailable: Snapshot = {
  status: "error",
  error: "SETTINGS_READ_FAILED",
};

function command(value: object): ChatgptConfigurationCommand {
  return value as ChatgptConfigurationCommand;
}

function failureOf(result: ProductConfigurationResult) {
  return result.ok ? null : result.error;
}

const projection = (cursor = "0") => ({
  handle: {
    handleId,
    binding: {
      profileId: uuid(10),
      backendGeneration: uuid(11),
      ownerId: uuid(12),
      sessionId,
      taskId: uuid(13),
      taskEpoch: "1",
      participantId: uuid(14),
      turnId: uuid(15),
      operationId,
      turnGeneration: "1",
    },
  },
  state: {
    conversationId: "conversation",
    phase: "running",
    hasResult: false,
    deliveryAcknowledged: false,
    lifecycleSettled: false,
    released: false,
    followReady: false,
  },
  frames: [],
  cursor,
});

type ConfirmationInput = Readonly<{
  current(): boolean;
  read(): Promise<unknown>;
  commit(input: {
    confirmedPrincipalKey: string;
    observation: unknown;
  }): Promise<unknown>;
}>;

function journalFake(events: string[]) {
  return {
    prepare: vi.fn(async (input: object) => {
      events.push(`journal.prepare:${JSON.stringify(input)}`);
    }),
    markDispatchIntent: vi.fn(async (id: string) => {
      events.push(`journal.markDispatchIntent:${id}`);
    }),
    retainResult: vi.fn(async (id: string, result: object) => {
      events.push(`journal.retainResult:${id}:${JSON.stringify(result)}`);
    }),
    load: vi.fn(async () => {
      events.push("journal.load");
      return { loaded: true };
    }),
    discardPrepared: vi.fn(async () => undefined),
    acknowledgeDelivery: vi.fn(async (id: string) => {
      events.push(`journal.acknowledgeDelivery:${id}`);
    }),
  };
}

// One scene scripts every port; a test changes only what its branch reads.
// `events` records the order of the effects that matter.
function scene() {
  const events: string[] = [];
  const admission = new DesktopAdmission({
    chatGptReadonlyTask: () => false,
    directChatStart: () => false,
    chatGptAttachmentTask: () => false,
    workspaceEdit: () => false,
    computer: () => false,
    codexAgent: () => false,
    hostCheck: () => false,
    connectorStart: () => false,
  });
  const route = {
    open: vi.fn(async (): Promise<{ status: string }> => {
      events.push("route.open");
      return { status: "opened" };
    }),
    openForSignIn: vi.fn(async (title: string): Promise<{ status: string }> => {
      events.push(`route.openForSignIn:${title}`);
      return { status: "opened" };
    }),
    retryFailedOpen: vi.fn(async (): Promise<{ status: string }> => {
      events.push("route.retryFailedOpen");
      return { status: "opened" };
    }),
    observe: vi.fn(
      async (): Promise<{ state: string; code: string | null }> => ({
        state: "authenticated",
        code: null,
      }),
    ),
    observeSignInStatus: vi.fn(
      async (): Promise<{
        state: string;
        binding: { documentGeneration: number; sequence: number } | null;
      }> => ({
        state: "authenticated",
        binding: { documentGeneration: 7, sequence: 2 },
      }),
    ),
    isCurrentSignInStatus: vi.fn((_observation: unknown) => true),
    returnFromSignIn: vi.fn(() => true),
    toggleSidebar: vi.fn(async () => true),
    resetConversation: vi.fn(() => {
      events.push("route.resetConversation");
    }),
    observeAccount: vi.fn(async () => ({ observed: true })),
    runReadonlyTask: vi.fn(
      async (..._arguments: unknown[]): Promise<Record<string, unknown>> => {
        events.push("route.runReadonlyTask");
        return {
          state: "completed",
          code: null,
          deltaCount: 3,
          observedCharacters: 42,
        };
      },
    ),
    currentConversationUrl: vi.fn(() => null),
  };
  const core = {
    chat: { chat: true },
    approveReadAccount: vi.fn(),
    resolveReadIntent: vi.fn(),
    promoteReadIntent: vi.fn(),
    readForIntent: vi.fn(async (..._arguments: unknown[]) => ({
      admission: { admission: "go" },
      result: {
        status: "ok",
        data: { text: "file text", bytes: 9n },
      } as Record<string, unknown>,
    })),
    withdrawReadIntent: vi.fn(),
  };
  const profileSnapshot = {
    configSHA256: verifiedDigest,
    policy: { policy: true },
    profiles: [{ profile: true }],
  };
  const state = {
    snapshot: ready() as Snapshot,
    route: route as unknown,
    core: core as unknown,
    profile: { snapshot: profileSnapshot } as unknown,
    capture: vi.fn((_input: unknown): unknown => ({
      snapshot: profileSnapshot,
    })),
    e2eOrigin: "http://127.0.0.1:4100" as string | null,
    directChatStart: null as DirectChatStart | null,
    goReadonlyConversation: null as GoReadonlyConversation | null,
    pendingReadonly: null as PendingChatGptReadonlyTask | null,
    pendingAttachment: null as PendingChatGptAttachmentTask | null,
    recoverable: null as unknown,
    observationPersisted: false,
    store: { clear: vi.fn(async () => undefined) } as unknown,
    conversation: "untouched" as unknown,
    journal: journalFake(events) as ReturnType<typeof journalFake> | null,
    signInGeneration: 0,
    signInOpenGeneration: null as number | null,
    signInOutcome: "untouched" as unknown,
    selectedTaskId: "",
    browserHome: false,
    setupSignInCheck: "untouched" as unknown,
    embedded: true,
    conversationFailure: null as ProductConfigurationResult | null,
    liveRoutes: new Map<string, unknown>(),
    confirmationScript: {
      inspect: async (): Promise<unknown> => ({
        confirmationId,
        state: "observed",
      }),
      confirm: async (_id: string): Promise<unknown> => projection(),
    },
    clientScript: {
      startAuthorized: vi.fn(async (_input: unknown) => projection("1")),
      follow: vi.fn(async (..._arguments: unknown[]) => projection("2")),
      progress: vi.fn(async (..._arguments: unknown[]) => projection("3")),
      acknowledge: vi.fn(async (..._arguments: unknown[]) => undefined),
      snapshot: vi.fn(async (..._arguments: unknown[]) => projection("4")),
      start: vi.fn(async (..._arguments: unknown[]) => projection("5")),
      canWithdrawAdmission: vi.fn(() => true),
    },
  };
  const observations: { input: ConfirmationInput }[] = [];
  class FakeObservation {
    constructor(readonly input: ConfirmationInput) {
      observations.push(this);
    }
    async inspect() {
      events.push("observation.inspect");
      return state.confirmationScript.inspect();
    }
    async confirm(id: string) {
      events.push(`observation.confirm:${id}`);
      return state.confirmationScript.confirm(id);
    }
  }
  const clients: { args: unknown[]; client: unknown }[] = [];
  class FakeClient {
    constructor(...args: unknown[]) {
      clients.push({ args, client: this });
    }
    startAuthorized = state.clientScript.startAuthorized;
    follow = state.clientScript.follow;
    progress = state.clientScript.progress;
    acknowledge = state.clientScript.acknowledge;
    snapshot = state.clientScript.snapshot;
    start = state.clientScript.start;
    canWithdrawAdmission = state.clientScript.canWithdrawAdmission;
  }
  const failure = (error: string): ProductConfigurationResult =>
    ProductConfigurationResultSchema.parse({
      ok: false,
      error,
      snapshot:
        state.snapshot.status === "ready"
          ? state.snapshot
          : { status: "error", error: "SETTINGS_READ_FAILED" },
    });
  const okResult = (extra: object = {}) => ({
    ok: true,
    snapshot: state.snapshot,
    ...extra,
  });
  const configuration = {
    snapshot: vi.fn(() => state.snapshot),
    markSetupVisited: vi.fn(async (step: string) => {
      events.push(`markSetupVisited:${step}`);
      return okResult();
    }),
    recordChatGptObservation: vi.fn(async (observation: unknown) => {
      events.push(`recordChatGptObservation:${JSON.stringify(observation)}`);
      return okResult();
    }),
  };
  const ports = scriptedChatgptPorts({
    configuration: () => configuration as never,
    chatGptRoute: () => state.route as never,
    chatGptE2eOrigin: () => state.e2eOrigin,
    desktopGoCore: () => state.core as never,
    goChatStartupProfile: () => state.profile as never,
    directChatStart: () => state.directChatStart,
    setDirectChatStart: (value) => {
      state.directChatStart = value;
      events.push(`setDirectChatStart:${value === null ? "null" : "value"}`);
    },
    goReadonlyConversation: () => state.goReadonlyConversation,
    setGoReadonlyConversation: (value) => {
      state.goReadonlyConversation = value;
      events.push(
        `setGoReadonlyConversation:${value === null ? "null" : "value"}`,
      );
    },
    pendingChatGptReadonlyTask: () => state.pendingReadonly,
    pendingChatGptAttachmentTask: () => state.pendingAttachment,
    recoverableChatGptTask: () => state.recoverable as never,
    setRecoverableChatGptTask: (value) => {
      state.recoverable = value;
      events.push(
        `setRecoverableChatGptTask:${value === null ? "null" : "value"}`,
      );
    },
    recoverableChatGptObservationPersisted: () => state.observationPersisted,
    setRecoverableChatGptObservationPersisted: (value) => {
      state.observationPersisted = value;
      events.push(`setRecoverableChatGptObservationPersisted:${value}`);
    },
    chatGptConversationStore: () => state.store as never,
    setChatGptConversation: (value) => {
      state.conversation = value;
      events.push("setChatGptConversation:null");
    },
    chatGptTaskJournal: () => state.journal as never,
    chatGptSignInGeneration: () => state.signInGeneration,
    setChatGptSignInGeneration: (value) => {
      state.signInGeneration = value;
      events.push(`setChatGptSignInGeneration:${value}`);
    },
    chatGptSignInOpenGeneration: () => state.signInOpenGeneration,
    setChatGptSignInOpenGeneration: (value) => {
      state.signInOpenGeneration = value;
      events.push(`setChatGptSignInOpenGeneration:${value}`);
    },
    setChatGptSignInOutcome: (value) => {
      state.signInOutcome = value;
      events.push("setChatGptSignInOutcome:null");
    },
    selectedTaskId: () => state.selectedTaskId,
    browserHomeSurfaceOpen: () => state.browserHome,
    setBrowserHomeSurfaceOpen: (value) => {
      state.browserHome = value;
      events.push(`setBrowserHomeSurfaceOpen:${value}`);
    },
    setSetupSignInCheck: (value) => {
      state.setupSignInCheck = value;
      events.push(`setSetupSignInCheck:${value === null ? "null" : "value"}`);
    },
    desktopAdmission: admission,
    chatGptSignInBlocked: {
      beginAttempt: () => {
        events.push("beginAttempt");
      },
    },
    liveTaskRoutes: state.liveRoutes as never,
    buildIdentity: { buildId: fixtureBuildId },
    activeDesktopIdentity: { chatGptPartition: "fixture-partition" },
    configurationFailure: failure,
    embeddedBrowserEnabled: () => state.embedded,
    applyLayout: () => {
      events.push("applyLayout");
    },
    chatGptConversationContinuity: () => "not_observed",
    chatGptJournalObservation: (result) => ({ journal: result }),
    captureChatStartupProfile: state.capture as never,
    ReadConversationClient:
      FakeClient as unknown as typeof ReadConversationClient,
    AccountObservationConfirmation:
      FakeObservation as unknown as typeof AccountObservationConfirmation,
  });
  const handler = createConfigurationChatgpt(ports);
  return {
    events,
    admission,
    route,
    core,
    state,
    configuration,
    observations,
    clients,
    ports,
    failure,
    clientScript: state.clientScript,
    run: (value: object) => handler.configureAdmittedChatgpt(command(value)),
  };
}

type Scene = ReturnType<typeof scene>;

function directStart(s: Scene, extra: Partial<DirectChatStart> = {}) {
  const client = new (
    s.ports.ReadConversationClient as never as new (
      ...args: unknown[]
    ) => ReadConversationClient
  )();
  const start: DirectChatStart = {
    operationId,
    sessionId,
    core: s.core as never,
    client,
    confirmation: {
      confirm: async (id: string) => s.state.confirmationScript.confirm(id),
    } as never,
    inspection: Promise.resolve(s.failure("SETTINGS_UNAVAILABLE")),
    ...extra,
  };
  s.state.directChatStart = start;
  return start;
}

function activeConversation(
  s: Scene,
  extra: Partial<GoReadonlyConversation> = {},
) {
  const client = new (
    s.ports.ReadConversationClient as never as new (
      ...args: unknown[]
    ) => ReadConversationClient
  )();
  const active: GoReadonlyConversation = {
    pending: null,
    operationId,
    core: s.core as never,
    client,
    start: Promise.resolve(s.failure("SETTINGS_UNAVAILABLE")),
    ...extra,
  };
  s.state.goReadonlyConversation = active;
  return active;
}

describe("chatgpt.inspect-chat-account", () => {
  const inspect = { kind: "chatgpt.inspect-chat-account", operationId };

  it.each([
    ["route", (s: Scene) => (s.state.route = null)],
    ["core", (s: Scene) => (s.state.core = null)],
    ["profile", (s: Scene) => (s.state.profile = null)],
    ["settings", (s: Scene) => (s.state.snapshot = unavailable)],
  ])("refuses an unavailable %s before any other check", async (_name, set) => {
    const s = scene();
    set(s);
    s.state.directChatStart = {} as DirectChatStart;
    expect(failureOf(await s.run(inspect))).toBe("CHATGPT_ROUTE_UNAVAILABLE");
    expect(s.clients).toHaveLength(0);
    expect(s.state.capture).not.toHaveBeenCalled();
  });

  it.each([
    ["a retained inspection", (s: Scene) => directStart(s)],
    ["a readonly conversation", (s: Scene) => activeConversation(s)],
    [
      "a chat task admission",
      (s: Scene) => void s.admission.reserveAdmitted("chatgpt-task"),
    ],
    [
      "a pending readonly preview",
      (s: Scene) => (s.state.pendingReadonly = {} as never),
    ],
    [
      "a pending attachment preview",
      (s: Scene) => (s.state.pendingAttachment = {} as never),
    ],
    ["a recoverable task result", (s: Scene) => (s.state.recoverable = {})],
    [
      "an unknown ChatGPT outcome",
      (s: Scene) =>
        (s.state.snapshot = ready({ chatgpt: { outcomeUnknown: true } })),
    ],
    ["an installed update", (s: Scene) => void s.admission.enterUpdate()],
    ["a quit", (s: Scene) => s.admission.beginQuit()],
  ])("refuses while %s is present", async (_name, set) => {
    const s = scene();
    set(s);
    const built = s.clients.length;
    expect(failureOf(await s.run(inspect))).toBe("CHATGPT_TASK_IN_PROGRESS");
    expect(s.clients).toHaveLength(built);
    expect(s.state.capture).not.toHaveBeenCalled();
  });

  it.each([
    [
      "the profile capture throws",
      (s: Scene) =>
        s.state.capture.mockImplementation(() => {
          throw new Error("refused");
        }),
    ],
    [
      "no profile is captured",
      (s: Scene) => s.state.capture.mockReturnValue(null),
    ],
    [
      "the captured digest differs",
      (s: Scene) =>
        s.state.capture.mockReturnValue({
          snapshot: { configSHA256: "d".repeat(64) },
        }),
    ],
  ])("refuses when %s", async (_name, set) => {
    const s = scene();
    set(s);
    expect(failureOf(await s.run(inspect))).toBe("CHATGPT_ROUTE_UNAVAILABLE");
    expect(s.clients).toHaveLength(0);
    expect(s.state.directChatStart).toBeNull();
  });

  it("captures the current profile from the runtime state and retains one inspection", async () => {
    const s = scene();
    let retainedDuringInspection: DirectChatStart | null = null;
    let heldDuringInspection = false;
    s.state.confirmationScript.inspect = async () => {
      retainedDuringInspection = s.state.directChatStart;
      heldDuringInspection = s.admission.occupied("chatgpt-task");
      return { confirmationId, state: "observed" };
    };
    const result = await s.run(inspect);
    expect(result).toMatchObject({
      ok: true,
      evidence: {
        kind: "chatgpt.chat-account-preview",
        operationId,
        confirmationId,
        state: "observed",
      },
    });
    const evidence = result.ok ? result.evidence : undefined;
    expect(evidence).toMatchObject({ sessionId: expect.any(String) });
    expect(s.state.capture).toHaveBeenCalledWith({
      environment: "dev",
      e2e: process.env.FAROL_E2E === "1",
      origin: "http://127.0.0.1:4100",
      tasks:
        s.state.snapshot.status === "ready" && s.state.snapshot.settings.tasks,
    });
    expect(s.clients).toHaveLength(1);
    expect(s.clients[0]!.args).toEqual([null, s.core.chat]);
    // The retained inspection is published before the confirmation runs, and
    // the chat lane is held only while it runs.
    expect(retainedDuringInspection).toBe(s.state.directChatStart);
    expect(heldDuringInspection).toBe(true);
    expect(s.admission.occupied("chatgpt-task")).toBe(false);
    expect(s.state.directChatStart).toMatchObject({
      operationId,
      core: s.core,
      client: s.clients[0]!.client,
    });
    expect(await s.state.directChatStart!.inspection).toBe(result);
    expect(s.events.indexOf("setDirectChatStart:value")).toBeLessThan(
      s.events.indexOf("observation.inspect"),
    );
  });

  it("commits through the retained start only while the inspection is current", async () => {
    const s = scene();
    await s.run(inspect);
    const input = s.observations[0]!.input;
    expect(input.current()).toBe(true);
    // No start was retained yet: the commit port refuses before any request.
    expect(() =>
      input.commit({ confirmedPrincipalKey: "key", observation: {} }),
    ).toThrow(
      expect.objectContaining({
        state: "refused",
        code: "CHATGPT_ACCOUNT_CONFIRMATION_INVALID",
      }),
    );
    expect(s.clientScript.startAuthorized).not.toHaveBeenCalled();
    s.state.directChatStart!.start = {
      command: command({
        kind: "chatgpt.start-conversation",
        operationId,
        confirmationId,
        prompt: "hello",
      }) as never,
      promise: Promise.resolve(s.failure("SETTINGS_UNAVAILABLE")),
    };
    await input.commit({
      confirmedPrincipalKey: "principal",
      observation: { account: true },
    });
    expect(s.clientScript.startAuthorized).toHaveBeenCalledTimes(1);
    expect(s.clientScript.startAuthorized.mock.calls[0]![0]).toMatchObject({
      prompt: "hello",
      policy: { policy: true },
      profiles: [{ profile: true }],
      requested: {},
      confirmedPrincipalKey: "principal",
      observation: { account: true },
    });
    expect(
      (
        s.clientScript.startAuthorized.mock.calls[0]![0] as {
          sessionId: string;
        }
      ).sessionId,
    ).toBe(s.state.directChatStart!.sessionId);
  });

  it.each([
    [
      "the settings revision moves",
      (s: Scene) => (s.state.snapshot = ready({ revision: 9 })),
    ],
    [
      "settings become unavailable",
      (s: Scene) => (s.state.snapshot = unavailable),
    ],
    [
      "the outcome becomes unknown",
      (s: Scene) =>
        (s.state.snapshot = ready({ chatgpt: { outcomeUnknown: true } })),
    ],
    [
      "another inspection replaces it",
      (s: Scene) =>
        (s.state.directChatStart = {
          ...s.state.directChatStart!,
          operationId: uuid(77),
        }),
    ],
    ["the Go core is replaced", (s: Scene) => (s.state.core = {})],
    ["the route is replaced", (s: Scene) => (s.state.route = {})],
    ["the startup profile is replaced", (s: Scene) => (s.state.profile = {})],
    ["an update is admitted", (s: Scene) => void s.admission.enterUpdate()],
    ["the application quits", (s: Scene) => s.admission.beginQuit()],
  ])("stops being current when %s", async (_name, change) => {
    const s = scene();
    await s.run(inspect);
    const input = s.observations[0]!.input;
    expect(input.current()).toBe(true);
    change(s);
    expect(input.current()).toBe(false);
  });

  it.each([
    [
      "a refused confirmation",
      new BridgeError("refused", "CHATGPT_ACCOUNT_UNAVAILABLE"),
      "CHATGPT_ACCOUNT_CONFIRMATION_INVALID",
    ],
    [
      "an unknown bridge outcome",
      new BridgeError("unknown", "lost"),
      "CHATGPT_CONVERSATION_UNCONFIRMED",
    ],
    ["a plain failure", new Error("boom"), "CHATGPT_CONVERSATION_UNCONFIRMED"],
  ])("classifies %s and releases the chat lane", async (_name, error, code) => {
    const s = scene();
    s.state.confirmationScript.inspect = async () => {
      throw error;
    };
    expect(failureOf(await s.run(inspect))).toBe(code);
    expect(s.admission.occupied("chatgpt-task")).toBe(false);
  });
});

describe("chatgpt.start-conversation", () => {
  const start = {
    kind: "chatgpt.start-conversation",
    operationId,
    confirmationId,
    prompt: "hello",
  };
  const refusals: [string, (s: Scene) => void][] = [
    ["no retained inspection", (s) => (s.state.directChatStart = null)],
    ["another operation", (s) => directStart(s, { operationId: uuid(77) })],
    [
      "a start already retained",
      (s) =>
        directStart(s, {
          start: {
            command: command(start) as never,
            promise: Promise.resolve(s.failure("SETTINGS_UNAVAILABLE")),
          },
        }),
    ],
    [
      "an active readonly conversation",
      (s) => {
        directStart(s);
        activeConversation(s);
      },
    ],
    [
      "a chat task admission",
      (s) => {
        directStart(s);
        s.admission.reserveAdmitted("chatgpt-task");
      },
    ],
    [
      "a replaced Go core",
      (s) => {
        directStart(s);
        s.state.core = {};
      },
    ],
  ];

  it.each(refusals)("refuses with %s", async (_name, set) => {
    const s = scene();
    if (_name === "no retained inspection") set(s);
    else if (_name === "another operation") set(s);
    else set(s);
    expect(failureOf(await s.run(start))).toBe("CHATGPT_CONVERSATION_REFUSED");
    expect(s.events).toEqual([]);
  });

  it("pins the readonly conversation before any await and confirms the captured command", async () => {
    const s = scene();
    const pending = directStart(s);
    const confirm = vi.fn(async (_id: string): Promise<unknown> =>
      projection(),
    );
    s.state.confirmationScript.confirm = confirm;
    const original = { ...start };
    const running = s.run(original);
    // Published before the first await: a repeated IPC cannot start another.
    expect(pending.start).toBeDefined();
    expect(s.state.goReadonlyConversation).toMatchObject({
      pending: null,
      operationId,
      core: s.core,
      client: pending.client,
      start: pending.start!.promise,
    });
    original.confirmationId = uuid(88);
    original.prompt = "changed";
    expect(pending.start!.command).toMatchObject({
      confirmationId,
      prompt: "hello",
    });
    const result = await running;
    expect(result).toMatchObject({
      ok: true,
      evidence: {
        kind: "chatgpt.readonly-conversation",
        operationId,
        handleId,
      },
    });
    expect(confirm).toHaveBeenCalledExactlyOnceWith(confirmationId);
    expect(s.admission.occupied("chatgpt-task")).toBe(false);
  });

  it("holds the chat lane while the confirmation runs", async () => {
    const s = scene();
    directStart(s);
    let held = false;
    s.state.confirmationScript.confirm = async () => {
      held = s.admission.occupied("chatgpt-task");
      return projection();
    };
    await s.run(start);
    expect(held).toBe(true);
  });

  it.each([
    [
      "a refused confirmation",
      new BridgeError("refused", "CHATGPT_ACCOUNT_CONFIRMATION_INVALID"),
      "CHATGPT_CONVERSATION_REFUSED",
    ],
    [
      "an unknown outcome",
      new BridgeError("unknown", "lost"),
      "CHATGPT_CONVERSATION_UNCONFIRMED",
    ],
    ["a plain failure", new Error("boom"), "CHATGPT_CONVERSATION_UNCONFIRMED"],
  ])(
    "classifies %s, releases the lane and keeps the attempt pinned",
    async (_name, error, code) => {
      const s = scene();
      directStart(s);
      s.state.confirmationScript.confirm = async () => {
        throw error;
      };
      expect(failureOf(await s.run(start))).toBe(code);
      expect(s.admission.occupied("chatgpt-task")).toBe(false);
      // The attempt is never retried or unpinned: a second start is refused.
      expect(failureOf(await s.run(start))).toBe(
        "CHATGPT_CONVERSATION_REFUSED",
      );
    },
  );
});

describe("chatgpt readonly conversation commands", () => {
  const observe = {
    kind: "chatgpt.observe-readonly-conversation",
    operationId,
    handleId,
    cursor: "3",
  };
  const acknowledge = {
    kind: "chatgpt.ack-readonly-conversation",
    operationId,
    handleId,
    resultId: uuid(5),
    cursor: "4",
  };
  const follow = {
    kind: "chatgpt.follow-readonly-conversation",
    operationId,
    handleId,
    prompt: "more",
  };

  it.each([observe, acknowledge, follow])(
    "refuses $kind without a matching active conversation",
    async (value) => {
      const s = scene();
      expect(failureOf(await s.run(value))).toBe(
        "CHATGPT_CONVERSATION_REFUSED",
      );
      activeConversation(s, { operationId: uuid(77) });
      expect(failureOf(await s.run(value))).toBe(
        "CHATGPT_CONVERSATION_REFUSED",
      );
      activeConversation(s);
      s.state.core = {};
      expect(failureOf(await s.run(value))).toBe(
        "CHATGPT_CONVERSATION_REFUSED",
      );
      expect(s.clientScript.follow).not.toHaveBeenCalled();
      expect(s.clientScript.progress).not.toHaveBeenCalled();
      expect(s.clientScript.acknowledge).not.toHaveBeenCalled();
    },
  );

  it("follows through the original client", async () => {
    const s = scene();
    activeConversation(s);
    const result = await s.run(follow);
    expect(s.clientScript.follow).toHaveBeenCalledExactlyOnceWith(
      handleId,
      "more",
    );
    expect(result).toMatchObject({
      ok: true,
      evidence: { kind: "chatgpt.readonly-conversation", cursor: "2" },
    });
  });

  it("observes progress from the cursor", async () => {
    const s = scene();
    activeConversation(s);
    const result = await s.run(observe);
    expect(s.clientScript.progress).toHaveBeenCalledExactlyOnceWith(
      handleId,
      "3",
    );
    expect(result).toMatchObject({ ok: true, evidence: { cursor: "3" } });
  });

  it("acknowledges the result before reading the snapshot", async () => {
    const s = scene();
    activeConversation(s);
    const order: string[] = [];
    s.clientScript.acknowledge.mockImplementation(async () => {
      order.push("acknowledge");
    });
    s.clientScript.snapshot.mockImplementation(async () => {
      order.push("snapshot");
      return projection("4");
    });
    const result = await s.run(acknowledge);
    expect(order).toEqual(["acknowledge", "snapshot"]);
    expect(s.clientScript.acknowledge).toHaveBeenCalledWith(handleId, uuid(5));
    expect(s.clientScript.snapshot).toHaveBeenCalledWith(handleId, "4");
    expect(result).toMatchObject({ ok: true, evidence: { cursor: "4" } });
  });

  it("does not read a snapshot after a failed acknowledgement", async () => {
    const s = scene();
    activeConversation(s);
    s.clientScript.acknowledge.mockRejectedValue(
      new BridgeError("unknown", "lost"),
    );
    expect(failureOf(await s.run(acknowledge))).toBe(
      "CHATGPT_CONVERSATION_UNCONFIRMED",
    );
    expect(s.clientScript.snapshot).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a refused bridge call",
      new BridgeError("refused", "x"),
      "CHATGPT_CONVERSATION_REFUSED",
    ],
    [
      "an unknown bridge call",
      new BridgeError("unknown", "x"),
      "CHATGPT_CONVERSATION_UNCONFIRMED",
    ],
    ["a plain failure", new Error("x"), "CHATGPT_CONVERSATION_UNCONFIRMED"],
  ])("classifies %s", async (_name, error, code) => {
    const s = scene();
    activeConversation(s);
    s.clientScript.progress.mockRejectedValue(error);
    expect(failureOf(await s.run(observe))).toBe(code);
  });

  it("treats a malformed projection as an unconfirmed outcome", async () => {
    const s = scene();
    activeConversation(s);
    s.clientScript.progress.mockResolvedValue({
      ...projection(),
      frames: [{ sequence: "1", kind: "response.output_text.delta", data: {} }],
    } as never);
    expect(failureOf(await s.run(observe))).toBe(
      "CHATGPT_CONVERSATION_UNCONFIRMED",
    );
  });
});

describe("chatgpt.recover-task-result", () => {
  it.each([[null], [{ operationId, kind: "readonly", result: null }]])(
    "refuses without a retained result",
    async (retained) => {
      const s = scene();
      s.state.recoverable = retained;
      expect(
        failureOf(await s.run({ kind: "chatgpt.recover-task-result" })),
      ).toBe("CHATGPT_TASK_RESULT_NOT_FOUND");
    },
  );

  it("redelivers the retained result and requires an acknowledgement", async () => {
    const s = scene();
    s.state.recoverable = {
      operationId,
      kind: "attachment",
      result: {
        state: "completed",
        code: null,
        deltaCount: 1,
        observedCharacters: 2,
        attachmentCount: 1,
        totalBytes: 3,
        stagingCleanup: "removed",
      },
    };
    expect(await s.run({ kind: "chatgpt.recover-task-result" })).toMatchObject({
      ok: true,
      evidence: {
        kind: "chatgpt.task-recovery",
        operationId,
        taskKind: "attachment",
        state: "completed",
        conversationContinuity: "not_observed",
        redelivered: true,
        deliveryAckRequired: true,
      },
    });
    // Reading never consumes the retained result.
    expect(s.state.recoverable).not.toBeNull();
  });
});

describe("chatgpt.reset-conversation", () => {
  const reset = { kind: "chatgpt.reset-conversation" };

  it("refuses an occupied chat lane before a pending preview", async () => {
    const s = scene();
    s.admission.reserveAdmitted("chatgpt-task");
    s.state.pendingReadonly = {} as never;
    expect(failureOf(await s.run(reset))).toBe("CHATGPT_TASK_IN_PROGRESS");
  });

  it.each([
    ["readonly", (s: Scene) => (s.state.pendingReadonly = {} as never)],
    ["attachment", (s: Scene) => (s.state.pendingAttachment = {} as never)],
  ])("refuses a pending %s preview", async (_name, set) => {
    const s = scene();
    set(s);
    expect(failureOf(await s.run(reset))).toBe("CHATGPT_TASK_PREVIEW_PENDING");
  });

  it("refuses an unknown ChatGPT outcome", async () => {
    const s = scene();
    s.state.snapshot = ready({ chatgpt: { outcomeUnknown: true } });
    expect(failureOf(await s.run(reset))).toBe("CHATGPT_TASK_REQUIRES_REVIEW");
  });

  it.each([
    ["store", (s: Scene) => (s.state.store = null)],
    ["route", (s: Scene) => (s.state.route = null)],
  ])("refuses a missing %s", async (_name, set) => {
    const s = scene();
    set(s);
    expect(failureOf(await s.run(reset))).toBe(
      "CHATGPT_CONVERSATION_STATE_FAILED",
    );
    expect(s.events).not.toContain("setChatGptConversation:null");
  });

  it("proceeds past the review check when settings are unavailable", async () => {
    const s = scene();
    s.state.snapshot = unavailable;
    expect(failureOf(await s.run(reset))).toBeNull();
  });

  it("clears the store, then the retained record, then the route", async () => {
    const s = scene();
    const clear = s.state.store as { clear: ReturnType<typeof vi.fn> };
    clear.clear.mockImplementation(async () => {
      s.events.push("store.clear");
    });
    expect(await s.run(reset)).toMatchObject({
      ok: true,
      evidence: { kind: "chatgpt.conversation-reset", state: "new" },
    });
    expect(s.events).toEqual([
      "store.clear",
      "setChatGptConversation:null",
      "route.resetConversation",
    ]);
  });

  it("leaves the record and route untouched when the store cannot clear", async () => {
    const s = scene();
    (
      s.state.store as { clear: ReturnType<typeof vi.fn> }
    ).clear.mockRejectedValue(new Error("disk"));
    expect(failureOf(await s.run(reset))).toBe(
      "CHATGPT_CONVERSATION_STATE_FAILED",
    );
    expect(s.events).toEqual([]);
  });

  it("reports a failing route reset as a state failure after the record was cleared", async () => {
    const s = scene();
    s.route.resetConversation.mockImplementation(() => {
      throw new Error("route");
    });
    expect(failureOf(await s.run(reset))).toBe(
      "CHATGPT_CONVERSATION_STATE_FAILED",
    );
    expect(s.events).toContain("setChatGptConversation:null");
  });
});

describe("chatgpt.ack-task-result", () => {
  const ack = { kind: "chatgpt.ack-task-result", operationId };
  const retained = (extra: object = {}) => ({
    operationId,
    result: { state: "completed", code: null },
    ...extra,
  });

  it("refuses without a journal", async () => {
    const s = scene();
    s.state.journal = null;
    s.state.recoverable = retained();
    expect(failureOf(await s.run(ack))).toBe("CHATGPT_TASK_JOURNAL_FAILED");
    expect(s.configuration.recordChatGptObservation).not.toHaveBeenCalled();
  });

  it("records the retained observation once before acknowledging delivery", async () => {
    const s = scene();
    s.state.recoverable = retained();
    expect(await s.run(ack)).toMatchObject({ ok: true });
    expect(s.events).toEqual([
      `recordChatGptObservation:${JSON.stringify({ journal: { state: "completed", code: null } })}`,
      "setRecoverableChatGptObservationPersisted:true",
      `journal.acknowledgeDelivery:${operationId}`,
      "setRecoverableChatGptTask:null",
      "setRecoverableChatGptObservationPersisted:false",
    ]);
    expect(s.state.recoverable).toBeNull();
    expect(s.state.observationPersisted).toBe(false);
  });

  it("returns a failed observation record without acknowledging", async () => {
    const s = scene();
    s.state.recoverable = retained();
    s.configuration.recordChatGptObservation.mockResolvedValue({
      ok: false,
      error: "SETTINGS_WRITE_FAILED",
      snapshot: s.state.snapshot,
    } as never);
    expect(failureOf(await s.run(ack))).toBe("SETTINGS_WRITE_FAILED");
    expect(s.state.journal!.acknowledgeDelivery).not.toHaveBeenCalled();
    expect(s.state.observationPersisted).toBe(false);
    expect(s.state.recoverable).not.toBeNull();
  });

  it.each([
    ["the observation is already persisted", { observationPersisted: true }],
    [
      "the retained result is absent",
      { recoverable: retained({ result: null }) },
    ],
    [
      "another operation is retained",
      { recoverable: retained({ operationId: uuid(77) }) },
    ],
  ])("does not record again when %s", async (_name, patch) => {
    const s = scene();
    s.state.recoverable = retained();
    Object.assign(s.state, patch);
    await s.run(ack);
    expect(s.configuration.recordChatGptObservation).not.toHaveBeenCalled();
    expect(s.state.journal!.acknowledgeDelivery).toHaveBeenCalledWith(
      operationId,
    );
  });

  it("keeps the retained task when the acknowledgement fails", async () => {
    const s = scene();
    s.state.recoverable = retained();
    s.state.journal!.acknowledgeDelivery.mockRejectedValue(new Error("disk"));
    expect(failureOf(await s.run(ack))).toBe("CHATGPT_TASK_JOURNAL_FAILED");
    expect(s.state.recoverable).not.toBeNull();
    expect(s.state.observationPersisted).toBe(true);
  });

  it("keeps a different retained task after acknowledging another operation", async () => {
    const s = scene();
    s.state.recoverable = retained({ operationId: uuid(77) });
    s.state.observationPersisted = true;
    expect(await s.run(ack)).toMatchObject({ ok: true });
    expect(s.state.recoverable).not.toBeNull();
    expect(s.state.observationPersisted).toBe(true);
  });
});

describe("chatgpt.open-sign-in", () => {
  const open = { kind: "chatgpt.open-sign-in" };

  it("refuses without a route before beginning an attempt", async () => {
    const s = scene();
    s.state.route = null;
    expect(failureOf(await s.run(open))).toBe("CHATGPT_ROUTE_UNAVAILABLE");
    expect(s.events).toEqual([]);
  });

  it("begins one attempt, then opens the sign-in window and marks Setup visited", async () => {
    const s = scene();
    s.state.signInGeneration = 4;
    expect(await s.run(open)).toMatchObject({ ok: true });
    expect(s.events).toEqual([
      "beginAttempt",
      "setChatGptSignInOutcome:null",
      "setChatGptSignInGeneration:5",
      "setChatGptSignInOpenGeneration:5",
      "applyLayout",
      "route.openForSignIn:Fixture sign-in",
      "markSetupVisited:chatgpt",
    ]);
    expect(s.state.signInOutcome).toBeNull();
  });

  it("leaves the layout alone without an embedded browser", async () => {
    const s = scene();
    s.state.embedded = false;
    await s.run(open);
    expect(s.events).not.toContain("applyLayout");
  });

  it.each([
    ["reports unreachable", async () => ({ status: "unreachable" })],
    [
      "throws",
      async (): Promise<{ status: string }> => {
        throw new Error("lost");
      },
    ],
  ])(
    "records an unreachable observation when the route %s",
    async (_name, opened) => {
      const s = scene();
      s.route.openForSignIn.mockImplementation(opened);
      expect(await s.run(open)).toMatchObject({
        ok: true,
        evidence: {
          kind: "chatgpt.readiness",
          state: "unreachable",
          code: "CHATGPT_PAGE_UNREACHABLE",
        },
      });
      expect(
        s.configuration.recordChatGptObservation,
      ).toHaveBeenCalledExactlyOnceWith({
        state: "unreachable",
      });
      expect(s.configuration.markSetupVisited).not.toHaveBeenCalled();
    },
  );

  it("adds no readiness evidence when the failed open has another status", async () => {
    const s = scene();
    s.route.openForSignIn.mockResolvedValue({ status: "blocked" });
    const result = await s.run(open);
    expect(result).toMatchObject({ ok: true });
    expect(result.ok ? result.evidence : undefined).toBeUndefined();
    expect(s.configuration.recordChatGptObservation).toHaveBeenCalledWith({
      state: "unreachable",
    });
  });
});

describe("chatgpt.observe-sign-in", () => {
  const observationId = uuid(6);
  const observe = {
    kind: "chatgpt.observe-sign-in",
    observationId,
    buildId: fixtureBuildId,
  };
  const unknown = {
    ok: true,
    evidence: {
      kind: "chatgpt.sign-in-status",
      observationId,
      buildId: fixtureBuildId,
      state: "unknown",
      binding: null,
    },
  };

  it("discloses the current status without opening, fetching an account or writing Settings", async () => {
    const s = scene();
    expect(await s.run(observe)).toMatchObject({
      ok: true,
      evidence: {
        kind: "chatgpt.sign-in-status",
        observationId,
        buildId: fixtureBuildId,
        state: "authenticated",
        binding: { documentGeneration: 7, sequence: 2 },
      },
    });
    expect(s.route.observeSignInStatus).toHaveBeenCalledTimes(1);
    expect(s.route.open).not.toHaveBeenCalled();
    expect(s.route.observeAccount).not.toHaveBeenCalled();
    expect(s.configuration.recordChatGptObservation).not.toHaveBeenCalled();
  });

  it("observes no substitute without a route", async () => {
    const s = scene();
    const original = s.route;
    s.state.route = null;
    expect(await s.run(observe)).toMatchObject(unknown);
    expect(original.observeSignInStatus).not.toHaveBeenCalled();
  });

  it("observes nothing for another build", async () => {
    const s = scene();
    expect(await s.run({ ...observe, buildId: "4".repeat(64) })).toMatchObject({
      ok: true,
      evidence: { state: "unknown", binding: null },
    });
    expect(s.route.observeSignInStatus).not.toHaveBeenCalled();
  });

  it.each([
    ["the application quits", (s: Scene) => s.admission.beginQuit()],
    ["an update is admitted", (s: Scene) => void s.admission.enterUpdate()],
    ["the route is replaced", (s: Scene) => (s.state.route = { ...s.route })],
    [
      "the document changed",
      (s: Scene) => s.route.isCurrentSignInStatus.mockReturnValue(false),
    ],
    [
      "the currency check throws",
      (s: Scene) =>
        s.route.isCurrentSignInStatus.mockImplementation(() => {
          throw new Error("lost");
        }),
    ],
  ])(
    "does not disclose a late positive answer after %s",
    async (_name, lose) => {
      const s = scene();
      let settle!: (value: unknown) => void;
      s.route.observeSignInStatus.mockReturnValue(
        new Promise((resolve) => {
          settle = resolve;
        }) as never,
      );
      const running = s.run(observe);
      lose(s);
      settle({
        state: "authenticated",
        binding: { documentGeneration: 7, sequence: 2 },
      });
      expect(await running).toMatchObject(unknown);
    },
  );

  it("classifies a failed route read without exposing its detail", async () => {
    const s = scene();
    s.route.observeSignInStatus.mockRejectedValue(new Error("private-detail"));
    const result = await s.run(observe);
    expect(result).toMatchObject(unknown);
    expect(JSON.stringify(result)).not.toContain("private-detail");
  });
});

describe("chatgpt.present-browser", () => {
  const present = { kind: "chatgpt.present-browser" };

  it.each([
    [
      "the embedded browser is disabled",
      (s: Scene) => (s.state.embedded = false),
    ],
    ["the route is missing", (s: Scene) => (s.state.route = null)],
  ])("refuses when %s without touching the layout", async (_name, set) => {
    const s = scene();
    set(s);
    expect(failureOf(await s.run(present))).toBe("CHATGPT_ROUTE_UNAVAILABLE");
    expect(s.events).toEqual([]);
  });

  it("applies the layout, then refuses an occupied chat lane", async () => {
    const s = scene();
    s.admission.reserveAdmitted("chatgpt-task");
    expect(failureOf(await s.run(present))).toBe("CHATGPT_TASK_IN_PROGRESS");
    expect(s.events).toEqual(["applyLayout"]);
  });

  it.each([
    ["an open sign-in", (s: Scene) => (s.state.signInOpenGeneration = 4)],
    [
      "a selected task",
      (s: Scene) => (s.state.selectedTaskId = "retained-task"),
    ],
  ])("reveals %s without opening another route", async (_name, set) => {
    const s = scene();
    set(s);
    expect(await s.run(present)).toMatchObject({ ok: true });
    expect(s.route.open).not.toHaveBeenCalled();
    expect(s.route.retryFailedOpen).not.toHaveBeenCalled();
    expect(s.state.browserHome).toBe(false);
  });

  it("opens once through the existing route and never retries", async () => {
    const s = scene();
    expect(await s.run(present)).toMatchObject({ ok: true });
    expect(s.events).toEqual(["applyLayout", "route.open", "applyLayout"]);
    expect(s.route.retryFailedOpen).not.toHaveBeenCalled();
    expect(s.state.browserHome).toBe(false);
  });

  it.each([
    ["unreachable", async () => ({ status: "unreachable" })],
    [
      "a thrown error",
      async (): Promise<{ status: string }> => {
        throw new Error("lost");
      },
    ],
  ])("keeps a failed open truthful for %s", async (_name, opened) => {
    const s = scene();
    s.route.open.mockImplementation(opened);
    expect(failureOf(await s.run(present))).toBe("CHATGPT_PAGE_UNREACHABLE");
    expect(s.events).toEqual(["applyLayout", "applyLayout"]);
    expect(s.route.open).toHaveBeenCalledTimes(1);
    expect(s.route.retryFailedOpen).not.toHaveBeenCalled();
  });
});

describe("chatgpt.open-browser", () => {
  const openBrowser = { kind: "chatgpt.open-browser" };

  it.each([
    [
      "the embedded browser is disabled",
      (s: Scene) => (s.state.embedded = false),
    ],
    ["the route is missing", (s: Scene) => (s.state.route = null)],
  ])("refuses when %s", async (_name, set) => {
    const s = scene();
    set(s);
    expect(failureOf(await s.run(openBrowser))).toBe(
      "CHATGPT_ROUTE_UNAVAILABLE",
    );
    expect(s.events).toEqual([]);
  });

  it("refuses an open sign-in before checking the lanes", async () => {
    const s = scene();
    s.state.signInOpenGeneration = 2;
    s.admission.reserveAdmitted("chatgpt-task");
    expect(failureOf(await s.run(openBrowser))).toBe(
      "CHATGPT_SIGN_IN_IN_PROGRESS",
    );
    expect(s.events).toEqual([]);
  });

  it.each(["chatgpt-task", "connector-task"] as const)(
    "refuses a %s admission",
    async (kind) => {
      const s = scene();
      s.admission.reserveAdmitted(kind);
      expect(failureOf(await s.run(openBrowser))).toBe(
        "CHATGPT_TASK_IN_PROGRESS",
      );
      expect(s.events).toEqual([]);
    },
  );

  it("selects the home surface, applies the layout and retries only the failed open once", async () => {
    const s = scene();
    expect(await s.run(openBrowser)).toMatchObject({ ok: true });
    expect(s.events).toEqual([
      "setBrowserHomeSurfaceOpen:true",
      "applyLayout",
      "route.retryFailedOpen",
    ]);
    expect(s.route.open).not.toHaveBeenCalled();
  });

  it.each([
    ["unreachable", async () => ({ status: "unreachable" })],
    [
      "a thrown error",
      async (): Promise<{ status: string }> => {
        throw new Error("lost");
      },
    ],
  ])(
    "keeps the home surface and reapplies the layout when the open is %s",
    async (_name, opened) => {
      const s = scene();
      s.route.retryFailedOpen.mockImplementation(opened);
      expect(failureOf(await s.run(openBrowser))).toBe(
        "CHATGPT_PAGE_UNREACHABLE",
      );
      expect(s.state.browserHome).toBe(true);
      expect(s.events).toEqual([
        "setBrowserHomeSurfaceOpen:true",
        "applyLayout",
        "applyLayout",
      ]);
      expect(s.route.retryFailedOpen).toHaveBeenCalledTimes(1);
    },
  );
});

describe("chatgpt.toggle-sidebar", () => {
  const toggle = { kind: "chatgpt.toggle-sidebar" };

  it("toggles the home route while the home surface is open without a selected task", async () => {
    const s = scene();
    s.state.browserHome = true;
    const task = { toggleSidebar: vi.fn(async () => true) };
    s.state.liveRoutes.set("", task);
    expect(await s.run(toggle)).toMatchObject({ ok: true });
    expect(s.route.toggleSidebar).toHaveBeenCalledTimes(1);
    expect(task.toggleSidebar).not.toHaveBeenCalled();
  });

  it.each([
    [
      "the home surface is closed",
      { browserHome: false, selectedTaskId: "task-1" },
    ],
    ["a task is selected", { browserHome: true, selectedTaskId: "task-1" }],
  ])("toggles the selected task route when %s", async (_name, patch) => {
    const s = scene();
    Object.assign(s.state, patch);
    const task = { toggleSidebar: vi.fn(async () => true) };
    s.state.liveRoutes.set("task-1", task);
    expect(await s.run(toggle)).toMatchObject({ ok: true });
    expect(task.toggleSidebar).toHaveBeenCalledTimes(1);
    expect(s.route.toggleSidebar).not.toHaveBeenCalled();
  });

  it.each([
    [
      "the embedded browser is disabled",
      (s: Scene) => (s.state.embedded = false),
    ],
    [
      "the visible route is missing",
      (s: Scene) => (s.state.selectedTaskId = "absent"),
    ],
  ])("refuses when %s", async (_name, set) => {
    const s = scene();
    s.state.browserHome = false;
    set(s);
    expect(failureOf(await s.run(toggle))).toBe("CHATGPT_ROUTE_UNAVAILABLE");
  });

  it("reports an unreachable page when the toggle fails", async () => {
    const s = scene();
    s.state.browserHome = true;
    s.route.toggleSidebar.mockResolvedValue(false);
    expect(failureOf(await s.run(toggle))).toBe("CHATGPT_PAGE_UNREACHABLE");
  });
});

describe("chatgpt.verify", () => {
  const verify = { kind: "chatgpt.verify" };
  const authenticated = {
    state: "authenticated",
    profile: "chatgpt.app-partition/1",
    runtimeGeneration: `fixture-partition:${fixtureBuildId}`,
    buildId: fixtureBuildId,
    protocol: "chatgpt-page-readiness/1",
  };

  it("clears the Setup sign-in check even when the route is missing", async () => {
    const s = scene();
    s.state.route = null;
    s.state.setupSignInCheck = { stale: true };
    expect(failureOf(await s.run(verify))).toBe("CHATGPT_ROUTE_UNAVAILABLE");
    expect(s.state.setupSignInCheck).toBeNull();
  });

  it("records the bound authenticated observation, then retains the current sign-in binding", async () => {
    const s = scene();
    const result = await s.run(verify);
    expect(result).toMatchObject({
      ok: true,
      evidence: { kind: "chatgpt.readiness", state: "authenticated" },
    });
    expect(
      s.configuration.recordChatGptObservation,
    ).toHaveBeenCalledExactlyOnceWith(authenticated);
    expect(s.route.observeSignInStatus).toHaveBeenCalledTimes(1);
    expect(s.state.setupSignInCheck).toEqual({
      buildId: fixtureBuildId,
      binding: { documentGeneration: 7, sequence: 2 },
    });
  });

  it.each([
    [
      "the route was replaced",
      (s: Scene) =>
        s.route.observeSignInStatus.mockImplementation(async () => {
          s.state.route = {};
          return {
            state: "authenticated",
            binding: { documentGeneration: 7, sequence: 2 },
          };
        }),
    ],
    [
      "the status is not current",
      (s: Scene) => s.route.isCurrentSignInStatus.mockReturnValue(false),
    ],
    [
      "the status is signed out",
      (s: Scene) =>
        s.route.observeSignInStatus.mockResolvedValue({
          state: "signed_out",
          binding: null,
        }),
    ],
    [
      "there is no binding",
      (s: Scene) =>
        s.route.observeSignInStatus.mockResolvedValue({
          state: "authenticated",
          binding: null,
        }),
    ],
  ])("keeps no sign-in check when %s", async (_name, set) => {
    const s = scene();
    set(s);
    expect(await s.run(verify)).toMatchObject({ ok: true });
    expect(s.state.setupSignInCheck).toBeNull();
  });

  it.each(["signed_out", "unreachable", "unsupported"])(
    "records only the %s state and observes nothing else",
    async (state) => {
      const s = scene();
      s.route.observe.mockResolvedValue({ state, code: null });
      expect(await s.run(verify)).toMatchObject({
        ok: true,
        evidence: { kind: "chatgpt.readiness", state },
      });
      expect(
        s.configuration.recordChatGptObservation,
      ).toHaveBeenCalledExactlyOnceWith({ state });
      expect(s.route.observeSignInStatus).not.toHaveBeenCalled();
    },
  );

  // Characterization: a failed record cannot carry the readiness evidence, so
  // the result schema rejects the reply. The handler still observes nothing
  // further and keeps no sign-in check.
  it("rejects a failed record without a second observation", async () => {
    const s = scene();
    s.configuration.recordChatGptObservation.mockResolvedValue({
      ok: false,
      error: "SETTINGS_WRITE_FAILED",
      snapshot: s.state.snapshot,
    } as never);
    await expect(s.run(verify)).rejects.toMatchObject({ name: "ZodError" });
    expect(s.route.observeSignInStatus).not.toHaveBeenCalled();
    expect(s.state.setupSignInCheck).toBeNull();
  });
});

describe("chatgpt return commands", () => {
  it.each(["chatgpt.sign-in-return", "chatgpt.verification-return"])(
    "%s changes nothing without an embedded browser",
    async (kind) => {
      const s = scene();
      s.state.embedded = false;
      s.state.signInOpenGeneration = 4;
      expect(await s.run({ kind })).toMatchObject({ ok: true });
      expect(s.state.signInOpenGeneration).toBe(4);
      expect(s.route.returnFromSignIn).not.toHaveBeenCalled();
    },
  );

  it.each(["chatgpt.sign-in-return", "chatgpt.verification-return"])(
    "%s ends the observation without retiring the generation twice",
    async (kind) => {
      const s = scene();
      s.state.signInOpenGeneration = 4;
      expect(await s.run({ kind })).toMatchObject({ ok: true });
      expect(s.route.returnFromSignIn).toHaveBeenCalledTimes(1);
      expect(s.state.signInOpenGeneration).toBe(4);
    },
  );

  it.each([
    [
      "the route ended sign-in mode already",
      (s: Scene) => s.route.returnFromSignIn.mockReturnValue(false),
    ],
    ["there is no route", (s: Scene) => (s.state.route = null)],
  ])("still retires the open generation when %s", async (_name, set) => {
    const s = scene();
    s.state.signInOpenGeneration = 4;
    set(s);
    expect(await s.run({ kind: "chatgpt.verification-return" })).toMatchObject({
      ok: true,
    });
    expect(s.state.signInOpenGeneration).toBeNull();
    expect(s.events).toContain("setChatGptSignInOpenGeneration:null");
  });
});
