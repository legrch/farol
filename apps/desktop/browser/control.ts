import { isDeepStrictEqual } from "node:util";
import type {
  BrowserControlFact,
  BrowserTarget,
  BrowserRequiredControls,
  BrowserSelectionFacts,
} from "../bridge/wire.ts";
import type {
  PhysicalSelection,
  PhysicalSelectionEvidence,
} from "../chatgpt-physical-api.ts";
import { fail, validControlLiteral, validId } from "./check.ts";

export const controls = ["model", "effort", "mode", "connector"] as const;
export type ControlTranslation = Readonly<{ value: string; literal: string }>;
// Host configuration, never inferred from a requested model or a DOM label.
export type QualifiedControlTranslation = Readonly<{
  version: "public-controls-v1";
  configSHA256: string;
  translationId: string;
  model: readonly ControlTranslation[];
  effort: readonly ControlTranslation[];
  mode: readonly ControlTranslation[];
  connector: readonly ControlTranslation[];
}>;

/** Refuse a host translation table that is not exactly qualified. */
export function qualify(translations: readonly QualifiedControlTranslation[]) {
  const keys = new Set<string>();
  for (const t of translations) {
    const k = `${t.configSHA256}/${t.translationId}`;
    if (
      t.version !== "public-controls-v1" ||
      !/^[a-f0-9]{64}$/.test(t.configSHA256) ||
      !validId(t.translationId) ||
      keys.has(k)
    )
      fail("chat_browser_translation_unqualified");
    keys.add(k);
    for (const field of controls) {
      const rows = t[field];
      if (!Array.isArray(rows) || rows.length > 128)
        fail("chat_browser_translation_unqualified");
      const values = new Set<string>(),
        literals = new Set<string>();
      for (const row of rows) {
        if (
          !row ||
          !validId(row.value) ||
          row.value.length > 120 ||
          !validControlLiteral(row.literal) ||
          values.has(row.value) ||
          literals.has(row.literal)
        )
          fail("chat_browser_translation_unqualified");
        values.add(row.value);
        literals.add(row.literal);
      }
    }
  }
}

export function label(
  t: QualifiedControlTranslation,
  field: (typeof controls)[number],
  value: string,
): string | null {
  return t[field].find((row) => row.value === value)?.literal ?? null;
}

/** The pinned, host-translated selection a Prepare may drive. */
export function pin(
  target: BrowserTarget,
  t: QualifiedControlTranslation,
): PhysicalSelection {
  const selection = target.selection,
    resolution = target.resolution;
  if (
    !isDeepStrictEqual(selection, resolution.resolved) ||
    !target.required.model
  )
    fail("chat_browser_pinned_scope_mismatch");
  const modelLabel = label(t, "model", selection.modelId);
  if (!modelLabel) fail("chat_browser_model_translation_missing");
  for (const field of controls) {
    const value =
      field === "model"
        ? selection.modelId
        : field === "connector"
          ? selection.connectorId
          : selection[field];
    if (target.required[field] && !label(t, field, value))
      fail("chat_browser_required_translation_missing");
  }
  const connectorLabel = label(t, "connector", selection.connectorId);
  return {
    requested: structuredClone(selection),
    admitted: structuredClone(selection),
    resolved: {
      selection: structuredClone(resolution.resolved),
      configSHA256: resolution.configSHA256,
      translationId: resolution.translationId,
    },
    controls: {
      modelLabel,
      effortLabel: label(t, "effort", selection.effort),
      modeLabel: label(t, "mode", selection.mode),
      connector: connectorLabel
        ? { id: selection.connectorId, label: connectorLabel }
        : null,
    },
    requiredControls: {
      ...structuredClone(target.required),
      model: true,
    },
  };
}

function unknownFact(): BrowserControlFact {
  return { source: "unknown", value: "", literal: "" };
}

/** Translate the physical selection evidence into wire facts for one Send. */
export function facts(
  translation: QualifiedControlTranslation,
  selection: PhysicalSelection,
  evidence: PhysicalSelectionEvidence,
  required: BrowserRequiredControls,
  startedAt: number,
  now: () => number,
): BrowserSelectionFacts {
  if (
    !evidence ||
    evidence.sourceProfile !== "message-anchors-v1" ||
    !isDeepStrictEqual(evidence.declared, selection) ||
    !evidence.observed ||
    !Number.isSafeInteger(evidence.observedAtMillis) ||
    evidence.observedAtMillis < startedAt ||
    evidence.observedAtMillis > now()
  )
    fail("chat_browser_selection_evidence_invalid");
  const observed = evidence.observed;
  const result = {
    model: unknownFact(),
    effort: unknownFact(),
    mode: unknownFact(),
    connector: unknownFact(),
    observedAtMillis: String(evidence.observedAtMillis),
  };
  for (const field of controls) {
    const f =
      field === "model"
        ? observed.modelLabel
        : field === "effort"
          ? observed.effortLabel
          : field === "connector"
            ? observed.connectorLabel
            : observed.modeLabel;
    if (!f) fail("chat_browser_selection_fact_invalid");
    if (f.state === "unknown") {
      if (!["not-exposed", "unqualified"].includes(f.code) || required[field])
        fail("chat_browser_required_control_unknown");
      continue;
    }
    if (
      f.state !== "observed" ||
      f.source !== "public-dom" ||
      typeof f.value !== "string"
    )
      fail("chat_browser_selection_fact_invalid");
    const row = translation[field].find((row) => row.literal === f.value);
    const expected =
      field === "model"
        ? selection.admitted.modelId
        : field === "connector"
          ? selection.admitted.connectorId
          : selection.admitted[field];
    if (!row || row.value !== expected)
      fail("chat_browser_control_translation_mismatch");
    result[field] = {
      source: "public-control",
      value: row.value,
      literal: f.value,
    };
  }
  return result;
}
