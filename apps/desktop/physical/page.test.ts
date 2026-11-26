import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  PhysicalBinding,
  PhysicalDeclaration,
  PhysicalWitness,
} from "../chatgpt-physical-api";
import {
  physicalCancelScript,
  physicalObserveScript,
  physicalPrepareProbeScript,
  physicalSendScript,
  physicalVerifySendScript,
  type PhysicalPageObservation,
  type PhysicalPageSelection,
} from "../../../src/apps/desktop/chatgpt-physical-page-scripts";
import { physicalPage } from "./page";

// The generated page scripts are evaluated inside the provider page, so moving
// their source between modules must not change one byte. These digests were
// taken from the builders before the page function left its original module.
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const conversationId = "12345678-1234-4123-8123-123456789abc";
const binding: PhysicalBinding = {
  viewId: "view-1",
  viewGeneration: 1,
  documentGeneration: 2,
  partition: "persist:farol-dev-chatgpt",
  phase: "conversation",
  url: `https://chatgpt.com/c/${conversationId}`,
  conversationId,
};
const declaration: PhysicalDeclaration = {
  provider: "farol",
  alias: "chatgpt",
  accountId: "declared-account",
  modelId: "declared-model",
  effort: "declared-effort",
  mode: "declared-mode",
  connectorId: "declared-connector",
  connectorGrantId: "declared-grant",
  toolsEnabled: true,
};
const selection: PhysicalPageSelection = {
  requested: declaration,
  admitted: declaration,
  resolved: {
    selection: declaration,
    configSHA256: "a".repeat(64),
    translationId: "translation",
  },
  controls: {
    modelLabel: "Test model",
    effortLabel: "Light",
    modeLabel: null,
    connector: { id: "plugin_asdk_app_TEST", label: "Farol DEV" },
  },
  requiredControls: { model: true, effort: true, mode: false, connector: true },
};
const previous = { userTurnId: "user-1", replyId: "reply-1" };
const evidenceId = "11111111-1111-4111-8111-111111111111";
const witness: PhysicalWitness = {
  operationId: "operation-1",
  binding,
  deadlineMillis: 5000,
  evidenceId,
  intentDigest: "intent-1",
  previous,
  selection: {
    declared: selection,
    observed: {
      modelLabel: { state: "observed", source: "public-dom", value: "Test" },
      effortLabel: { state: "unknown", code: "not-exposed" },
      modeLabel: { state: "unknown", code: "unqualified" },
      connectorLabel: { state: "unknown", code: "not-exposed" },
    },
    observedAtMillis: 1,
    sourceProfile: "message-anchors-v1",
  },
};
const submission: PhysicalPageObservation["submission"] = {
  originBinding: binding,
  operationId: "operation-1",
  evidenceId,
  intentDigest: "intent-1",
  promptDigest: "b".repeat(64),
  baselineUserIds: ["user-0"],
  previous,
  selection,
};
const observation: PhysicalPageObservation = {
  binding,
  operationId: "operation-1",
  deadlineMillis: 5000,
  submission,
  correlation: { userTurnId: null, replyId: null },
};
const accountPolicy = {
  e2eOrigin: "http://127.0.0.1:4000",
  accountObservationProfile: "provider-session-v1",
  contentProfile: "farol-controlled-settled-segments-v1",
} as const;

const verifyInput = {
  binding,
  operationId: "operation-1",
  deadlineMillis: 5000,
  previous,
  intentDigest: "intent-1",
  selection,
};
const sendInput = {
  binding,
  operationId: "operation-1",
  deadlineMillis: 5000,
  witness,
  intentDigest: "intent-1",
  prompt: "hello",
};
const segments = "farol-controlled-settled-segments-v1";
const scripts: Readonly<Record<string, string>> = {
  prepare: physicalPrepareProbeScript(binding),
  prepareAccount: physicalPrepareProbeScript(binding, accountPolicy),
  verify: physicalVerifySendScript(verifyInput),
  verifyAccount: physicalVerifySendScript(verifyInput, accountPolicy),
  send: physicalSendScript(sendInput),
  sendAccount: physicalSendScript(sendInput, accountPolicy),
  observe: physicalObserveScript(observation),
  observeSegments: physicalObserveScript(observation, segments),
  cancel: physicalCancelScript(observation),
  cancelAccount: physicalCancelScript(observation, undefined, accountPolicy),
};

describe("physical page script text", () => {
  it("builds executable scripts rather than refusals for the fixtures", () => {
    for (const [name, script] of Object.entries(scripts)) {
      expect(script, name).toMatch(/^\(async function physicalPage|^\(\(/u);
      expect(script, name).not.toContain("PHYSICAL_INPUT_INVALID");
      expect(script, name).not.toContain("PHYSICAL_POLICY_INVALID");
    }
  });
  it("serializes the exported page function verbatim", () => {
    for (const [name, script] of Object.entries(scripts))
      expect(script.startsWith(`(${physicalPage.toString()})(`), name).toBe(
        true,
      );
  });
  it("keeps every generated script byte-identical", () => {
    expect(
      Object.fromEntries(
        Object.entries(scripts).map(([name, script]) => [
          name,
          `${script.length}:${digest(script)}`,
        ]),
      ),
    ).toEqual({
      cancel:
        "49012:f57ec53808b83245d2b6623f7390d6db6d6148c3302c882ad812a8fead2aa4ff",
      cancelAccount:
        "58151:18d6910826c7f9725a5122df42191016367de7906f03a360745275de816d4e96",
      observe:
        "49013:83d909a9981a30f1b980313fb4dfbbcc7da2657cdfde391d3e76249844df7888",
      observeSegments:
        "49049:cdca64b4fb6aa815b25ed8d1e27ef8e13ad6094be90854de8291563b53b37210",
      prepare:
        "48119:7921a92f85bc17bb4f527c384895a1b914e9022bb7b41c6209468895f9107c12",
      prepareAccount:
        "57240:b676a1ec6b51a0b860f012b1c6282c6b76065eeec686bf2cee5b080e10123683",
      send: "49133:e5f1c423f739f01252ab2237818068b0748a39b1f0a39b5b6b107c427873c7d2",
      sendAccount:
        "58283:0ddb24d259be67d156a49a68fd366abaee1fde1996aba825f842bb4b1907bdba",
      verify:
        "48455:d155da7dfede020d9a7b4e64e74114cbfd83a63e8dbbb947eca3f23701d8c09c",
      verifyAccount:
        "57605:d7a42e615252c550afaed07f68dcf778db6dacb89c69e16b0f287cc67abc99b8",
    });
  });
});
