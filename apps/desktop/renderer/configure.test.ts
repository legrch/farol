import { describe, expect, it } from "vitest";
import type { ReadConversationView } from "../../../src/pkg/product-settings/chat-conversation";
import type { ConnectorSetupReceipt } from "../../../src/pkg/product-settings/connector-setup-receipt";
import type {
  ProductConfigurationCommand,
  ProductConfigurationEvidence,
} from "../../../src/pkg/product-settings/contract";
import { classifyConfigurationResponse } from "../../../src/ui/configuration-outcome";
import type {
  Destination,
  Intent,
  WindowSnapshot,
} from "../../../src/ui/renderer/contract";
import { settings } from "../../../tests/renderer/fixture";
import {
  admissionRefusal,
  admitConfiguration,
  bindingUnavailable,
  completesSetupKey,
  configurationIntent,
  connectorSetupRefusal,
  directChatPreviewReceipt,
  isConnectorVerifyKey,
  isReadConversationCommand,
  onSetupSignIn,
  opensNativeSurface,
  outcomeUnknown,
  payloadConflict,
  readAccountReceipt,
  readConversationAdoption,
  readPreviewReceipt,
  signInCheckToRetain,
  signInReturnTarget,
  staleAdmissionRefusal,
  staleAutomaticSignInCheck,
  startsSignInAttempt,
  unconfirmedReceipt,
  workspaceEditConsumedRefusal,
  workspaceEditPreviewOwner,
  workspaceEditPreviewUnconfirmed,
  workspaceReadbackFor,
} from "./configure";
import { initial } from "./snapshot";

type Evidence<K extends string> = Extract<
  ProductConfigurationEvidence,
  { kind: K }
>;

const buildId: string = "3".repeat(64);
const otherBuild: string = "4".repeat(64);
const op: string = "44444444-4444-4444-8444-444444444444";
const otherOp: string = "88888888-8888-4888-8888-888888888888";
const confirmation: string = "77777777-7777-4777-8777-777777777777";
const session: string = "55555555-5555-4555-8555-555555555555";
const workspaceId: string = "22222222-2222-4222-8222-222222222222";

function ready(revision = 1): WindowSnapshot["configuration"] {
  return { status: "ready", settings: settings(revision) };
}
function snapshot(overrides: Partial<WindowSnapshot> = {}): WindowSnapshot {
  return {
    ...initial,
    status: "current",
    buildId,
    configuration: ready(),
    ...overrides,
  };
}
const setupSignIn: Destination = {
  area: "setup",
  page: "general",
  taskId: "",
  setupStep: "signin",
};
const setupOther: Destination = {
  area: "setup",
  page: "general",
  taskId: "",
  setupStep: "connection",
};
const chatgpt: Destination = { area: "chatgpt", page: "general", taskId: "" };

// A reply is built the way the bridge sends it and parsed by the real
// classifier, so every fixture here is a value the controller can receive.
function answered(
  body: Readonly<Record<string, unknown>>,
  ok = true,
): Extract<ReturnType<typeof classifyConfigurationResponse>, { kind: string }> {
  return classifyConfigurationResponse({
    settled: "fulfilled",
    value: {
      ok,
      ...(ok ? {} : { error: "SETTINGS_INPUT_INVALID" }),
      snapshot: ready(2),
      ...body,
    },
  });
}
function answeredResult(body: Readonly<Record<string, unknown>>, ok = true) {
  const outcome = answered(body, ok);
  if (outcome.kind === "unconfirmed") throw new Error("fixture unconfirmed");
  return outcome;
}

describe("admitConfiguration", () => {
  it.each([
    ["an unknown kind", { kind: "nope" }],
    ["an extra field", { kind: "chatgpt.verify", extra: 1 }],
    ["a missing field", { kind: "chatgpt.inspect-chat-account" }],
    [
      "a wrong field type",
      { kind: "chatgpt.inspect-chat-account", operationId: 1 },
    ],
  ])("refuses %s as SETTINGS_INPUT_INVALID", (_label, value) => {
    expect(
      admitConfiguration(value as unknown as ProductConfigurationCommand, "i"),
    ).toEqual({
      route: "refuse",
      intent: { id: "i", state: "refused", code: "SETTINGS_INPUT_INVALID" },
    });
  });

  it("refuses an observe-sign-in that the window owns", () => {
    expect(
      admitConfiguration(
        { kind: "chatgpt.observe-sign-in", observationId: op, buildId },
        "i",
      ),
    ).toEqual({
      route: "refuse",
      intent: {
        id: "i",
        state: "refused",
        code: "SIGN_IN_OBSERVATION_WINDOW_OWNED",
      },
    });
  });

  it("routes present-browser to the presentation path", () => {
    expect(
      admitConfiguration({ kind: "chatgpt.present-browser" }, "i"),
    ).toEqual({ route: "present-browser" });
  });

  it.each([
    { kind: "chatgpt.open-sign-in" },
    { kind: "chatgpt.open-browser" },
    { kind: "chatgpt.verify" },
    { kind: "connector.verify-app" },
    { kind: "connector.check-health" },
    { kind: "chatgpt.cancel-readonly-task", operationId: op },
    { kind: "computer.verify-workspace", workspaceId },
  ] as const)("dispatches $kind with a parsed copy", (command) => {
    const admission = admitConfiguration(command, "i");
    expect(admission.route).toBe("dispatch");
    if (admission.route !== "dispatch") return;
    expect(admission.command).toEqual(command);
    expect(admission.command).not.toBe(command);
  });

  it("binds the parsed values, not the caller's later mutation", () => {
    const value = {
      kind: "chatgpt.cancel-readonly-task" as const,
      operationId: op,
    };
    const admission = admitConfiguration(value, "i");
    value.operationId = otherOp;
    expect(admission.route === "dispatch" && admission.command).toEqual({
      kind: "chatgpt.cancel-readonly-task",
      operationId: op,
    });
  });
});

