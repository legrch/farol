import { describe, expect, it } from "vitest";

import { ownerComputerConsentDigest } from "../../../src/modules/computer/infra/repo/owner-computer-consent";
import { defaultSettings } from "../../../src/apps/desktop/settings/rules";
import {
  ProductSettingsSchema,
  type ProductSettings,
} from "../../../src/pkg/product-settings/contract";
import {
  originalStopAdmissible,
  originalStopCandidate as candidateOf,
  originalStopPlan,
  originalStopReadbackMatches as readbackMatches,
  originalStopReceipt,
  originalStopSelectionRefusal as selectionRefusal,
  settingsDocumentDigest,
  type OriginalStopSelection,
} from "./stop";

const uuid = "12345678-1234-4234-8234-123456789abc";
const other = "22345678-1234-4234-8234-123456789abc";
const effect = "11111111-1111-4111-8111-111111111111";
const sha = (character: string) => character.repeat(64);
const NOW = "2026-11-26T10:00:00.000Z";

type Connector = ProductSettings["connectors"]["secureMcp"];
type Connect = ProductSettings["setup"]["connect"];

const base = (): ProductSettings => defaultSettings(() => uuid);

function withConnector(
  settings: ProductSettings,
  connector: Partial<Connector> = {},
  connect: Partial<Connect> = {},
): ProductSettings {
  return ProductSettingsSchema.parse({
    ...settings,
    connectors: {
      ...settings.connectors,
      secureMcp: { ...settings.connectors.secureMcp, ...connector },
    },
    setup: {
      ...settings.setup,
      connect: { ...settings.setup.connect, ...connect },
    },
  });
}

const runtimeRecord = (overrides: Record<string, unknown> = {}) => ({
  state: "ready" as const,
  connectorGeneration: 2,
  runtimeGeneration: sha("1"),
  computerGeneration: 1,
  buildId: sha("2"),
  observedAt: NOW,
  ...overrides,
});

const challengeRecord = () => ({
  value: other,
  challengeSha256: sha("4"),
  runtimeGeneration: sha("1"),
  computerGeneration: 1,
  buildId: sha("2"),
  preparedAt: NOW,
});

// Settings with a connected runtime: the state an original stop acts on.
const connected = (): ProductSettings =>
  withConnector(
    base(),
    { generation: 2, runtime: runtimeRecord(), challenge: challengeRecord() },
    { outcomeUnknown: false, needsAction: null },
  );

const selectionFor = (
  settings: ProductSettings,
  overrides: Partial<OriginalStopSelection> = {},
): OriginalStopSelection => ({
  effectId: effect,
  expectedRevision: settings.revision,
  expectedDigest: settingsDocumentDigest(settings),
  computerGeneration: settings.computer.generation,
  connectorGeneration: settings.connectors.secureMcp.generation,
  consentDigest: ownerComputerConsentDigest(settings),
  ...overrides,
});

const callback = () => undefined;

// The service passes the Computer module's owner-consent digest in.
const originalStopSelectionRefusal = (
  settings: ProductSettings,
  selection: OriginalStopSelection,
) => selectionRefusal(settings, selection, ownerComputerConsentDigest);
const originalStopCandidate = (
  settings: ProductSettings,
  selection: OriginalStopSelection,
) => candidateOf(settings, selection, ownerComputerConsentDigest);
const originalStopReadbackMatches = (
  readback: ProductSettings,
  candidate: ProductSettings,
  plan: ReturnType<typeof originalStopPlan>,
  selection: OriginalStopSelection,
) =>
  readbackMatches(
    readback,
    candidate,
    plan,
    selection,
    ownerComputerConsentDigest,
  );

