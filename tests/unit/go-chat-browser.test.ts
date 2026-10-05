import { describe, expect, it, vi } from "vitest";
import {
  GoChatBrowserDriver,
  type AssignedChatBrowser,
  type QualifiedControlTranslation,
} from "../../apps/desktop/go-chat-browser.ts";
import {
  validate,
  type BrowserLease,
  type BrowserPrepare,
  type BrowserBinding,
  type BrowserVerification,
  type BrowserSelection,
  type BrowserRequiredControls,
} from "../../apps/desktop/bridge/wire.ts";
import type {
  ChatGptPhysicalApi,
  PhysicalBinding,
  PhysicalFrame,
  PhysicalSelectionEvidence,
  PhysicalObservedSelection,
  PhysicalFact,
  PhysicalWitness,
} from "../../apps/desktop/chatgpt-physical-api.ts";

// Strict CPU physical doubles only. No Electron, native browser, provider,
// network, actual controls, host assignment or installed acceptance is proven.
type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };
const clone = <T>(value: T): Mutable<T> => structuredClone(value);
const lease: BrowserLease = {
  identity: {
    profileId: "profile",
    ownerId: "owner",
    sessionId: "session",
    taskId: "task",
    turnId: "turn",
    operationId: "operation",
    turnGeneration: "1",
  },
  backendGeneration: "backend",
  slotOrdinal: 1,
  slotGeneration: "1",
};
const selection: BrowserSelection = {
  provider: "farol",
  alias: "chatgpt",
  accountId: "account",
  modelId: "model-pro",
  effort: "high",
  mode: "standard",
  connectorId: "connector",
  connectorGrantId: "grant",
  toolsEnabled: true,
};
const required: BrowserRequiredControls = {
  model: true,
  effort: true,
  mode: true,
  connector: true,
};
const translation: QualifiedControlTranslation = {
  version: "public-controls-v1",
  configSHA256: "a".repeat(64),
  translationId: "controls-v1",
  model: [{ value: "model-pro", literal: "Pro" }],
  effort: [{ value: "high", literal: "High" }],
  mode: [{ value: "standard", literal: "standard" }],
  connector: [{ value: "connector", literal: "Files" }],
};
const home: PhysicalBinding = {
  phase: "home",
  conversationId: null,
  url: "https://chatgpt.com/",
  viewId: "view",
  viewGeneration: 1,
  documentGeneration: 1,
  partition: "persist:farol-next-chatgpt",
};
const saved: PhysicalBinding = {
  ...home,
  phase: "conversation",
  conversationId: "cid",
  url: "https://chatgpt.com/c/cid",
};
const unknown = (): PhysicalFact<never> => ({
  state: "unknown",
  code: "not-exposed",
});
const fact = <T>(value: T): PhysicalFact<T> => ({
  state: "observed",
  source: "public-dom",
  value,
});
function observed(): Mutable<PhysicalObservedSelection> {
  return {
    modelLabel: fact("Pro"),
    effortLabel: fact("High"),
    modeLabel: fact("standard"),
    connectorLabel: fact("Files"),
  };
}
function frame(terminal = false): PhysicalFrame {
  return {
    userId: "user",
    messages: [
      {
        id: "reply",
        parentId: "user",
        channel: "commentary",
        text: "Working",
        complete: true,
      },
      {
        id: "answer",
        parentId: "reply",
        channel: "answer",
        text: "**Result**",
        complete: terminal,
      },
    ],
    terminal,
  };
}
function fixture(
  options: {
    followup?: boolean;
    required?: BrowserRequiredControls;
    translation?: QualifiedControlTranslation;
  } = {},
) {
  let now = 1000;
  let assignment: AssignedChatBrowser | undefined;
  let evidence: PhysicalSelectionEvidence | undefined;
  let minted: PhysicalWitness | undefined;
  let physicalOrigin = options.followup ? clone(saved) : clone(home);
  let publicFrame: PhysicalFrame | null = frame();
  let facts = observed();
  const api: ChatGptPhysicalApi = {
    prepare: vi.fn<ChatGptPhysicalApi["prepare"]>(async (input, guard) => {
      expect(input).toEqual({
        operationId: "operation",
        target: options.followup
          ? { kind: "owned-saved", conversationId: "cid" }
          : { kind: "new-saved" },
        deadlineMillis: 14000,
      });
      expect(guard(physicalOrigin)).toBe(true);
      return {
        state: "prepared",
        binding: clone(physicalOrigin),
        readiness: "ready",
      };
    }),
    verifySend: vi.fn<ChatGptPhysicalApi["verifySend"]>(
      async (input, guard) => {
        expect(guard(input.binding)).toBe(true);
        expect(input.operationId).toBe("operation");
        expect(input.binding).toEqual(physicalOrigin);
        expect(input.intentDigest).toBe("b".repeat(64));
        expect(input.previous).toEqual(
          options.followup
            ? { userTurnId: "previous-user", replyId: "previous-reply" }
            : null,
        );
        expect(Object.hasOwn(input, "prompt")).toBe(false);
        evidence = {
          declared: clone(input.selection),
          observed: clone(facts),
          observedAtMillis: now,
          sourceProfile: "message-anchors-v1",
        };
        minted = { ...input, evidenceId: "witness", selection: evidence };
        return { state: "witnessed", witness: minted };
      },
    ),
    send: vi.fn<ChatGptPhysicalApi["send"]>(async (input, guard) => {
      expect(guard(input.binding)).toBe(true);
      expect(input.witness).toBe(minted);
      expect(input.operationId).toBe("operation");
      expect(input.prompt).toBe("Transient prompt");
      expect(input.intentDigest).toBe("b".repeat(64));
      return {
        state: "submitted",
        binding: clone(input.binding),
        operationId: input.operationId,
        evidenceId: input.witness.evidenceId,
        code: "physical_submitted",
      };
    }),
    observe: vi.fn<ChatGptPhysicalApi["observe"]>(async (input, guard) => {
      expect(input.operationId).toBe("operation");
      expect(Object.hasOwn(input, "prompt")).toBe(false);
      expect(guard(saved)).toBe(true);
      return {
        state: "observed",
        originBinding: clone(physicalOrigin),
        binding: clone(saved),
        correlation: publicFrame
          ? { userTurnId: "user", replyId: "reply" }
          : { userTurnId: null, replyId: null },
        selection: {
          ...evidence!,
          observed: clone(facts),
          observedAtMillis: now,
        },
        frame: clone(publicFrame),
      };
    }),
    cancel: vi.fn<ChatGptPhysicalApi["cancel"]>(async (input, guard) => {
      expect(guard(input.binding)).toBe(true);
      return {
        state: "requested",
        binding: clone(input.binding),
        code: "stop_requested",
      };
    }),
    dispose: vi.fn<ChatGptPhysicalApi["dispose"]>(async (input, guard) => {
      expect(guard(input.binding)).toBe(true);
      return {
        state: "destroyed",
        view: clone(input.binding),
        destroyedWebContentsId: "contents",
      };
    }),
  };
  assignment = { lease: clone(lease), api, partition: home.partition };
  const lookup = vi.fn((exact: BrowserLease) => {
    expect(exact).toEqual(lease);
    return assignment;
  });
  const driver = new GoChatBrowserDriver({
    lookup,
    translations: [options.translation ?? translation],
    nowMillis: () => now,
  });
  const prepareInput: Mutable<BrowserPrepare> = {
    lease: clone(lease),
    deadlineMillis: "14000",
    target: {
      mode: options.followup ? "owned-saved" : "new-saved",
      conversationId: options.followup ? "cid" : "",
      previousUserTurnId: options.followup ? "previous-user" : "",
      previousReplyId: options.followup ? "previous-reply" : "",
      selection: clone(selection),
      required: clone(options.required ?? required),
      resolution: {
        requestedAlias: "chatgpt",
        requestedExecutor: "farol",
        requestedEffort: "high",
        requestedMode: "standard",
        configSHA256: translation.configSHA256,
        translationId: translation.translationId,
        resolved: clone(selection),
      },
    },
  };
  let binding: BrowserBinding;
  let verification: BrowserVerification;
  async function prepare() {
    const result = await driver.prepare(prepareInput);
    binding = result.binding;
    return result;
  }
  async function verify() {
    const result = await driver.verifySend({
      binding,
      requested: prepareInput.target.selection,
      required: prepareInput.target.required,
      previousUserTurnId: prepareInput.target.previousUserTurnId,
      previousReplyId: prepareInput.target.previousReplyId,
      intentDigest: "b".repeat(64),
      deadlineMillis: "14000",
    });
    verification = result.verification;
    return result;
  }
  async function send() {
    return driver.send({
      binding,
      verification,
      prompt: "Transient prompt",
      intentDigest: "b".repeat(64),
      deadlineMillis: "14000",
    });
  }
  async function start() {
    await prepare();
    await verify();
    return send();
  }
  async function observe(afterSequence = "0", limit = 1) {
    const result = await driver.observe({
      binding,
      afterSequence,
      limit,
      deadlineMillis: "14000",
    });
    for (const e of result.events)
      if (e.kind === "accepted")
        binding = {
          ...e.binding,
          providerState: "bound",
          conversationId: e.providerConversationId,
        };
    return result;
  }
  return {
    driver,
    api,
    lookup,
    prepareInput,
    prepare,
    verify,
    send,
    start,
    observe,
    get binding() {
      return binding;
    },
    get verification() {
      return verification;
    },
    setFacts(next: PhysicalObservedSelection) {
      facts = next;
    },
    setFrame(next: PhysicalFrame | null) {
      publicFrame = next;
    },
    setOrigin(next: PhysicalBinding) {
      physicalOrigin = next;
    },
    tick(delta: number) {
      now += delta;
    },
    replaceAssignment(next: AssignedChatBrowser | undefined) {
      assignment = next;
    },
    assignment() {
      return assignment!;
    },
  };
}