describe("sign-in hooks", () => {
  it.each([
    [setupSignIn, true],
    [setupOther, false],
    [chatgpt, false],
  ])("onSetupSignIn(%j) is %s", (destination, expected) =>
    expect(onSetupSignIn(destination)).toBe(expected),
  );

  it.each([
    ["chatgpt.open-sign-in", setupSignIn, true],
    ["chatgpt.open-browser", setupSignIn, true],
    ["chatgpt.open-sign-in", setupOther, false],
    ["chatgpt.open-browser", chatgpt, false],
    ["chatgpt.verify", setupSignIn, false],
    ["connector.verify-app", setupSignIn, false],
  ] as const)(
    "%s from %j starts an attempt: %s",
    (kind, destination, expected) =>
      expect(
        startsSignInAttempt(
          { kind } as ProductConfigurationCommand,
          destination,
        ),
      ).toBe(expected),
  );

  const binding = { documentGeneration: 7, sequence: 1 };
  it.each([
    ["no prior check", {}, null],
    [
      "a prior check of this build whose verification applied",
      {
        setupSignInCheck: { buildId, binding },
        intents: {
          "settings:chatgpt.verify:": {
            id: "x",
            state: "applied",
            code: null,
          } as Intent,
        },
      },
      `${buildId}:7`,
    ],
    [
      "a prior check of another build",
      {
        setupSignInCheck: { buildId: otherBuild, binding },
        intents: {
          "settings:chatgpt.verify:": {
            id: "x",
            state: "applied",
            code: null,
          } as Intent,
        },
      },
      null,
    ],
    [
      "a prior check whose verification is not applied",
      {
        setupSignInCheck: { buildId, binding },
        intents: {
          "settings:chatgpt.verify:": {
            id: "x",
            state: "unknown",
            code: null,
          } as Intent,
        },
      },
      null,
    ],
    [
      "a prior check with no verification at all",
      { setupSignInCheck: { buildId, binding } },
      null,
    ],
  ])("staleAutomaticSignInCheck with %s", (_label, overrides, expected) =>
    expect(staleAutomaticSignInCheck(snapshot(overrides))).toBe(expected),
  );

  it.each([
    ["chatgpt.open-sign-in", chatgpt, true],
    ["chatgpt.open-sign-in", setupSignIn, true],
    ["chatgpt.open-browser", setupSignIn, true],
    ["chatgpt.open-browser", chatgpt, false],
    ["connector.verify-app", setupSignIn, true],
    ["connector.verify-separate-app", setupOther, false],
  ] as const)(
    "%s from %j records a return: %s",
    (kind, destination, expected) => {
      const target = signInReturnTarget(
        { kind } as ProductConfigurationCommand,
        destination,
      );
      expect(target !== null).toBe(expected);
      if (target)
        expect(target).toMatchObject({ area: "setup", setupStep: "signin" });
    },
  );
});

describe("opensNativeSurface", () => {
  it.each([
    ["chatgpt.open-sign-in", true],
    ["chatgpt.open-browser", true],
    ["connector.verify-app", true],
    ["connector.verify-separate-app", true],
    ["chatgpt.verify", false],
    ["chatgpt.present-browser", false],
    ["connector.test-connection", false],
  ])("%s: %s", (kind, expected) =>
    expect(opensNativeSurface({ kind } as ProductConfigurationCommand)).toBe(
      expected,
    ),
  );
});

describe("pre-send refusals", () => {
  const save: ProductConfigurationCommand = {
    kind: "connector.save-and-connect",
    operationId: op,
    buildId,
    tunnelId: "t",
    runtimeKey: "k",
  } as unknown as ProductConfigurationCommand;

  it("refuses a connector setup bound to another build", () => {
    expect(connectorSetupRefusal(save, otherBuild, "i")).toEqual({
      id: "i",
      state: "refused",
      code: "CONNECTOR_SETUP_BINDING_CHANGED",
    });
  });
  it.each([
    ["the bound build", buildId],
    ["no build at all is a different build", null],
  ])("connector setup against %s", (_label, build) =>
    expect(connectorSetupRefusal(save, build, "i") === null).toBe(
      build === buildId,
    ),
  );
  it("never refuses another kind on build grounds", () => {
    expect(
      connectorSetupRefusal({ kind: "chatgpt.verify" }, otherBuild, "i"),
    ).toBeNull();
  });
  it("names the consumed workspace edit", () => {
    expect(workspaceEditConsumedRefusal("i")).toEqual({
      id: "i",
      state: "refused",
      code: "WORKSPACE_EDIT_ALREADY_CONSUMED",
    });
  });
  it("describes an unconfirmed outcome as unknown, never refused", () => {
    expect(outcomeUnknown("i")).toEqual({
      id: "i",
      state: "unknown",
      code: "CONFIGURATION_OUTCOME_UNKNOWN",
    });
    expect(workspaceEditPreviewUnconfirmed("i")).toEqual({
      id: "i",
      state: "unknown",
      code: "WORKSPACE_EDIT_PREVIEW_UNCONFIRMED",
    });
  });
});

