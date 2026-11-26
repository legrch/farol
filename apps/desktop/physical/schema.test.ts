import { describe, expect, it } from "vitest";
import {
  bindingSchema,
  idSchema,
  observationSchema,
  policySchema,
  sendSchema,
  verifySchema,
} from "./schema";

const conversationId = "12345678-1234-4123-8123-123456789abc";
const view = {
  viewId: "view-1",
  viewGeneration: 1,
  documentGeneration: 2,
  partition: "persist:farol-dev-chatgpt",
};
const binding = {
  ...view,
  phase: "conversation",
  url: `https://chatgpt.com/c/${conversationId}`,
  conversationId,
};
const controls = {
  modelLabel: "Test model",
  effortLabel: null,
  modeLabel: null,
  connector: { id: "plugin_asdk_app_TEST", label: "Farol DEV" },
};
const requiredControls = {
  model: true,
  effort: false,
  mode: false,
  connector: true,
};
const previous = { userTurnId: "user-1", replyId: "reply-1" };
const verify = {
  binding,
  operationId: "operation-1",
  previous,
  intentDigest: "intent-1",
  controls,
  requiredControls,
};
const fact = { state: "unknown", code: "not-exposed" };
const witness = {
  ...verify,
  evidenceId: "11111111-1111-4111-8111-111111111111",
  observed: {
    modelLabel: { state: "observed", source: "public-dom", value: "Test" },
    effortLabel: fact,
    modeLabel: fact,
    connectorLabel: fact,
  },
  sourceProfile: "message-anchors-v1",
};
const submission = {
  originBinding: binding,
  operationId: "operation-1",
  evidenceId: witness.evidenceId,
  intentDigest: "intent-1",
  promptDigest: "b".repeat(64),
  baselineUserIds: ["user-0"],
  previous,
  controls,
  requiredControls,
};

describe("identifiers and bindings", () => {
  it("refuse empty, oversized and control-character identifiers", () => {
    expect(idSchema.safeParse("ok").success).toBe(true);
    expect(idSchema.safeParse("").success).toBe(false);
    expect(idSchema.safeParse("a".repeat(257)).success).toBe(false);
    expect(idSchema.safeParse("a\nb").success).toBe(false);
    expect(idSchema.safeParse("a\u007fb").success).toBe(false);
  });
  it("accepts a conversation and a home binding only in their own shape", () => {
    expect(bindingSchema.safeParse(binding).success).toBe(true);
    const home = {
      ...view,
      phase: "home",
      url: "https://chatgpt.com/",
      conversationId: null,
    };
    expect(bindingSchema.safeParse(home).success).toBe(true);
    expect(bindingSchema.safeParse({ ...home, conversationId }).success).toBe(
      false,
    );
    expect(
      bindingSchema.safeParse({ ...binding, conversationId: null }).success,
    ).toBe(false);
    expect(
      bindingSchema.safeParse({ ...binding, partition: "persist:other" })
        .success,
    ).toBe(false);
    expect(bindingSchema.safeParse({ ...binding, extra: 1 }).success).toBe(
      false,
    );
  });
});

describe("page policy", () => {
  it("admits only an exact loopback http origin or null", () => {
    for (const e2eOrigin of [null, "http://127.0.0.1:4000", "http://localhost"])
      expect(
        policySchema.safeParse({ e2eOrigin }).success,
        `${e2eOrigin}`,
      ).toBe(true);
    for (const e2eOrigin of [
      "https://127.0.0.1:4000",
      "http://example.com",
      "http://127.0.0.1:4000/",
      "http://user@127.0.0.1:4000",
      "http://127.0.0.1:4000?x=1",
      "not a url",
    ])
      expect(policySchema.safeParse({ e2eOrigin }).success, e2eOrigin).toBe(
        false,
      );
  });
  it("admits the two content profiles and the one account profile", () => {
    expect(
      policySchema.safeParse({
        e2eOrigin: null,
        contentProfile: "farol-controlled-settled-segments-v1",
        accountObservationProfile: "provider-session-v1",
      }).success,
    ).toBe(true);
    expect(
      policySchema.safeParse({ e2eOrigin: null, contentProfile: "other" })
        .success,
    ).toBe(false);
    expect(policySchema.safeParse({}).success).toBe(false);
  });
});

describe("serialized request shapes", () => {
  it("keep the verify fields in their declared order", () => {
    const parsed = verifySchema.parse({
      ...verify,
      accountDeadlineMillis: 5000,
    });
    expect(Object.keys(parsed)).toEqual([
      "binding",
      "operationId",
      "accountDeadlineMillis",
      "previous",
      "intentDigest",
      "controls",
      "requiredControls",
    ]);
    expect(verifySchema.safeParse({ ...verify, extra: 1 }).success).toBe(false);
    expect(
      verifySchema.safeParse({
        ...verify,
        requiredControls: { ...requiredControls, model: false },
      }).success,
    ).toBe(false);
  });
  it("bounds the send prompt and requires a uuid evidence id", () => {
    const send = {
      binding,
      operationId: "operation-1",
      witness,
      intentDigest: "intent-1",
      prompt: "hello",
    };
    expect(sendSchema.safeParse(send).success).toBe(true);
    expect(sendSchema.safeParse({ ...send, prompt: "" }).success).toBe(false);
    expect(
      sendSchema.safeParse({ ...send, prompt: "x".repeat(64 * 1024 + 1) })
        .success,
    ).toBe(false);
    expect(
      sendSchema.safeParse({
        ...send,
        witness: { ...witness, evidenceId: "not-a-uuid" },
      }).success,
    ).toBe(false);
  });
  it("bounds the observation submission", () => {
    const observation = {
      binding,
      operationId: "operation-1",
      submission,
      correlation: { userTurnId: null, replyId: null },
    };
    expect(observationSchema.safeParse(observation).success).toBe(true);
    expect(
      observationSchema.safeParse({
        ...observation,
        submission: { ...submission, promptDigest: "short" },
      }).success,
    ).toBe(false);
    expect(
      observationSchema.safeParse({
        ...observation,
        submission: {
          ...submission,
          baselineUserIds: Array.from({ length: 513 }, (_, i) => `u${i}`),
        },
      }).success,
    ).toBe(false);
  });
});