describe("Go Chat BrowserDriver — strict physical doubles, CPU only", () => {
  it("publishes a fail-closed constructor with no allocation or legacy route", () => {
    expect(() => new GoChatBrowserDriver(undefined!)).toThrow(
      "dependencies_missing",
    );
    expect(
      () =>
        new GoChatBrowserDriver({ lookup: () => undefined, translations: [] }),
    ).not.toThrow();
    const f = fixture();
    expect(f.lookup).not.toHaveBeenCalled();
    expect(Object.keys(f.api).sort()).toEqual([
      "cancel",
      "dispose",
      "observe",
      "prepare",
      "send",
      "verifySend",
    ]);
  });
  it.each([false, true])(
    "pins the explicit loopback origin for a real %s saved target",
    async (followup) => {
      const f = fixture({ followup });
      const origin = "http://127.0.0.1:49152";
      f.setOrigin({
        ...(followup ? saved : home),
        url: `${origin}/chatgpt${followup ? "/c/cid" : ""}`,
      });
      const driver = new GoChatBrowserDriver({
        lookup: f.lookup,
        translations: [translation],
        e2eOrigin: origin,
        nowMillis: () => 1000,
      });
      const result = await driver.prepare(f.prepareInput);
      expect(result.binding.providerState).toBe(followup ? "bound" : "home");
      expect(result.binding.conversationId).toBe(followup ? "cid" : "");
      expect(f.api.prepare).toHaveBeenCalledTimes(1);
      expect(f.api.send).not.toHaveBeenCalled();
    },
  );
  it.each([
    "http://127.0.0.1",
    "http://127.0.0.1:0",
    "http://localhost:49152",
    "https://127.0.0.1:49152",
    "http://127.0.0.2:49152",
    "http://127.0.0.1:49152/",
    "http://127.0.0.1:49152/chatgpt",
    "http://127.0.0.1:49152?x=1",
    "http://127.0.0.1:49152#x",
    "http://user@127.0.0.1:49152",
    "https://chatgpt.com",
  ])(
    "rejects noncanonical or nonloopback fixture origin %s before looking up a route",
    (e2eOrigin) => {
      const lookup = vi.fn();
      expect(
        () =>
          new GoChatBrowserDriver({
            lookup,
            translations: [translation],
            e2eOrigin,
          }),
      ).toThrow("fixture_origin_invalid");
      expect(lookup).not.toHaveBeenCalled();
    },
  );
  it.each([
    [undefined, "http://127.0.0.1:49152/chatgpt"],
    ["http://127.0.0.1:49152", "https://chatgpt.com/"],
    ["http://127.0.0.1:49152", "http://127.0.0.1:49153/chatgpt"],
    ["http://127.0.0.1:49152", "http://localhost:49152/chatgpt"],
    ["http://127.0.0.1:49152", "http://user@127.0.0.1:49152/chatgpt"],
    ["http://127.0.0.1:49152", "http://127.0.0.1:49152/"],
    ["http://127.0.0.1:49152", "http://127.0.0.1:49152/chatgpt#foreign"],
  ])(
    "does not accept an unselected physical destination %s → %s",
    async (e2eOrigin, url) => {
      const f = fixture();
      f.setOrigin({ ...home, url: url! });
      const driver = new GoChatBrowserDriver({
        lookup: f.lookup,
        translations: [translation],
        ...(e2eOrigin === undefined ? {} : { e2eOrigin }),
        nowMillis: () => 1000,
      });
      await expect(driver.prepare(f.prepareInput)).rejects.toThrow();
      expect(f.api.verifySend).not.toHaveBeenCalled();
      expect(f.api.send).not.toHaveBeenCalled();
    },
  );
  it("prepares actual Home without prompt, fake CID or saved proof", async () => {
    const f = fixture();
    const prepared = await f.prepare();
    expect(prepared).toMatchObject({
      saved: false,
      binding: { providerState: "home", conversationId: "", lease },
    });
    expect(validate("BrowserPrepared", prepared)).toBe(true);
    expect(f.api.send).not.toHaveBeenCalled();
    await expect(f.prepare()).rejects.toThrow("prepare_consumed");
    expect(f.api.prepare).toHaveBeenCalledTimes(1);
  });
  it("pins config separately from exact label translations and preserves unknown account facts", async () => {
    const f = fixture();
    await f.prepare();
    const { verification } = await f.verify();
    expect(verification.pinned).toEqual(selection);
    expect(verification.required).toEqual(required);
    expect(verification.observed).toMatchObject({
      model: { source: "public-control", value: "model-pro", literal: "Pro" },
      effort: { source: "public-control", value: "high", literal: "High" },
      observedAtMillis: "1000",
    });
    expect(Object.hasOwn(verification.observed, "accountId")).toBe(false);
    expect(validate("BrowserVerification", verification)).toBe(true);
  });
  it.each([
    "modelLabel",
    "effortLabel",
    "modeLabel",
    "connectorLabel",
  ] as const)("refuses required unknown %s without Send", async (field) => {
    const f = fixture();
    const facts = observed();
    facts[field] = unknown();
    f.setFacts(facts);
    await f.prepare();
    await expect(f.verify()).rejects.toThrow("required_control_unknown");
    expect(f.api.send).not.toHaveBeenCalled();
  });
  it("retains optional missing controls as unknown", async () => {
    const f = fixture({
      required: { model: true, effort: false, mode: false, connector: false },
    });
    const facts = observed();
    facts.effortLabel = unknown();
    facts.modeLabel = unknown();
    facts.connectorLabel = unknown();
    f.setFacts(facts);
    await f.prepare();
    const result = await f.verify();
    for (const field of ["effort", "mode", "connector"] as const)
      expect(result.verification.observed[field]).toEqual({
        source: "unknown",
        value: "",
        literal: "",
      });
  });
  it.each(["modelLabel", "effortLabel", "connectorLabel"] as const)(
    "rejects requested IDs passed as %s DOM labels",
    async (field) => {
      const f = fixture();
      const facts = observed();
      facts[field] = fact(
        field === "modelLabel"
          ? "model-pro"
          : field === "effortLabel"
            ? "high"
            : "connector",
      );
      f.setFacts(facts);
      await f.prepare();
      await expect(f.verify()).rejects.toThrow("control_translation_mismatch");
    },
  );
  it("rejects an unknown optional control that claims unqualified evidence", async () => {
    const f = fixture({ required: { ...required, effort: false } });
    const facts = observed();
    facts.effortLabel = fact("Invented");
    f.setFacts(facts);
    await f.prepare();
    await expect(f.verify()).rejects.toThrow("control_translation_mismatch");
  });
  it("refuses missing trusted translation before physical preparation", async () => {
    const f = fixture();
    f.prepareInput.target.resolution.translationId = "other";
    await expect(f.prepare()).rejects.toThrow("translation_unqualified");
    expect(f.api.prepare).not.toHaveBeenCalled();
  });
  it("rejects ambiguous and unversioned host translations", () => {
    expect(
      () =>
        new GoChatBrowserDriver({
          lookup: () => undefined,
          translations: [
            {
              ...translation,
              model: [
                ...translation.model,
                { value: "different", literal: "Pro" },
              ],
            },
          ],
        }),
    ).toThrow("translation_unqualified");
    expect(
      () =>
        new GoChatBrowserDriver({
          lookup: () => undefined,
          translations: [
            { ...translation, version: "unknown" as "public-controls-v1" },
          ],
        }),
    ).toThrow("translation_unqualified");
  });
  // Keep these literal vectors aligned with Go's TestControlFactLiteralConformance.
  const literalVectors = [
    ...[255, 256, 257, 512].flatMap((bytes) => [
      {
        name: `ASCII-${bytes}`,
        literal: "x".repeat(bytes),
        accepted: bytes <= 256,
      },
      {
        name: `UTF8-two-byte-${bytes}`,
        literal: "é".repeat(Math.floor(bytes / 2)) + "x".repeat(bytes % 2),
        accepted: bytes <= 256,
      },
      {
        name: `UTF8-four-byte-${bytes}`,
        literal: "😀".repeat(Math.floor(bytes / 4)) + "x".repeat(bytes % 4),
        accepted: bytes <= 256,
      },
    ]),
    { name: "empty", literal: "", accepted: false },
    ...[
      " ",
      "\u0085",
      "\u00a0",
      "\u1680",
      ...Array.from({ length: 11 }, (_, i) => String.fromCodePoint(0x2000 + i)),
      "\u2028",
      "\u2029",
      "\u202f",
      "\u205f",
      "\u3000",
    ].map((literal) => ({
      name: `blank-U+${literal.codePointAt(0)!.toString(16)}`,
      literal,
      accepted: false,
    })),
    ...[...Array.from({ length: 32 }, (_, i) => i), 127].map((code) => ({
      name: `control-${code}`,
      literal: `A${String.fromCodePoint(code)}B`,
      accepted: false,
    })),
    { name: "unpaired-high-surrogate", literal: "\ud800", accepted: false },
    { name: "unpaired-low-surrogate", literal: "\udc00", accepted: false },
    {
      name: "padded-exact-text",
      literal: "\u0085 Model é 😀 \u3000",
      accepted: true,
    },
    { name: "BOM-is-not-Go-whitespace", literal: "\ufeff", accepted: true },
    { name: "C1-is-not-Go-control", literal: "\u0080\u009f", accepted: true },
    { name: "replacement-character", literal: "\ufffd", accepted: true },
    { name: "decomposed-exact-text", literal: "e\u0301", accepted: true },
  ];
  for (const field of ["model", "effort", "mode", "connector"] as const) {
    it.each(literalVectors)(
      `${field} literal conformance: $name`,
      async ({ literal, accepted }) => {
        const config = clone(translation);
        config[field][0]!.literal = literal;
        if (!accepted) {
          const f = fixture();
          await expect(async () => {
            const driver = new GoChatBrowserDriver({
              lookup: f.lookup,
              translations: [config],
              nowMillis: () => 1000,
            });
            await driver.prepare(f.prepareInput);
          }).rejects.toThrow("translation_unqualified");
          expect(f.lookup).not.toHaveBeenCalled();
          expect(f.api.prepare).not.toHaveBeenCalled();
          expect(f.api.verifySend).not.toHaveBeenCalled();
          expect(f.api.send).not.toHaveBeenCalled();
          return;
        }
        const f = fixture({ translation: config });
        const facts = observed();
        facts[`${field}Label`] = fact(literal);
        f.setFacts(facts);
        await f.prepare();
        const result = await f.verify();
        expect(result.verification.observed[field].literal).toBe(literal);
        expect(
          vi.mocked(f.api.verifySend).mock.calls[0]![0].selection.controls,
        ).toEqual({
          modelLabel: config.model[0]!.literal,
          effortLabel: config.effort[0]!.literal,
          modeLabel: config.mode[0]!.literal,
          connector: { id: "connector", label: config.connector[0]!.literal },
        });
        await f.send();
        expect(f.api.send).toHaveBeenCalledTimes(1);
      },
    );
    it.each([120, 121, 128])(
      `${field} canonical value conformance: %i bytes`,
      (bytes) => {
        const config = clone(translation);
        config[field][0]!.value = "x".repeat(bytes);
        const f = fixture();
        const construct = () =>
          new GoChatBrowserDriver({ lookup: f.lookup, translations: [config] });
        if (bytes <= 120) expect(construct).not.toThrow();
        else expect(construct).toThrow("translation_unqualified");
        expect(f.lookup).not.toHaveBeenCalled();
        expect(f.api.prepare).not.toHaveBeenCalled();
      },
    );
  }
  it.each([
    "profileId",
    "ownerId",
    "sessionId",
    "taskId",
    "turnId",
    "operationId",
    "turnGeneration",
  ] as const)("checks exact host-assigned identity.%s", async (field) => {
    const f = fixture();
    const changed = clone(lease);
    changed.identity[field] = "9";
    f.replaceAssignment({ ...f.assignment(), lease: changed });
    await expect(f.prepare()).rejects.toThrow("assignment_mismatch");
    expect(f.api.prepare).not.toHaveBeenCalled();
  });
  it.each(["backendGeneration", "slotOrdinal", "slotGeneration"] as const)(
    "checks exact host-assigned lease.%s",
    async (field) => {
      const f = fixture();
      const changed = clone(lease);
      if (field === "slotOrdinal") changed.slotOrdinal = 2;
      else changed[field] = "9";
      f.replaceAssignment({ ...f.assignment(), lease: changed });
      await expect(f.prepare()).rejects.toThrow("assignment_mismatch");
    },
  );
  it("refuses unassigned and non-dedicated partitions", async () => {
    const f = fixture();
    f.replaceAssignment(undefined);
    await expect(f.prepare()).rejects.toThrow("assignment_mismatch");
    const g = fixture();
    g.replaceAssignment({
      ...g.assignment(),
      partition: "persist:farol" as typeof home.partition,
    });
    await expect(g.prepare()).rejects.toThrow("assignment_mismatch");
  });
  it.each(["viewGeneration", "documentGeneration"] as const)(
    "rejects lossy physical %s conversion",
    async (field) => {
      const f = fixture();
      f.setOrigin({ ...home, [field]: Number.MAX_SAFE_INTEGER + 1 });
      await expect(f.prepare()).rejects.toThrow("physical_unknown");
    },
  );
  it("fences Prepare exceptions and does not repeat navigation", async () => {
    const f = fixture();
    vi.mocked(f.api.prepare).mockRejectedValue(
      new Error("private page detail"),
    );
    await expect(f.prepare()).rejects.toThrow("physical_unknown");
    await expect(f.prepare()).rejects.toThrow("prepare_consumed");
    expect(f.api.prepare).toHaveBeenCalledTimes(1);
  });
  it("consumes one exact witness and one physical Send", async () => {
    const f = fixture();
    expect(await f.start()).toMatchObject({
      status: "submitted",
      verificationId: "witness",
    });
    await expect(f.send()).rejects.toThrow("send_witness_mismatch");
    expect(f.api.send).toHaveBeenCalledTimes(1);
  });
  it.each(["unknown", "not-sent"] as const)(
    "never repeats a %s Send; unknown can still be observed",
    async (state) => {
      const f = fixture();
      vi.mocked(f.api.send).mockImplementation(async (input) => ({
        state,
        binding: input.binding,
        operationId: input.operationId,
        evidenceId: input.witness.evidenceId,
        code: "physical_unconfirmed",
      }));
      expect((await f.start()).status).toBe(state);
      await expect(f.send()).rejects.toThrow("send_witness_mismatch");
      if (state === "unknown")
        expect((await f.observe()).events[0]?.kind).toBe("accepted");
      expect(f.api.send).toHaveBeenCalledTimes(1);
    },
  );
  it("does not dispatch a tampered Go verification", async () => {
    const f = fixture();
    await f.prepare();
    await f.verify();
    const changed = clone(f.verification);
    changed.observed.model.literal = "Fake";
    await expect(
      f.driver.send({
        binding: f.binding,
        verification: changed,
        prompt: "Transient prompt",
        intentDigest: "b".repeat(64),
        deadlineMillis: "14000",
      }),
    ).rejects.toThrow("send_witness_mismatch");
    expect(f.api.send).not.toHaveBeenCalled();
  });
  it("rechecks host assignment after awaited Send and never retries", async () => {
    const f = fixture();
    vi.mocked(f.api.send).mockImplementation(async (input) => {
      const changed = clone(lease);
      changed.slotGeneration = "2";
      f.replaceAssignment({ ...f.assignment(), lease: changed });
      return {
        state: "submitted",
        binding: input.binding,
        operationId: input.operationId,
        evidenceId: input.witness.evidenceId,
        code: "submitted",
      };
    });
    expect((await f.start()).status).toBe("unknown");
    await expect(f.send()).rejects.toThrow("send_witness_mismatch");
    expect(f.api.send).toHaveBeenCalledTimes(1);
  });
  it("adopts provider CID only on accepted and emits settled commentary before terminal", async () => {
    const f = fixture();
    await f.start();
    const accepted = await f.observe();
    expect(accepted.events).toHaveLength(1);
    expect(accepted.events[0]).toMatchObject({
      kind: "accepted",
      sequence: "1",
      providerConversationId: "cid",
      userTurnId: "user",
      replyId: "reply",
      binding: { providerState: "home", conversationId: "" },
    });
    expect(f.binding).toMatchObject({
      providerState: "bound",
      conversationId: "cid",
    });
    f.tick(500);
    const commentary = await f.observe("1");
    expect(commentary.events[0]).toMatchObject({
      kind: "commentary",
      text: "Working",
      sequence: "2",
      providerConversationId: "",
      binding: { providerState: "bound", conversationId: "cid" },
    });
    const repeat = await f.observe("1");
    expect(repeat).toEqual(commentary);
    expect(f.api.observe).toHaveBeenCalledTimes(2);
  });
  it("handles terminal paging and remount without re-emitting a semantic unit", async () => {
    const f = fixture();
    await f.start();
    await f.observe();
    f.tick(500);
    await f.observe("1");
    f.setFrame(frame(true));
    const answer = await f.observe("2");
    expect(answer.events[0]).toMatchObject({
      kind: "answer-delta",
      text: "**Result**",
      sequence: "3",
      userTurnId: "user",
      replyId: "reply",
    });
    const complete = await f.observe("3");
    expect(complete.events[0]?.kind).toBe("completed");
    const quiescent = await f.observe("4");
    expect(quiescent.events[0]?.kind).toBe("quiescent");
    expect(await f.observe("5")).toEqual({ events: [], gap: false });
    expect(f.api.observe).toHaveBeenCalledTimes(3);
    expect(await f.observe("4")).toEqual({ events: [], gap: true });
  });
  it("keeps nullable provider IDs unbound until an anchored frame exists", async () => {
    const f = fixture();
    await f.start();
    f.setFrame(null);
    expect(await f.observe()).toEqual({ events: [], gap: false });
    expect(f.binding.providerState).toBe("home");
  });
  it("rejects changed user IDs and unqualified terminal frames", async () => {
    const f = fixture();
    await f.start();
    f.setFrame({ ...frame(true), userId: "other" });
    await expect(f.observe()).rejects.toThrow("frame_correlation_unknown");
    const g = fixture();
    await g.start();
    g.setFrame({ ...frame(), terminal: true });
    await expect(g.observe()).rejects.toThrow("physical_unknown");
  });
  it("rejects future cursors without reading physical state", async () => {
    const f = fixture();
    await f.start();
    await expect(f.observe("99")).rejects.toThrow("cursor_invalid");
    expect(f.api.observe).not.toHaveBeenCalled();
  });
  it("rejects document replacement during a physical observation", async () => {
    const f = fixture();
    await f.start();
    vi.mocked(f.api.observe).mockImplementation(async (_input, guard) => {
      expect(guard({ ...saved, documentGeneration: 2 })).toBe(false);
      return { state: "unknown", code: "document_changed" };
    });
    expect((await f.observe()).events[0]).toMatchObject({
      kind: "unknown",
      providerConversationId: "",
    });
  });
  it("prepares and sends a same-conversation follow-up with exact previous pair", async () => {
    const f = fixture({ followup: true });
    const prepared = await f.prepare();
    expect(prepared.saved).toBe(true);
    expect(prepared.binding).toMatchObject({
      providerState: "bound",
      conversationId: "cid",
    });
    await f.verify();
    await f.send();
    const result = await f.observe();
    expect(result.events[0]).toMatchObject({
      kind: "accepted",
      providerConversationId: "cid",
      binding: { conversationId: "cid" },
    });
  });
  it("scopes one Stop attempt without treating missing control as terminal", async () => {
    const f = fixture();
    await f.start();
    const input = { binding: f.binding, deadlineMillis: "14000" };
    expect(await f.driver.cancel(input)).toMatchObject({
      status: "requested",
      code: "PHYSICAL_STOP_REQUESTED",
    });
    await expect(f.driver.cancel(input)).rejects.toThrow("cancel_consumed");
    expect(f.api.cancel).toHaveBeenCalledTimes(1);
  });
  it("requires exact anchored terminal proof for cancellation", async () => {
    const f = fixture();
    await f.start();
    await f.observe();
    vi.mocked(f.api.cancel).mockResolvedValue({
      state: "confirmed-terminal",
      proof: {
        binding: saved,
        correlation: { userTurnId: "user", replyId: "reply" },
        frame: frame(true),
      },
    });
    expect(
      await f.driver.cancel({ binding: f.binding, deadlineMillis: "14000" }),
    ).toMatchObject({
      status: "confirmed-terminal",
      code: "PHYSICAL_TERMINAL_CONFIRMED",
    });
    const g = fixture();
    await g.start();
    await g.observe();
    vi.mocked(g.api.cancel).mockResolvedValue({
      state: "already-terminal",
      proof: {
        binding: saved,
        correlation: { userTurnId: "other", replyId: "reply" },
        frame: frame(true),
      },
    });
    await expect(
      g.driver.cancel({ binding: g.binding, deadlineMillis: "14000" }),
    ).rejects.toThrow("terminal_unqualified");
  });
  it("confirms disposal only for the exact destroyed view", async () => {
    const f = fixture();
    await f.prepare();
    const input = { lease, deadlineMillis: "14000" };
    expect(await f.driver.dispose(input)).toMatchObject({
      lease,
      confirmed: true,
      code: "PHYSICAL_DESTROYED",
    });
    await expect(f.driver.dispose(input)).rejects.toThrow("not_prepared");
    expect(f.api.dispose).toHaveBeenCalledTimes(1);
  });
  it.each([
    "viewId",
    "viewGeneration",
    "documentGeneration",
    "partition",
  ] as const)(
    "does not confirm destruction of a different %s",
    async (field) => {
      const f = fixture();
      await f.prepare();
      const view = {
        ...home,
        [field]: field.includes("Generation") ? 2 : "different",
      };
      vi.mocked(f.api.dispose).mockResolvedValue({
        state: "destroyed",
        view: view as typeof home,
        destroyedWebContentsId: "contents",
      });
      expect(
        (await f.driver.dispose({ lease, deadlineMillis: "14000" })).confirmed,
      ).toBe(false);
      await expect(
        f.driver.dispose({ lease, deadlineMillis: "14000" }),
      ).rejects.toThrow("dispose_consumed");
    },
  );
  it("never upgrades void destruction to confirmed", async () => {
    const f = fixture();
    await f.prepare();
    vi.mocked(f.api.dispose).mockResolvedValue(undefined!);
    await expect(
      f.driver.dispose({ lease, deadlineMillis: "14000" }),
    ).rejects.toThrow("physical_unknown");
  });
  it("refuses expired deadlines before physical calls", async () => {
    const f = fixture();
    f.tick(13000);
    await expect(f.prepare()).rejects.toThrow("deadline");
    expect(f.api.prepare).not.toHaveBeenCalled();
  });
  it("observes the original operation after a thrown unknown Send without replay", async () => {
    const f = fixture();
    vi.mocked(f.api.send).mockRejectedValue(
      new Error("private transcript detail"),
    );
    expect(await f.start()).toMatchObject({
      status: "unknown",
      code: "PHYSICAL_SEND_UNKNOWN",
    });
    expect((await f.observe()).events[0]?.kind).toBe("accepted");
    await expect(f.send()).rejects.toThrow("send_witness_mismatch");
    expect(f.api.send).toHaveBeenCalledTimes(1);
  });
  it("does not turn an explicitly not-sent operation into accepted browser output", async () => {
    const f = fixture();
    vi.mocked(f.api.send).mockImplementation(async (input) => ({
      state: "not-sent",
      binding: input.binding,
      operationId: input.operationId,
      evidenceId: input.witness.evidenceId,
      code: "not_sent",
    }));
    await f.start();
    await expect(f.observe()).rejects.toThrow("cursor_invalid");
    expect(f.api.observe).not.toHaveBeenCalled();
  });
  it("binds a proven user/CID before a reply anchor exists", async () => {
    const f = fixture();
    await f.start();
    const original = vi.mocked(f.api.observe).getMockImplementation()!;
    vi.mocked(f.api.observe).mockImplementationOnce(async (input, guard) => {
      const result = await original(input, guard);
      if (result.state !== "observed") throw new Error("strict double invalid");
      return {
        ...result,
        correlation: { userTurnId: "user", replyId: null },
        frame: null,
      };
    });
    expect((await f.observe()).events[0]).toMatchObject({
      kind: "accepted",
      providerConversationId: "cid",
      userTurnId: "user",
      replyId: "",
    });
    expect((await f.observe("1")).events).toHaveLength(0);
    f.tick(500);
    expect((await f.observe("1")).events[0]).toMatchObject({
      kind: "commentary",
      userTurnId: "user",
      replyId: "reply",
    });
  });
  it("maps public mode labels through the trusted table instead of copying a requested mode", async () => {
    const f = fixture();
    const driver = new GoChatBrowserDriver({
      lookup: f.lookup,
      translations: [
        { ...translation, mode: [{ value: "standard", literal: "Standard" }] },
      ],
      nowMillis: () => 1000,
    });
    f.setFacts({ ...observed(), modeLabel: fact("Standard") });
    const prepared = await driver.prepare(f.prepareInput);
    const result = await driver.verifySend({
      binding: prepared.binding,
      requested: selection,
      required,
      previousUserTurnId: "",
      previousReplyId: "",
      intentDigest: "b".repeat(64),
      deadlineMillis: "14000",
    });
    expect(result.verification.observed.mode).toEqual({
      source: "public-control",
      literal: "Standard",
      value: "standard",
    });
  });
  it("does not verify a non-ready physical preparation", async () => {
    const f = fixture();
    vi.mocked(f.api.prepare).mockResolvedValue({
      state: "prepared",
      binding: home,
      readiness: "sign-in-required",
    });
    await f.prepare();
    await expect(f.verify()).rejects.toThrow("verification_scope_mismatch");
    expect(f.api.verifySend).not.toHaveBeenCalled();
  });
  it("rejects a mutated physical witness before dispatch", async () => {
    const f = fixture();
    const original = vi.mocked(f.api.verifySend).getMockImplementation()!;
    let witness: PhysicalWitness | undefined;
    vi.mocked(f.api.verifySend).mockImplementation(async (input, guard) => {
      const reply = await original(input, guard);
      if (reply.state === "witnessed") witness = reply.witness;
      return reply;
    });
    await f.prepare();
    await f.verify();
    Object.assign(witness!, { intentDigest: "c".repeat(64) });
    await expect(f.send()).rejects.toThrow("send_witness_mismatch");
    expect(f.api.send).not.toHaveBeenCalled();
  });
  it("caps a Send guard at the original witness deadline", async () => {
    const f = fixture();
    await f.prepare();
    await f.verify();
    vi.mocked(f.api.send).mockImplementation(async (input, guard) => {
      f.tick(13000);
      expect(guard(input.binding)).toBe(false);
      return {
        state: "submitted",
        binding: input.binding,
        operationId: input.operationId,
        evidenceId: input.witness.evidenceId,
        code: "submitted",
      };
    });
    expect(
      (
        await f.driver.send({
          binding: f.binding,
          verification: f.verification,
          prompt: "Transient prompt",
          intentDigest: "b".repeat(64),
          deadlineMillis: "15000",
        })
      ).status,
    ).toBe("unknown");
  });
  it("does not stop or destroy a route while the one physical Send is in flight", async () => {
    const f = fixture();
    await f.prepare();
    await f.verify();
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = vi.mocked(f.api.send).getMockImplementation()!;
    vi.mocked(f.api.send).mockImplementation(async (input, guard) => {
      await pending;
      return original(input, guard);
    });
    const send = f.send();
    await expect(
      f.driver.dispose({ lease, deadlineMillis: "14000" }),
    ).rejects.toThrow("call_in_flight");
    await expect(
      f.driver.cancel({ binding: f.binding, deadlineMillis: "14000" }),
    ).rejects.toThrow("cancel_consumed");
    expect(f.api.dispose).not.toHaveBeenCalled();
    expect(f.api.cancel).not.toHaveBeenCalled();
    release!();
    await send;
  });
  it("never rebinds an accepted Home operation to a second provider CID", async () => {
    const f = fixture();
    await f.start();
    await f.observe();
    const original = vi.mocked(f.api.observe).getMockImplementation()!;
    vi.mocked(f.api.observe).mockImplementation(async (input, guard) => {
      const result = await original(input, guard);
      if (result.state !== "observed") throw new Error("strict double invalid");
      return {
        ...result,
        binding: {
          ...saved,
          conversationId: "other",
          url: "https://chatgpt.com/c/other",
        },
      };
    });
    await expect(f.observe("1")).rejects.toThrow("observe_binding_unknown");
    expect(f.binding.conversationId).toBe("cid");
  });
  it("retains committed ancestry across an actual virtualized tail remount", async () => {
    const f = fixture();
    await f.start();
    await f.observe();
    f.tick(500);
    await f.observe("1");
    f.setFrame({
      userId: "user",
      messages: [frame(true).messages[1]!],
      terminal: true,
    });
    expect((await f.observe("2")).events[0]).toMatchObject({
      kind: "answer-delta",
      text: "**Result**",
      segmentId: "answer",
    });
    expect(f.api.send).toHaveBeenCalledTimes(1);
  });
  it("preserves Markdown separators and splits UTF-8 at the wire byte bound", async () => {
    const f = fixture();
    await f.start();
    const long = "👋".repeat(20000);
    f.setFrame({
      userId: "user",
      messages: [
        {
          id: "reply",
          parentId: "user",
          channel: "answer",
          text: "First",
          complete: true,
        },
        {
          id: "answer",
          parentId: "reply",
          channel: "answer",
          text: long,
          complete: true,
        },
      ],
      terminal: true,
    });
    await f.observe();
    const page = await f.observe("1", 10);
    const pieces = page.events.filter((event) => event.kind === "answer-delta");
    expect(pieces.map((event) => event.text).join("")).toBe(`First\n\n${long}`);
    expect(
      pieces.every((event) => Buffer.byteLength(event.text) <= 65536),
    ).toBe(true);
    expect(new Set(pieces.map((event) => event.segmentId)).size).toBe(
      pieces.length,
    );
    expect(
      pieces.every(
        (event) => event.userTurnId === "user" && event.replyId === "reply",
      ),
    ).toBe(true);
  });
  it("retires only drained settled transient state after host assignment of a strictly newer Go slot generation", async () => {
    const f = fixture();
    await f.start();
    f.setFrame(frame(true));
    await f.observe();
    await f.observe("1", 10);
    const newer = clone(lease);
    newer.slotGeneration = "2";
    f.replaceAssignment({ ...f.assignment(), lease: newer });
    vi.mocked(f.lookup).mockImplementation(() => f.assignment());
    f.prepareInput.lease = newer;
    vi.mocked(f.api.prepare).mockImplementationOnce(async (_input, guard) => {
      expect(guard(saved)).toBe(true);
      const navigated = { ...home, documentGeneration: 2 };
      expect(guard(navigated)).toBe(true);
      return { state: "prepared", binding: navigated, readiness: "ready" };
    });
    expect((await f.prepare()).binding.lease).toEqual(newer);
    expect(f.api.prepare).toHaveBeenCalledTimes(2);
  });
  it("retains the slot fence after an unresolved physical Send even when presented with a newer host assignment", async () => {
    const f = fixture();
    vi.mocked(f.api.send).mockRejectedValue(new Error("unknown"));
    await f.start();
    const newer = clone(lease);
    newer.slotGeneration = "2";
    f.replaceAssignment({ ...f.assignment(), lease: newer });
    vi.mocked(f.lookup).mockImplementation(() => f.assignment());
    f.prepareInput.lease = newer;
    await expect(f.prepare()).rejects.toThrow("slot_fenced");
    expect(f.api.prepare).toHaveBeenCalledTimes(1);
  });
  it("does not reuse a settled route at the same slot generation", async () => {
    const f = fixture();
    await f.start();
    f.setFrame(frame(true));
    await f.observe();
    await f.observe("1", 10);
    const newer = clone(lease);
    newer.identity.turnId = "turn-2";
    f.replaceAssignment({ ...f.assignment(), lease: newer });
    vi.mocked(f.lookup).mockImplementation(() => f.assignment());
    f.prepareInput.lease = newer;
    await expect(f.prepare()).rejects.toThrow("slot_fenced");
  });
  it("does not confirm a missing destroyed WebContents ID through string coercion", async () => {
    const f = fixture();
    await f.prepare();
    vi.mocked(f.api.dispose).mockResolvedValue({
      state: "destroyed",
      view: home,
      destroyedWebContentsId: undefined!,
    });
    expect(
      (await f.driver.dispose({ lease, deadlineMillis: "14000" })).confirmed,
    ).toBe(false);
  });
  it("fences other operations after unconfirmed physical destruction", async () => {
    const f = fixture();
    await f.prepare();
    vi.mocked(f.api.dispose).mockResolvedValue({
      state: "unconfirmed",
      view: home,
      code: "destruction_unknown",
    });
    expect(
      (await f.driver.dispose({ lease, deadlineMillis: "14000" })).confirmed,
    ).toBe(false);
    await expect(f.verify()).rejects.toThrow("observation_fenced");
    expect(f.api.verifySend).not.toHaveBeenCalled();
  });
  it("preserves empty canonical mode and unknown optional mode for a route with no independent control", async () => {
    const f = fixture({ required: { ...required, mode: false } });
    f.prepareInput.target.selection.mode = "";
    f.prepareInput.target.resolution.resolved.mode = "";
    f.prepareInput.target.resolution.requestedMode = "";
    f.setFacts({ ...observed(), modeLabel: unknown() });
    await f.prepare();
    const result = await f.verify();
    expect(result.verification.pinned.mode).toBe("");
    expect(result.verification.observed.mode).toEqual({
      source: "unknown",
      value: "",
      literal: "",
    });
    const call = vi.mocked(f.api.verifySend).mock.calls[0]![0];
    expect(call.selection.controls.modeLabel).toBeNull();
    expect(call.selection.requiredControls.mode).toBe(false);
    expect(call.selection.requiredControls.model).toBe(true);
    await f.send();
  });
  it.each([999, 1001, Number.NaN])(
    "rejects stale, future or invalid physical fact time %s",
    async (time) => {
      const f = fixture();
      const original = vi.mocked(f.api.verifySend).getMockImplementation()!;
      vi.mocked(f.api.verifySend).mockImplementation(async (input, guard) => {
        const result = await original(input, guard);
        if (result.state !== "witnessed")
          throw new Error("strict double invalid");
        return {
          ...result,
          witness: {
            ...result.witness,
            selection: { ...result.witness.selection, observedAtMillis: time },
          },
        };
      });
      await f.prepare();
      await expect(f.verify()).rejects.toThrow("selection_evidence_invalid");
      expect(f.api.send).not.toHaveBeenCalled();
    },
  );
  it("does not use repeated stale frames to qualify semantic stability", async () => {
    const f = fixture();
    await f.start();
    await f.observe();
    f.tick(500);
    const original = vi.mocked(f.api.observe).getMockImplementation()!;
    vi.mocked(f.api.observe).mockImplementation(async (input, guard) => {
      const result = await original(input, guard);
      if (result.state !== "observed") throw new Error("strict double invalid");
      return {
        ...result,
        selection: { ...result.selection, observedAtMillis: 1000 },
      };
    });
    await expect(f.observe("1")).rejects.toThrow("selection_evidence_invalid");
  });
  it("returns only Home accepted in the transition page even when a whole terminal frame fits the limit", async () => {
    const f = fixture();
    await f.start();
    f.setFrame(frame(true));
    const first = await f.observe("0", 10);
    expect(first.events.map((event) => event.kind)).toEqual(["accepted"]);
    const next = await f.observe("1", 10);
    expect(next.events.map((event) => event.kind)).toEqual([
      "commentary",
      "answer-delta",
      "completed",
      "quiescent",
    ]);
    expect(
      next.events.every(
        (event) =>
          event.binding.providerState === "bound" &&
          event.providerConversationId === "",
      ),
    ).toBe(true);
  });
  it("rejects cursors that skip cached but never delivered events", async () => {
    const f = fixture();
    await f.start();
    f.setFrame(frame(true));
    await f.observe();
    await expect(f.observe("5")).rejects.toThrow("cursor_invalid");
    expect(f.api.observe).toHaveBeenCalledTimes(1);
  });
  it("fences physical callbacks synchronously when host lookup is withdrawn", async () => {
    const f = fixture();
    await f.prepare();
    await f.verify();
    vi.mocked(f.api.send).mockImplementation(async (input, guard) => {
      expect(guard(input.binding)).toBe(true);
      f.replaceAssignment(undefined);
      expect(guard(input.binding)).toBe(false);
      return {
        state: "submitted",
        binding: input.binding,
        operationId: input.operationId,
        evidenceId: input.witness.evidenceId,
        code: "submitted",
      };
    });
    expect((await f.send()).status).toBe("unknown");
    await expect(f.observe()).rejects.toThrow("assignment_mismatch");
    expect(f.api.send).toHaveBeenCalledTimes(1);
  });
  it.each(["new-saved", "owned-saved"] as const)(
    "permits one reused settled view navigation from CID-A to %s with a new document epoch",
    async (mode) => {
      const f = fixture();
      await f.start();
      f.setFrame(frame(true));
      await f.observe();
      await f.observe("1", 10);
      const newer = clone(lease);
      newer.slotGeneration = "2";
      f.replaceAssignment({ ...f.assignment(), lease: newer });
      vi.mocked(f.lookup).mockImplementation(() => f.assignment());
      f.prepareInput.lease = newer;
      f.prepareInput.target.mode = mode;
      f.prepareInput.target.conversationId =
        mode === "owned-saved" ? "cid-b" : "";
      const target: PhysicalBinding =
        mode === "owned-saved"
          ? {
              ...saved,
              conversationId: "cid-b",
              url: "https://chatgpt.com/c/cid-b",
              documentGeneration: 2,
            }
          : { ...home, documentGeneration: 2 };
      vi.mocked(f.api.prepare).mockImplementationOnce(async (input, guard) => {
        expect(input.target).toEqual(
          mode === "owned-saved"
            ? { kind: "owned-saved", conversationId: "cid-b" }
            : { kind: "new-saved" },
        );
        expect(guard(saved)).toBe(true);
        expect(guard(target)).toBe(true);
        return { state: "prepared", binding: target, readiness: "ready" };
      });
      const result = await f.prepare();
      expect(result.binding).toMatchObject({
        lease: newer,
        viewId: "view",
        viewGeneration: "1",
        documentGeneration: "2",
        providerState: mode === "new-saved" ? "home" : "bound",
        conversationId: mode === "new-saved" ? "" : "cid-b",
      });
    },
  );
  it.each(["viewId", "viewGeneration", "partition"] as const)(
    "rejects a reused Prepare navigation to a foreign %s",
    async (field) => {
      const f = fixture();
      await f.start();
      f.setFrame(frame(true));
      await f.observe();
      await f.observe("1", 10);
      const newer = clone(lease);
      newer.slotGeneration = "2";
      f.replaceAssignment({ ...f.assignment(), lease: newer });
      vi.mocked(f.lookup).mockImplementation(() => f.assignment());
      f.prepareInput.lease = newer;
      vi.mocked(f.api.prepare).mockImplementationOnce(async (_input, guard) => {
        expect(guard(saved)).toBe(true);
        const foreign = {
          ...home,
          documentGeneration: 2,
          [field]: field === "viewGeneration" ? 2 : "foreign",
        } as PhysicalBinding;
        expect(guard(foreign)).toBe(false);
        // A faulty API ignoring its false guard still cannot publish success.
        return { state: "prepared", binding: foreign, readiness: "ready" };
      });
      await expect(f.prepare()).rejects.toThrow("prepare_binding_unknown");
    },
  );
  it("requires a new Prepare document epoch when the provider URL changes", async () => {
    const f = fixture();
    await f.start();
    f.setFrame(frame(true));
    await f.observe();
    await f.observe("1", 10);
    const newer = clone(lease);
    newer.slotGeneration = "2";
    f.replaceAssignment({ ...f.assignment(), lease: newer });
    vi.mocked(f.lookup).mockImplementation(() => f.assignment());
    f.prepareInput.lease = newer;
    vi.mocked(f.api.prepare).mockImplementationOnce(async (_input, guard) => {
      expect(guard(saved)).toBe(true);
      expect(guard(home)).toBe(false);
      return { state: "prepared", binding: home, readiness: "ready" };
    });
    await expect(f.prepare()).rejects.toThrow("prepare_binding_unknown");
  });
  it("permits the before-navigation CID on a first owned-saved preparation and pins only the final target", async () => {
    const f = fixture({ followup: true });
    vi.mocked(f.api.prepare).mockImplementationOnce(async (_input, guard) => {
      const old = {
        ...saved,
        conversationId: "cid-a",
        url: "https://chatgpt.com/c/cid-a",
      };
      const target = { ...saved, documentGeneration: 2 };
      expect(guard(old)).toBe(true);
      expect(guard(target)).toBe(true);
      return { state: "prepared", binding: target, readiness: "ready" };
    });
    expect((await f.prepare()).binding).toMatchObject({
      conversationId: "cid",
      documentGeneration: "2",
    });
  });

  it("pins the final document in the retained Prepare callback once preparation has settled", async () => {
    const f = fixture();
    let retained: Parameters<ChatGptPhysicalApi["prepare"]>[1] | undefined;
    vi.mocked(f.api.prepare).mockImplementationOnce(async (_input, guard) => {
      retained = guard;
      expect(guard(saved)).toBe(true);
      const target = { ...home, documentGeneration: 2 };
      expect(guard(target)).toBe(true);
      return { state: "prepared", binding: target, readiness: "ready" };
    });
    await f.prepare();
    expect(retained!({ ...home, documentGeneration: 2 })).toBe(true);
    expect(retained!({ ...home, documentGeneration: 3 })).toBe(false);
    expect(retained!(saved)).toBe(false);
  });
  it("does not assign new sequences to unchanged awaiting-owner observations", async () => {
    const f = fixture();
    await f.start();
    vi.mocked(f.api.observe).mockResolvedValue({
      state: "awaiting-owner",
      code: "owner_control_required",
    });
    const signal = await f.observe();
    expect(signal.events[0]).toMatchObject({
      kind: "awaiting-owner",
      sequence: "1",
    });
    expect(await f.observe("0")).toEqual(signal);
    expect(await f.observe("1")).toEqual({ events: [], gap: false });
    expect(await f.observe("1")).toEqual({ events: [], gap: false });
  });
  it("does not retry a physical refusal without exact no-send binding evidence", async () => {
    const f = fixture();
    vi.mocked(f.api.send).mockResolvedValue({
      state: "refused",
      code: "physical_refused",
    });
    expect((await f.start()).status).toBe("unknown");
    await expect(f.send()).rejects.toThrow("send_witness_mismatch");
    expect(f.api.send).toHaveBeenCalledTimes(1);
  });
});