describe("workspaceReadbackFor", () => {
  it.each(["computer.verify-workspace", "computer.check-folder"] as const)(
    "binds %s to a ready snapshot",
    (kind) => {
      const command = { kind, workspaceId } as ProductConfigurationCommand;
      const binding = workspaceReadbackFor(command, snapshot());
      expect(binding).toMatchObject({ command, buildId, generation: 1 });
    },
  );
  it.each([
    ["no configuration", { configuration: null }],
    [
      "a configuration that is not ready",
      { configuration: { status: "unavailable" } as never },
    ],
    ["no build", { buildId: null }],
  ])("binds nothing for %s", (_label, overrides) =>
    expect(
      workspaceReadbackFor(
        { kind: "computer.verify-workspace", workspaceId },
        snapshot(overrides),
      ),
    ).toBeNull(),
  );
  it("binds nothing for a kind that needs no readback", () => {
    expect(
      workspaceReadbackFor({ kind: "chatgpt.verify" }, snapshot()),
    ).toBeNull();
  });
});

describe("unconfirmedReceipt", () => {
  const deep = {
    kind: "chatgpt.run-deep-test",
    operationId: op,
    taskId: "t",
  } as const;
  const connection = {
    kind: "connector.test-connection",
    operationId: op,
    taskId: "t",
  } as const;
  const deepEvidence = (operationId: string) => ({
    kind: "chatgpt.deep-test-result",
    operationId,
    state: "completed",
    code: null,
  });
  const checkEvidence = (operationId: string) => ({
    kind: "connector.connection-check",
    operationId,
    receiptSha256: "a".repeat(64),
    retained: false,
  });

  it.each([
    ["the matching evidence", deepEvidence(op), false],
    ["another operation's evidence", deepEvidence(otherOp), true],
    ["no evidence", undefined, true],
    [
      "another kind of evidence",
      { kind: "chatgpt.deep-test-status", attempts: [] },
      true,
    ],
  ])("a deep test answered with %s", (_label, evidence, unconfirmed) => {
    const outcome = answeredResult({ evidence });
    expect(
      unconfirmedReceipt(deep, outcome.result, "i", snapshot(), snapshot()),
    ).toEqual(
      unconfirmed
        ? {
            id: "i",
            state: "unknown",
            code: "CHATGPT_CONVERSATION_UNCONFIRMED",
          }
        : null,
    );
  });

  it("does not hold a refused deep test to the success proof", () => {
    const outcome = answeredResult({}, false);
    expect(
      unconfirmedReceipt(deep, outcome.result, "i", snapshot(), snapshot()),
    ).toBeNull();
  });

  it.each([
    ["the matching evidence", checkEvidence(op), false],
    ["another operation's evidence", checkEvidence(otherOp), true],
    ["no evidence", undefined, true],
  ])("a connection check answered with %s", (_label, evidence, unconfirmed) => {
    const outcome = answeredResult({ evidence });
    expect(
      unconfirmedReceipt(
        connection,
        outcome.result,
        "i",
        snapshot(),
        snapshot(),
      ),
    ).toEqual(
      unconfirmed
        ? { id: "i", state: "unknown", code: "CONNECTION_CHECK_UNCONFIRMED" }
        : null,
    );
  });

  describe("connector setup", () => {
    const command = {
      kind: "connector.save-and-connect",
      operationId: op,
      buildId,
      tunnelId: "t",
      runtimeKey: "k",
    } as unknown as ProductConfigurationCommand;
    const receipt: ConnectorSetupReceipt = {
      kind: "connector.save-and-connect",
      operationId: op,
      buildId,
      state: "completed",
      stoppedAt: "complete",
      credentials: "saved",
      connection: "connected",
      code: null,
      externalVerification: "not-proven",
    };
    const run = (
      connectorSetup: ConnectorSetupReceipt | undefined,
      before = snapshot(),
      current = snapshot(),
    ) =>
      unconfirmedReceipt(
        command,
        answeredResult({ connectorSetup }).result,
        "i",
        before,
        current,
      );
    const unknown = {
      id: "i",
      state: "unknown",
      code: "CONFIGURATION_OUTCOME_UNKNOWN",
    };

    it("accepts the receipt of this operation, build and window", () =>
      expect(run(receipt)).toBeNull());
    it("requires a receipt", () => expect(run(undefined)).toEqual(unknown));
    it("rejects another operation's receipt", () =>
      expect(run({ ...receipt, operationId: otherOp })).toEqual(unknown));
    it("rejects a receipt for another build than the command", () =>
      expect(run({ ...receipt, buildId: otherBuild })).toEqual(unknown));
    it("rejects a command and receipt bound to another build than the window", () =>
      expect(run(receipt, snapshot({ buildId: otherBuild }))).toEqual(unknown));
    it("rejects a window that changed build while the reply was in flight", () =>
      expect(
        run(receipt, snapshot(), snapshot({ buildId: otherBuild })),
      ).toEqual(unknown));
    it("rejects a window that became incompatible", () =>
      expect(
        run(receipt, snapshot(), snapshot({ status: "incompatible" })),
      ).toEqual(unknown));
  });

  it("asks nothing of a kind with no receipt rule", () => {
    const outcome = answeredResult({});
    expect(
      unconfirmedReceipt(
        { kind: "chatgpt.verify" },
        outcome.result,
        "i",
        snapshot(),
        snapshot(),
      ),
    ).toBeNull();
  });
});