describe("originalStopAdmissible", () => {
  it("admits loaded, unfenced settings with both callbacks", () => {
    expect(originalStopAdmissible(connected(), false, callback, callback)).toBe(
      true,
    );
  });

  it.each<[string, ProductSettings | null, boolean, unknown, unknown]>([
    ["no settings loaded", null, false, callback, callback],
    ["a fenced delivery", connected(), true, callback, callback],
    ["no intent callback", connected(), false, undefined, callback],
    ["a non-function intent callback", connected(), false, "admit", callback],
    ["no currentness callback", connected(), false, callback, undefined],
    ["a non-function currentness callback", connected(), false, callback, {}],
  ])("refuses %s", (_, settings, fenced, admit, current) => {
    expect(originalStopAdmissible(settings, fenced, admit, current)).toBe(
      false,
    );
  });

  it("keeps a runtime whose outcome is unknown refused", () => {
    const settings = withConnector(base(), {
      generation: 2,
      runtime: runtimeRecord({ state: "outcome_unknown" }),
      challenge: challengeRecord(),
    });
    expect(originalStopAdmissible(settings, false, callback, callback)).toBe(
      false,
    );
  });

  it("keeps an unknown connect outcome refused unless it is a pending app check", () => {
    const unknown = withConnector(connected(), {}, { outcomeUnknown: true });
    expect(originalStopAdmissible(unknown, false, callback, callback)).toBe(
      false,
    );
    const pendingApp = withConnector(
      connected(),
      { appVerificationPending: true },
      { outcomeUnknown: true },
    );
    expect(originalStopAdmissible(pendingApp, false, callback, callback)).toBe(
      true,
    );
  });

  it("never calls either callback", () => {
    let calls = 0;
    const counted = () => {
      calls += 1;
    };
    originalStopAdmissible(connected(), false, counted, counted);
    expect(calls).toBe(0);
  });
});

describe("originalStopSelectionRefusal", () => {
  it("accepts a selection that names these exact settings", () => {
    const settings = connected();
    expect(
      originalStopSelectionRefusal(settings, selectionFor(settings)),
    ).toBeNull();
  });

  it.each<[string, Partial<OriginalStopSelection>]>([
    ["a fractional revision", { expectedRevision: 1.5 }],
    ["an unsafe revision", { expectedRevision: Number.MAX_SAFE_INTEGER + 1 }],
    ["a short document digest", { expectedDigest: "abc" }],
    ["an upper-case document digest", { expectedDigest: sha("A") }],
    ["a non-hex consent digest", { consentDigest: sha("g") }],
    ["an empty consent digest", { consentDigest: "" }],
  ])("refuses %s as an invalid selection", (_, overrides) => {
    const settings = connected();
    expect(
      originalStopSelectionRefusal(settings, selectionFor(settings, overrides)),
    ).toBe("selection_invalid");
  });

  it.each<[string, (s: ProductSettings) => Partial<OriginalStopSelection>]>([
    ["a stale revision", (s) => ({ expectedRevision: s.revision - 1 })],
    [
      "a stale Computer generation",
      (s) => ({ computerGeneration: s.computer.generation + 1 }),
    ],
    [
      "a stale connector generation",
      (s) => ({
        connectorGeneration: s.connectors.secureMcp.generation + 1,
      }),
    ],
  ])("refuses %s", (_, overrides) => {
    const settings = connected();
    expect(
      originalStopSelectionRefusal(
        settings,
        selectionFor(settings, overrides(settings)),
      ),
    ).toBe("selection_stale");
  });

  it("refuses a document digest of other bytes", () => {
    const settings = connected();
    expect(
      originalStopSelectionRefusal(
        settings,
        selectionFor(settings, { expectedDigest: sha("e") }),
      ),
    ).toBe("digest_mismatch");
  });

  it("refuses an owner-consent digest of other limits", () => {
    const settings = connected();
    expect(
      originalStopSelectionRefusal(
        settings,
        selectionFor(settings, { consentDigest: sha("f") }),
      ),
    ).toBe("digest_mismatch");
  });

  it("refuses a selection taken from the prior revision after settings moved", () => {
    const prior = connected();
    const moved = { ...prior, revision: prior.revision + 1 };
    expect(originalStopSelectionRefusal(moved, selectionFor(prior))).toBe(
      "selection_stale",
    );
  });
});