describe("independent account snapshot transport", () => {
  const observedAccount = {
    state: "observed",
    source: "provider-session-v1",
    accountKey: "c".repeat(64),
    observedAtMillis: 1000,
    expiresAtMillis: 60_000,
    documentUrl: home.url,
  } as const;
  function accountFixture(account: unknown = observedAccount) {
    const f = fixture();
    const original = f.api.verifySend;
    f.api.verifySend = vi.fn(async (input, guard) => {
      const result = await original(input, guard);
      if (result.state !== "witnessed")
        throw new Error("missing fixture witness");
      Object.assign(result.witness, { account });
      return result;
    });
    return f;
  }
  it("round trips independent facts while retaining the exact physical witness", async () => {
    const f = accountFixture();
    await f.prepare();
    const { verification } = await f.verify();
    expect(verification.account).toEqual({
      state: "observed",
      source: "provider-session-v1",
      principalKey: observedAccount.accountKey,
      observedAtMillis: "1000",
      expiresAtMillis: "60000",
    });
    expect(verification.pinned.accountId).toBe("account");
    expect(verification.account).not.toHaveProperty("documentUrl");
    expect(validate("BrowserVerification", verification)).toBe(true);
    await expect(f.send()).resolves.toMatchObject({ status: "submitted" });
    expect(vi.mocked(f.api.send).mock.calls[0]?.[0].witness.account).toEqual(
      observedAccount,
    );
    expect(f.api.send).toHaveBeenCalledTimes(1);
  });
  it("does not fabricate an observation from configured account correlation", async () => {
    const f = fixture();
    await f.prepare();
    expect((await f.verify()).verification.account).toBeUndefined();
  });
  it.each([
    null,
    { state: "unavailable", code: "timeout" },
    { ...observedAccount, documentUrl: saved.url },
    { ...observedAccount, observedAtMillis: 999 },
    { ...observedAccount, observedAtMillis: 1001 },
    { ...observedAccount, expiresAtMillis: 1000 },
    { ...observedAccount, accountKey: selection.accountId },
    { ...observedAccount, accessToken: "private-boundary-canary" },
  ])(
    "refuses malformed, unavailable, stale or crossed account facts",
    async (value) => {
      const f = accountFixture(value);
      await f.prepare();
      await expect(f.verify()).rejects.toThrow(
        "chat_browser_account_unavailable",
      );
      expect(f.api.send).not.toHaveBeenCalled();
    },
  );
  it.each(["drop", "principal", "time"])(
    "refuses %s tampering with the returned verification",
    async (kind) => {
      const f = accountFixture();
      await f.prepare();
      const { verification } = await f.verify();
      const changed = clone(verification);
      if (kind === "drop") delete changed.account;
      if (kind === "principal") changed.account!.principalKey = "d".repeat(64);
      if (kind === "time") changed.account!.observedAtMillis = "1001";
      await expect(
        f.driver.send({
          binding: f.binding,
          verification: changed,
          intentDigest: "b".repeat(64),
          prompt: "Transient prompt",
          deadlineMillis: "14000",
        }),
      ).rejects.toThrow("chat_browser_send_witness_mismatch");
      expect(f.api.send).not.toHaveBeenCalled();
    },
  );
});