describe("read conversation adoption", () => {
  const view = {
    kind: "chatgpt.readonly-conversation",
    operationId: op,
    handleId: "h",
  } as unknown as ReadConversationView;
  const revision = 1;
  const inspection = {
    intention: "inspect",
    buildId,
    revision,
    value: {
      kind: "chatgpt.chat-account-preview",
      operationId: op,
      sessionId: session,
      confirmationId: confirmation,
      state: "observed",
    },
  } satisfies NonNullable<WindowSnapshot["directChatPreview"]>;
  const preview = {
    prepareIntention: "p",
    evidenceIntention: "p",
    buildId,
    revision,
    value: {
      kind: "chatgpt.readonly-task-preview",
      operationId: op,
      workspaceId,
      workspaceLabel: "w",
      relativePath: "a.txt",
      bytes: 1,
      contextCharacters: 1,
      contextLimit: 24_000,
      contextTruncated: false,
      excludedPaths: [],
      expiresAt: "2026-10-04T20:05:00.000Z",
      account: { confirmationId: confirmation, state: "approved" },
    },
  } satisfies NonNullable<WindowSnapshot["readPreview"]>;

  const kinds = [
    ["chatgpt.submit-readonly-task", true],
    ["chatgpt.start-conversation", true],
    ["chatgpt.observe-readonly-conversation", true],
    ["chatgpt.ack-readonly-conversation", true],
    ["chatgpt.follow-readonly-conversation", true],
    ["chatgpt.inspect-chat-account", false],
    ["chatgpt.cancel-readonly-task", false],
    ["chatgpt.verify", false],
  ] as const;
  it.each(kinds)("%s is a conversation command: %s", (kind, expected) =>
    expect(
      isReadConversationCommand({ kind } as ProductConfigurationCommand),
    ).toBe(expected),
  );

  const submit = {
    kind: "chatgpt.submit-readonly-task",
    operationId: op,
  } as const;
  const typed = {
    kind: "chatgpt.start-conversation",
    operationId: op,
    confirmationId: confirmation,
    prompt: "hi",
  } as const;
  const observe = {
    kind: "chatgpt.observe-readonly-conversation",
    operationId: op,
    handleId: "h",
    cursor: "1",
  } as const;
  const ack = {
    kind: "chatgpt.ack-readonly-conversation",
    operationId: op,
    handleId: "h",
    resultId: "r",
    cursor: "2",
  } as const;
  const follow = {
    kind: "chatgpt.follow-readonly-conversation",
    operationId: op,
    handleId: "h",
    prompt: "more",
  } as const;
  const asConversation = (value: unknown) =>
    value as Parameters<typeof readConversationAdoption>[1];

  it.each([
    ["a submitted start", submit, "start", { readPreview: preview }, {}],
    [
      "a typed start",
      typed,
      "typed-start",
      { directChatPreview: inspection },
      { sessionId: session },
    ],
    ["progress", observe, "progress", {}, { handleId: "h", cursor: "1" }],
    [
      "an acknowledgement",
      ack,
      "ack",
      {},
      { handleId: "h", resultId: "r", cursor: "2" },
    ],
    ["a follow", follow, "follow", {}, { handleId: "h" }],
  ] as const)("plans %s", (_label, command, action, held, extra) => {
    const before = snapshot(held);
    const plan = readConversationAdoption(
      command,
      asConversation(view),
      before,
      snapshot(held),
      revision,
    );
    expect(plan).toEqual({
      view,
      input: { action, operationId: op, buildId, revision, ...extra },
    });
  });

  const withStart = snapshot({ readPreview: preview });
  const withTyped = snapshot({ directChatPreview: inspection });
  it.each([
    [
      "the reply is not a conversation",
      submit,
      withStart,
      withStart,
      revision,
      { kind: "chatgpt.readonly-task-preview" },
    ],
    ["there is no value", submit, withStart, withStart, revision, undefined],
    [
      "the window is stale",
      submit,
      withStart,
      snapshot({ readPreview: preview, status: "stale" }),
      revision,
      view,
    ],
    [
      "the build changed",
      submit,
      withStart,
      snapshot({ readPreview: preview, buildId: otherBuild }),
      revision,
      view,
    ],
    ["there is no revision", submit, withStart, withStart, null, view],
    [
      "a start finds no preview",
      submit,
      snapshot(),
      snapshot(),
      revision,
      view,
    ],
    [
      "a start's preview was replaced",
      submit,
      withStart,
      snapshot({ readPreview: { ...preview } }),
      revision,
      view,
    ],
    [
      "a start's preview is not approved",
      submit,
      snapshot({
        readPreview: {
          ...preview,
          value: {
            ...preview.value,
            account: { confirmationId: confirmation, state: "observed" },
          },
        },
      }),
      withStart,
      revision,
      view,
    ],
    [
      "a start's preview belongs to another operation",
      { ...submit, operationId: otherOp },
      withStart,
      withStart,
      revision,
      view,
    ],
    [
      "a start's preview belongs to another revision",
      submit,
      withStart,
      withStart,
      revision + 1,
      view,
    ],
    [
      "a typed start finds no inspection",
      typed,
      snapshot(),
      snapshot(),
      revision,
      view,
    ],
    [
      "a typed start was confirmed differently",
      { ...typed, confirmationId: otherOp },
      withTyped,
      withTyped,
      revision,
      view,
    ],
    [
      "a typed start's inspection was replaced",
      typed,
      withTyped,
      snapshot({ directChatPreview: { ...inspection } }),
      revision,
      view,
    ],
  ] as const)(
    "plans nothing when %s",
    (_label, command, before, current, rev, value) =>
      expect(
        readConversationAdoption(
          command,
          asConversation(value),
          before,
          current,
          rev,
        ),
      ).toBeNull(),
  );

  it("plans nothing when the retained conversation moved during the call", () => {
    const retained = {
      operationId: op,
      buildId,
      revision,
      turns: [],
    } as WindowSnapshot["readConversation"];
    expect(
      readConversationAdoption(
        observe,
        asConversation(view),
        snapshot(),
        snapshot({ readConversation: retained }),
        revision,
      ),
    ).toBeNull();
  });
});