describe("originalStopCandidate", () => {
  it("drops the runtime, challenge and attachment and advances the revision", () => {
    const settings = connected();
    const before = structuredClone(settings);
    const result = originalStopCandidate(settings, selectionFor(settings));
    expect(result.status).toBe("candidate");
    if (result.status !== "candidate") return;
    const next = result.settings;
    expect(next.revision).toBe(settings.revision + 1);
    expect(next.connectors.secureMcp.runtime).toBeNull();
    expect(next.connectors.secureMcp.challenge).toBeNull();
    expect(next.connectors.secureMcp.attachment).toBeNull();
    expect(next.setup.connect.unavailable).toBeNull();
    expect(next.connectors.secureMcp.generation).toBe(
      settings.connectors.secureMcp.generation,
    );
    expect(next.computer).toEqual(settings.computer);
    expect(ownerComputerConsentDigest(next)).toBe(
      ownerComputerConsentDigest(settings),
    );
    ProductSettingsSchema.parse(next);
    // The caller's settings are never mutated.
    expect(settings).toEqual(before);
  });

  it("stops a connector that holds only a challenge", () => {
    const settings = withConnector(connected(), { runtime: null });
    const result = originalStopCandidate(settings, selectionFor(settings));
    expect(result.status).toBe("candidate");
  });

  it("refuses when there is nothing to stop", () => {
    const settings = withConnector(connected(), {
      runtime: null,
      challenge: null,
      attachment: null,
    });
    expect(originalStopCandidate(settings, selectionFor(settings))).toEqual({
      status: "refused",
      reason: "nothing_to_stop",
    });
  });

  it("refuses a candidate the schema does not accept", () => {
    const settings = { ...connected(), general: null } as never;
    expect(originalStopCandidate(settings, selectionFor(connected()))).toEqual({
      status: "refused",
      reason: "candidate_invalid",
    });
  });

  it("refuses a candidate whose owner consent no longer matches the selection", () => {
    const settings = connected();
    expect(
      originalStopCandidate(
        settings,
        selectionFor(settings, { consentDigest: sha("f") }),
      ),
    ).toEqual({ status: "refused", reason: "consent_changed" });
  });
});

describe("originalStopPlan and originalStopReceipt", () => {
  it("binds the original and next documents and the selection into the plan", () => {
    const settings = connected();
    const selection = selectionFor(settings);
    const result = originalStopCandidate(settings, selection);
    if (result.status !== "candidate") throw new Error("candidate expected");
    const plan = originalStopPlan(settings, result.settings, selection);
    expect(plan).toEqual({
      effectId: effect,
      expectedRevision: String(settings.revision),
      expectedDigest: selection.expectedDigest,
      nextRevision: String(settings.revision + 1),
      nextDigest: settingsDocumentDigest(result.settings),
      computerGeneration: String(settings.computer.generation),
      connectorGeneration: String(settings.connectors.secureMcp.generation),
      consentDigest: selection.consentDigest,
    });
  });

  it("certifies exactly the admitted plan, field for field", () => {
    const plan = {
      effectId: effect,
      expectedRevision: "3",
      expectedDigest: sha("a"),
      nextRevision: "4",
      nextDigest: sha("b"),
      computerGeneration: "1",
      connectorGeneration: "2",
      consentDigest: sha("c"),
    };
    expect(originalStopReceipt(plan)).toEqual({
      effectId: effect,
      revision: "4",
      documentDigest: sha("b"),
      computerGeneration: "1",
      connectorGeneration: "2",
      consentDigest: sha("c"),
    });
  });
});

describe("originalStopReadbackMatches", () => {
  function admitted() {
    const settings = connected();
    const selection = selectionFor(settings);
    const result = originalStopCandidate(settings, selection);
    if (result.status !== "candidate") throw new Error("candidate expected");
    const plan = originalStopPlan(settings, result.settings, selection);
    return { candidate: result.settings, plan, selection };
  }

  it("accepts the exact admitted candidate read back", () => {
    const { candidate, plan, selection } = admitted();
    expect(
      originalStopReadbackMatches(
        structuredClone(candidate),
        candidate,
        plan,
        selection,
      ),
    ).toBe(true);
  });

  it("does not accept other bytes, so the service answers UNKNOWN", () => {
    const { candidate, plan, selection } = admitted();
    const crossed = structuredClone(candidate);
    crossed.general = { ...crossed.general, launchAtLogin: true } as never;
    expect(
      originalStopReadbackMatches(crossed, candidate, plan, selection),
    ).toBe(false);
  });

  it("does not accept a crossed owner-consent policy", () => {
    const { candidate, plan, selection } = admitted();
    const crossed = structuredClone(candidate);
    crossed.computer.commands =
      crossed.computer.commands === "none" ? "verification" : "none";
    expect(
      originalStopReadbackMatches(crossed, candidate, plan, selection),
    ).toBe(false);
  });

  it("does not accept a revision other than the candidate's", () => {
    const { candidate, selection } = admitted();
    const readback = { ...structuredClone(candidate) };
    const shifted = { ...candidate, revision: candidate.revision + 1 };
    // The plan binds the readback bytes, so only the revision check can refuse.
    const plan = originalStopPlan(connected(), readback, selection);
    expect(
      originalStopReadbackMatches(readback, shifted, plan, selection),
    ).toBe(false);
  });

  it("does not accept a readback of the original bytes", () => {
    const { candidate, plan, selection } = admitted();
    expect(
      originalStopReadbackMatches(connected(), candidate, plan, selection),
    ).toBe(false);
  });
});
