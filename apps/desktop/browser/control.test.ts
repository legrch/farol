import { describe, expect, it } from "vitest";
import type { BrowserTarget } from "../bridge/wire.ts";
import type {
  PhysicalObservedSelection,
  PhysicalSelection,
  PhysicalSelectionEvidence,
} from "../chatgpt-physical-api.ts";
import {
  facts,
  label,
  pin,
  qualify,
  type QualifiedControlTranslation,
} from "./control.ts";

const sha = "a".repeat(64);
const translation: QualifiedControlTranslation = {
  version: "public-controls-v1",
  configSHA256: sha,
  translationId: "controls-v1",
  model: [{ value: "chatgpt", literal: "GPT" }],
  effort: [{ value: "high", literal: "High" }],
  mode: [{ value: "chat", literal: "Chat" }],
  connector: [{ value: "farol", literal: "Farol" }],
};
const selection = {
  provider: "farol",
  alias: "chatgpt",
  accountId: "acct",
  modelId: "chatgpt",
  effort: "high",
  mode: "chat",
  connectorId: "farol",
  connectorGrantId: "grant",
  toolsEnabled: true,
};
const target: BrowserTarget = {
  mode: "new-saved",
  conversationId: "",
  previousUserTurnId: "",
  previousReplyId: "",
  selection,
  resolution: {
    requestedAlias: "chatgpt",
    requestedExecutor: "farol",
    requestedEffort: "high",
    requestedMode: "chat",
    resolved: selection,
    configSHA256: sha,
    translationId: "controls-v1",
  },
  required: { model: true, effort: true, mode: false, connector: true },
};
const refused = (run: () => unknown, code: string) =>
  expect(run).toThrow(expect.objectContaining({ code }));

describe("browser control translation", () => {
  it("accepts a qualified table and refuses malformed or ambiguous ones", () => {
    expect(() => qualify([translation])).not.toThrow();
    for (const bad of [
      { ...translation, version: "v0" as never },
      { ...translation, configSHA256: "XYZ" },
      { ...translation, translationId: "" },
      {
        ...translation,
        model: [...translation.model, { value: "chatgpt", literal: "Other" }],
      },
      {
        ...translation,
        model: [...translation.model, { value: "other", literal: "GPT" }],
      },
      { ...translation, mode: [{ value: "chat", literal: " " }] },
    ])
      refused(() => qualify([bad]), "chat_browser_translation_unqualified");
    refused(
      () => qualify([translation, translation]),
      "chat_browser_translation_unqualified",
    );
  });

  it("looks a label up by value and reports a miss as null", () => {
    expect(label(translation, "model", "chatgpt")).toBe("GPT");
    expect(label(translation, "model", "nope")).toBeNull();
  });

  it("pins the declared selection with host labels and required controls", () => {
    const pinned = pin(target, translation);
    expect(pinned.requested).toEqual(selection);
    expect(pinned.admitted).not.toBe(pinned.requested);
    expect(pinned.controls).toEqual({
      modelLabel: "GPT",
      effortLabel: "High",
      modeLabel: "Chat",
      connector: { id: "farol", label: "Farol" },
    });
    expect(pinned.requiredControls).toEqual({
      model: true,
      effort: true,
      mode: false,
      connector: true,
    });
  });

  it("refuses an unpinned scope or a missing required translation", () => {
    refused(
      () =>
        pin(
          { ...target, selection: { ...selection, effort: "low" } },
          translation,
        ),
      "chat_browser_pinned_scope_mismatch",
    );
    refused(
      () =>
        pin(
          { ...target, required: { ...target.required, model: false } },
          translation,
        ),
      "chat_browser_pinned_scope_mismatch",
    );
    refused(
      () => pin(target, { ...translation, model: [] }),
      "chat_browser_model_translation_missing",
    );
    refused(
      () => pin(target, { ...translation, effort: [] }),
      "chat_browser_required_translation_missing",
    );
    expect(
      pin(target, { ...translation, mode: [] }).controls.modeLabel,
    ).toBeNull();
  });

  describe("facts", () => {
    const declared: PhysicalSelection = pin(target, translation);
    const observed = (
      patch: Partial<PhysicalObservedSelection> = {},
    ): PhysicalObservedSelection => ({
      modelLabel: { state: "observed", source: "public-dom", value: "GPT" },
      effortLabel: { state: "observed", source: "public-dom", value: "High" },
      modeLabel: { state: "unknown", code: "not-exposed" },
      connectorLabel: {
        state: "observed",
        source: "public-dom",
        value: "Farol",
      },
      ...patch,
    });
    const evidence = (
      patch: Partial<PhysicalSelectionEvidence> = {},
    ): PhysicalSelectionEvidence => ({
      declared,
      observed: observed(),
      observedAtMillis: 150,
      sourceProfile: "message-anchors-v1",
      ...patch,
    });
    const run = (e: PhysicalSelectionEvidence, now = 200) =>
      facts(translation, declared, e, target.required, 100, () => now);

    it("translates observed literals and keeps unexposed controls unknown", () => {
      expect(run(evidence())).toEqual({
        model: { source: "public-control", value: "chatgpt", literal: "GPT" },
        effort: { source: "public-control", value: "high", literal: "High" },
        mode: { source: "unknown", value: "", literal: "" },
        connector: {
          source: "public-control",
          value: "farol",
          literal: "Farol",
        },
        observedAtMillis: "150",
      });
    });

    it("refuses evidence that is stale, future or from another declaration", () => {
      for (const bad of [
        evidence({ observedAtMillis: 99 }),
        evidence({ observedAtMillis: 201 }),
        evidence({ sourceProfile: "other" as never }),
        evidence({
          declared: {
            ...declared,
            controls: { ...declared.controls, modelLabel: "x" },
          },
        }),
      ])
        refused(() => run(bad), "chat_browser_selection_evidence_invalid");
    });

    it("refuses an unknown required control and a mistranslated literal", () => {
      refused(
        () =>
          run(
            evidence({
              observed: observed({
                effortLabel: { state: "unknown", code: "not-exposed" },
              }),
            }),
          ),
        "chat_browser_required_control_unknown",
      );
      refused(
        () =>
          run(
            evidence({
              observed: observed({
                modelLabel: {
                  state: "observed",
                  source: "public-dom",
                  value: "Other",
                },
              }),
            }),
          ),
        "chat_browser_control_translation_mismatch",
      );
    });
  });
});