describe("receipts", () => {
  const revision = 1;
  const accountEvidence: Evidence<"chatgpt.chat-account-preview"> = {
    kind: "chatgpt.chat-account-preview",
    operationId: op,
    sessionId: session,
    confirmationId: confirmation,
    state: "observed",
  };
  const inspect = {
    kind: "chatgpt.inspect-chat-account",
    operationId: op,
  } as const;
  const base = () => snapshot();

  describe("directChatPreviewReceipt", () => {
    const run = (
      overrides: {
        value?: ProductConfigurationEvidence | undefined;
        before?: WindowSnapshot;
        current?: WindowSnapshot;
        revision?: number | null;
      } = {},
    ) =>
      directChatPreviewReceipt(
        inspect,
        "i",
        "value" in overrides ? overrides.value : accountEvidence,
        overrides.before ?? base(),
        overrides.current ?? base(),
        "revision" in overrides ? (overrides.revision ?? null) : revision,
      );
    it("retains the preview under this intention, build and revision", () =>
      expect(run()).toEqual({
        kind: "retain",
        receipt: {
          intention: "i",
          buildId,
          revision,
          value: accountEvidence,
        },
      }));
    it.each([
      ["no revision", { revision: null }],
      ["another revision than the settings it came from", { revision: 9 }],
      ["no evidence", { value: undefined }],
      [
        "another operation's evidence",
        { value: { ...accountEvidence, operationId: otherOp } },
      ],
      [
        "another kind of evidence",
        { value: { kind: "chatgpt.deep-test-status", attempts: [] } as never },
      ],
      [
        "a window that is not ready",
        { before: snapshot({ configuration: null }) },
      ],
      ["a build that changed", { current: snapshot({ buildId: otherBuild }) }],
      [
        "a window that is not current",
        { current: snapshot({ status: "stale" }) },
      ],
      [
        "a preview already held",
        {
          current: snapshot({
            directChatPreview: {
              intention: "x",
              buildId,
              revision,
              value: accountEvidence,
            },
          }),
        },
      ],
      [
        "a conversation already open",
        {
          before: snapshot({
            readConversation: { operationId: op, buildId, revision, turns: [] },
          }),
        },
      ],
    ])("is unconfirmed for %s", (_label, overrides) =>
      expect(run(overrides)).toEqual({
        kind: "unconfirmed",
        intent: { id: "i", state: "unknown", code: "CHAT_ACCOUNT_UNCONFIRMED" },
      }),
    );
  });

  const taskPreview: Evidence<"chatgpt.readonly-task-preview"> = {
    kind: "chatgpt.readonly-task-preview",
    operationId: op,
    workspaceId,
    workspaceLabel: "w",
    relativePath: "a.txt",
    bytes: 1,
    contextCharacters: 1,
    contextLimit: 24_000,
    contextTruncated: false,
    excludedPaths: [],
    expiresAt: "2026-10-04T20:05:00.000Z",
  };

  describe("readPreviewReceipt", () => {
    const prepare = {
      kind: "chatgpt.prepare-readonly-task",
      workspaceId,
    } as const;
    const run = (
      overrides: {
        value?: ProductConfigurationEvidence | undefined;
        retained?: WindowSnapshot["readPreview"];
        current?: WindowSnapshot;
        revision?: number | null;
      } = {},
    ) =>
      readPreviewReceipt(
        prepare,
        "i",
        "value" in overrides ? overrides.value : taskPreview,
        overrides.retained ?? null,
        base(),
        overrides.current ?? base(),
        "revision" in overrides ? (overrides.revision ?? null) : revision,
      );
    it("retains the first preview under this intention", () =>
      expect(run()).toEqual({
        kind: "retain",
        receipt: {
          prepareIntention: "i",
          evidenceIntention: "i",
          buildId,
          revision,
          value: taskPreview,
        },
      }));
    it.each([
      ["no revision", { revision: null }],
      ["another revision", { revision: 9 }],
      [
        "another workspace",
        { value: { ...taskPreview, workspaceId: otherOp } },
      ],
      [
        "an account already attached",
        {
          value: {
            ...taskPreview,
            account: {
              confirmationId: confirmation,
              state: "observed" as const,
            },
          },
        },
      ],
      [
        "another kind of evidence",
        { value: { kind: "chatgpt.deep-test-status", attempts: [] } as never },
      ],
      ["a build that changed", { current: snapshot({ buildId: otherBuild }) }],
      [
        "a preview already retained",
        {
          retained: {
            prepareIntention: "p",
            evidenceIntention: "p",
            buildId,
            revision,
            value: taskPreview,
          },
        },
      ],
    ])("is unconfirmed for %s", (_label, overrides) =>
      expect(run(overrides)).toEqual({
        kind: "unconfirmed",
        intent: { id: "i", state: "unknown", code: "READ_PREVIEW_UNCONFIRMED" },
      }),
    );
  });

  describe("readAccountReceipt", () => {
    const retained: NonNullable<WindowSnapshot["readPreview"]> = {
      prepareIntention: "p",
      evidenceIntention: "p",
      buildId,
      revision,
      value: taskPreview,
    };
    const observed = {
      ...taskPreview,
      account: { confirmationId: confirmation, state: "observed" as const },
    };
    const approved = {
      ...taskPreview,
      account: { confirmationId: confirmation, state: "approved" as const },
    };
    const inspectAccount = {
      kind: "chatgpt.inspect-readonly-account",
      operationId: op,
    } as const;
    const approve = {
      kind: "chatgpt.approve-readonly-account",
      operationId: op,
      confirmationId: confirmation,
    } as const;
    const run = (
      command: typeof inspectAccount | typeof approve,
      value: ProductConfigurationEvidence | undefined,
      held: WindowSnapshot["readPreview"] = retained,
      overrides: {
        before?: WindowSnapshot;
        current?: WindowSnapshot;
        revision?: number | null;
      } = {},
    ) =>
      readAccountReceipt(
        command,
        "i",
        value,
        held,
        overrides.before ?? snapshot({ readPreview: held }),
        overrides.current ?? snapshot({ readPreview: held }),
        "revision" in overrides ? (overrides.revision ?? null) : revision,
      );
    const unconfirmed = {
      kind: "unconfirmed",
      intent: { id: "i", state: "unknown", code: "READ_ACCOUNT_UNCONFIRMED" },
    };

    it("retains an observed account from an inspection", () =>
      expect(run(inspectAccount, observed)).toEqual({
        kind: "retain",
        receipt: { ...retained, evidenceIntention: "i", value: observed },
      }));
    it("retains an approved account from an approval of the observed one", () => {
      const held = { ...retained, value: observed };
      expect(run(approve, approved, held)).toEqual({
        kind: "retain",
        receipt: { ...held, evidenceIntention: "i", value: approved },
      });
    });
    it.each([
      ["no retained preview", () => run(inspectAccount, observed, null)],
      [
        "a preview replaced during the call",
        () =>
          run(inspectAccount, observed, retained, {
            before: snapshot({ readPreview: { ...retained } }),
          }),
      ],
      [
        "another operation",
        () => run({ ...inspectAccount, operationId: otherOp }, observed),
      ],
      [
        "a build that changed",
        () =>
          run(inspectAccount, observed, retained, {
            current: snapshot({ buildId: otherBuild, readPreview: retained }),
          }),
      ],
      [
        "another revision",
        () => run(inspectAccount, observed, retained, { revision: 9 }),
      ],
      [
        "no revision",
        () => run(inspectAccount, observed, retained, { revision: null }),
      ],
      ["no evidence", () => run(inspectAccount, undefined)],
      [
        "changed metadata",
        () => run(inspectAccount, { ...observed, bytes: 2 }),
      ],
      ["no account on the reply", () => run(inspectAccount, taskPreview)],
      [
        "an inspection that reports approval",
        () => run(inspectAccount, approved),
      ],
      [
        "a different confirmation than the held one",
        () =>
          run(
            inspectAccount,
            {
              ...observed,
              account: { confirmationId: otherOp, state: "observed" },
            },
            { ...retained, value: observed },
          ),
      ],
      [
        "a downgrade from approved",
        () => run(inspectAccount, observed, { ...retained, value: approved }),
      ],
      ["an approval with nothing observed", () => run(approve, approved)],
      [
        "an approval of another confirmation",
        () =>
          run({ ...approve, confirmationId: otherOp }, approved, {
            ...retained,
            value: observed,
          }),
      ],
      [
        "an approval that stays observed",
        () => run(approve, observed, { ...retained, value: observed }),
      ],
    ])("is unconfirmed for %s", (_label, call) =>
      expect(call()).toEqual(unconfirmed),
    );
  });
});

describe("configurationIntent", () => {
  const attempt = {
    method: "computer.connector.open",
    requestId: confirmation,
    operationId: op,
    outcome: "unknown",
  } as const;
  const receipt: ConnectorSetupReceipt = {
    kind: "connector.save-and-connect",
    operationId: op,
    buildId,
    state: "completed",
    stoppedAt: "complete",
    credentials: "saved",
    connection: "connected",
    code: null,
    externalVerification: "not-proven",
  };

  it("settles a plain success as applied with no code", () =>
    expect(
      configurationIntent("i", { kind: "chatgpt.verify" }, answeredResult({})),
    ).toEqual({ id: "i", state: "applied", code: null }));

  it("carries the refusal error code", () =>
    expect(
      configurationIntent(
        "i",
        { kind: "chatgpt.verify" },
        answeredResult({}, false),
      ),
    ).toEqual({ id: "i", state: "refused", code: "SETTINGS_INPUT_INVALID" }));

  it("carries a deep test's own code and its unknown effect", () =>
    expect(
      configurationIntent(
        "i",
        { kind: "chatgpt.run-deep-test", operationId: op, taskId: "t" },
        answeredResult({
          evidence: {
            kind: "chatgpt.deep-test-result",
            operationId: op,
            state: "outcome_unknown",
            code: "CHATGPT_SEND_UNKNOWN",
          },
        }),
      ),
    ).toMatchObject({ id: "i", code: "CHATGPT_SEND_UNKNOWN" }));

  it("carries the connector setup receipt", () =>
    expect(
      configurationIntent(
        "i",
        { kind: "chatgpt.verify" },
        answeredResult({ connectorSetup: receipt }),
      ),
    ).toMatchObject({ state: "applied", connectorSetup: receipt }));

  it("keeps an unknown connector setup unknown even when the reply is a refusal", () =>
    expect(
      configurationIntent(
        "i",
        { kind: "chatgpt.verify" },
        answeredResult(
          {
            connectorSetup: {
              ...receipt,
              state: "unknown",
              stoppedAt: "connection",
              connection: "unknown",
              code: "SETTINGS_INPUT_INVALID",
              connectorAttempt: attempt,
            },
          },
          false,
        ),
      ).state,
    ).toBe("unknown"));

  it("carries the connector attempt only from a refusal", () => {
    const refused = answeredResult({ connectorAttempt: attempt }, false);
    expect(
      configurationIntent("i", { kind: "chatgpt.verify" }, refused),
    ).toMatchObject({ connectorAttempt: attempt });
    expect(
      configurationIntent("i", { kind: "chatgpt.verify" }, answeredResult({})),
    ).not.toHaveProperty("connectorAttempt");
  });

  const readiness = {
    kind: "chatgpt.readiness",
    state: "authenticated",
    code: null,
  };
  it("carries readiness only for a verification", () => {
    const outcome = answeredResult({ evidence: readiness });
    expect(
      configurationIntent("i", { kind: "chatgpt.verify" }, outcome),
    ).toMatchObject({ chatGptReadiness: readiness });
    expect(
      configurationIntent("i", { kind: "chatgpt.open-browser" }, outcome),
    ).not.toHaveProperty("chatGptReadiness");
  });
});

describe("signInCheckToRetain", () => {
  const binding = { documentGeneration: 3, sequence: 1 };
  const observation = {
    observationId: "o",
    buildId,
    counter: 1,
    pending: false,
    state: "authenticated",
    binding,
  } as const;
  const applied: Intent = {
    id: "i",
    state: "applied",
    code: null,
    chatGptReadiness: {
      kind: "chatgpt.readiness",
      state: "authenticated",
      code: null,
    },
  };
  const verify = { kind: "chatgpt.verify" } as const;

  it("retains an authenticated, settled observation of this build", () =>
    expect(signInCheckToRetain(verify, applied, observation, buildId)).toEqual({
      buildId,
      binding,
    }));
  it.each([
    [
      "another command",
      () =>
        signInCheckToRetain(
          { kind: "chatgpt.open-browser" },
          applied,
          observation,
          buildId,
        ),
    ],
    [
      "a verification that did not apply",
      () =>
        signInCheckToRetain(
          verify,
          { ...applied, state: "unknown" },
          observation,
          buildId,
        ),
    ],
    [
      "a readiness that is not authenticated",
      () =>
        signInCheckToRetain(
          verify,
          {
            ...applied,
            chatGptReadiness: {
              kind: "chatgpt.readiness",
              state: "signed_out",
              code: "CHATGPT_SIGN_IN_REQUIRED",
            },
          },
          observation,
          buildId,
        ),
    ],
    [
      "no readiness",
      () =>
        signInCheckToRetain(
          verify,
          { id: "i", state: "applied", code: null },
          observation,
          buildId,
        ),
    ],
    [
      "no observation",
      () => signInCheckToRetain(verify, applied, null, buildId),
    ],
    [
      "a signed-out observation",
      () =>
        signInCheckToRetain(
          verify,
          applied,
          { ...observation, state: "signed_out" },
          buildId,
        ),
    ],
    [
      "a pending observation",
      () =>
        signInCheckToRetain(
          verify,
          applied,
          { ...observation, pending: true },
          buildId,
        ),
    ],
    [
      "an observation without a binding",
      () =>
        signInCheckToRetain(
          verify,
          applied,
          { ...observation, binding: null },
          buildId,
        ),
    ],
    [
      "an observation of another build",
      () => signInCheckToRetain(verify, applied, observation, otherBuild),
    ],
    [
      "a window with no build",
      () => signInCheckToRetain(verify, applied, observation, null),
    ],
  ])("retains nothing for %s", (_label, call) => expect(call()).toBeNull());
});

describe("workspaceEditPreviewOwner", () => {
  const prepare = {
    kind: "computer.prepare-workspace-edit",
    workspaceId,
  } as unknown as ProductConfigurationCommand;
  const preview: Evidence<"computer.workspace-edit-preview"> = {
    kind: "computer.workspace-edit-preview",
    operationId: "op-1",
    workspaceId,
    relativePath: "file.txt",
    bytes: 10,
    beforeSha256: "b".repeat(64),
    expiresAt: "2026-10-04T20:05:00.000Z",
  };
  const run = (
    overrides: {
      command?: ProductConfigurationCommand;
      value?: ProductConfigurationEvidence | undefined;
      before?: WindowSnapshot;
      current?: WindowSnapshot;
      revision?: number | null;
      latest?: boolean;
    } = {},
  ) =>
    workspaceEditPreviewOwner(
      overrides.command ?? prepare,
      "value" in overrides ? overrides.value : preview,
      overrides.before ?? snapshot(),
      overrides.current ?? snapshot(),
      "revision" in overrides ? (overrides.revision ?? null) : 1,
      overrides.latest ?? true,
    );

  it("owns the preview by build, computer and generation", () =>
    expect(run()).toEqual({
      preview,
      owner: {
        buildId,
        computerId: "11111111-1111-4111-8111-111111111111",
        generation: 1,
      },
    }));

  const changedComputer = (patch: Record<string, unknown>) => {
    const configuration = ready();
    if (configuration?.status !== "ready") throw new Error("fixture");
    configuration.settings.computer = {
      ...configuration.settings.computer,
      ...patch,
    };
    return snapshot({ configuration });
  };
  it.each([
    [
      "another command",
      { command: { kind: "chatgpt.verify" } as ProductConfigurationCommand },
    ],
    ["no evidence", { value: undefined }],
    ["another workspace", { value: { ...preview, workspaceId: otherOp } }],
    [
      "a window not ready before",
      { before: snapshot({ configuration: null }) },
    ],
    ["a window not ready now", { current: snapshot({ configuration: null }) }],
    ["a reply that is no longer the latest", { latest: false }],
    ["no revision", { revision: null }],
    ["another revision", { revision: 2 }],
    ["no build before", { before: snapshot({ buildId: null }) }],
    ["a build that changed", { current: snapshot({ buildId: otherBuild }) }],
    [
      "a computer that changed",
      { current: changedComputer({ computerId: otherOp }) },
    ],
    [
      "a generation that changed",
      { current: changedComputer({ generation: 9 }) },
    ],
    [
      "a window that is not current",
      { current: snapshot({ status: "stale" }) },
    ],
  ])("owns nothing for %s", (_label, overrides) =>
    expect(run(overrides)).toBeNull(),
  );
});

describe("dispatch decisions", () => {
  const sha = "a".repeat(64);
  it.each([
    ["settings:connector.verify-app:", true],
    [`settings:connector.verify-app:${sha}`, true],
    [`settings:connector.verify-separate-app:${sha}`, true],
    ["settings:connector.verify-app:abc", false],
    [`settings:connector.verify-app:${sha}0`, false],
    [`settings:connector.verify-app:${sha.toUpperCase()}`, false],
    ["settings:connector.start:", false],
    ["settings:chatgpt.verify:", false],
    [`x:settings:connector.verify-app:${sha}`, false],
  ])("isConnectorVerifyKey(%s) is %s", (key, expected) =>
    expect(isConnectorVerifyKey(key)).toBe(expected),
  );

  it.each([
    ["settings:chatgpt.verify:", true],
    ["settings:chatgpt.verify:x", false],
    [`settings:connector.verify-separate-app:${sha}`, true],
    ["settings:connector.start:", false],
  ])("completesSetupKey(%s) is %s", (key, expected) =>
    expect(completesSetupKey(key)).toBe(expected),
  );

  it("replays an identical payload and conflicts on a different one", () => {
    expect(payloadConflict("k", "a", "a")).toBeNull();
    expect(payloadConflict("k", "a", "b")).toEqual({
      id: "k",
      state: "refused",
      code: "INTENTION_PAYLOAD_CONFLICT",
    });
  });

  it("reports an unavailable binding as refused", () =>
    expect(bindingUnavailable("k")).toEqual({
      id: "k",
      state: "refused",
      code: "COMMAND_BINDING_UNAVAILABLE",
    }));

  it.each([
    ["admitted and live", false, true, null],
    ["not admitted", false, false, "CURRENT_STATE_REQUIRED"],
    ["disposed", true, true, "WINDOW_OBSERVATION_CLOSED"],
    ["disposed and not admitted", true, false, "WINDOW_OBSERVATION_CLOSED"],
  ])("admission when %s", (_label, disposed, admitted, code) =>
    expect(admissionRefusal("k", disposed, admitted)).toEqual(
      code === null ? null : { id: "k", state: "refused", code },
    ),
  );

  it("refuses a command whose state changed before it ran", () =>
    expect(staleAdmissionRefusal("k")).toEqual({
      id: "k",
      state: "refused",
      code: "CURRENT_STATE_REQUIRED",
    }));
});
