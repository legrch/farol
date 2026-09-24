import { describe, expect, it } from "vitest";
import { validateChatGptModelBeforeSend } from "../../src/apps/desktop/chatgpt-model-observation";

// Synthetic catalogue and public controls; no provider/DOM qualification.
function fixture() {
  const binding = {
    taskId: "task-a",
    conversationId: "conversation-a",
    documentGeneration: 3,
    buildId: "fixture-build",
  };
  return {
    current: { ...binding },
    requested: {
      binding: { ...binding },
      model: "fixture-model",
      effort: "deep",
    },
    observed: {
      binding: { ...binding },
      modelValues: ["Fixture Model"],
      effortValues: ["Deep"],
      observedAtMs: 1_000,
    },
    nowMs: 1_010,
    maxAgeMs: 100,
    catalogue: [
      {
        model: "fixture-model",
        aliases: ["fixture-alias"],
        publicValues: ["Fixture Model", "Fixture Model (supported label)"],
        efforts: [
          { effort: "deep", aliases: ["careful"], publicValues: ["Deep"] },
          { effort: "quick", aliases: [], publicValues: ["Quick"] },
        ],
      },
      {
        model: "other-fixture-model",
        aliases: [],
        publicValues: ["Other Fixture Model"],
        efforts: [{ effort: "deep", aliases: [], publicValues: ["Deep"] }],
      },
    ],
  };
}

function rejected(candidate: unknown, code: string) {
  expect(validateChatGptModelBeforeSend(candidate)).toEqual({
    ok: false,
    code: `CHATGPT_MODEL_${code}`,
  });
}

describe("ChatGPT model before-send validation (pure fixtures)", () => {
  it("returns separately bound requested and literal observed selections", () => {
    const input = fixture();
    expect(validateChatGptModelBeforeSend(input)).toEqual({
      ok: true,
      evidence: {
        requested: input.requested,
        observed: {
          binding: input.observed.binding,
          model: "Fixture Model",
          effort: "Deep",
          observedAtMs: 1_000,
        },
        validatedAtMs: 1_010,
      },
    });
  });

  it("accepts only supplied aliases and preserves their literal read-back", () => {
    const input = fixture();
    input.requested.model = "fixture-alias";
    input.requested.effort = "careful";
    input.observed.modelValues = ["Fixture Model (supported label)"];
    expect(validateChatGptModelBeforeSend(input)).toMatchObject({
      ok: true,
      evidence: {
        requested: { model: "fixture-alias", effort: "careful" },
        observed: { model: "Fixture Model (supported label)", effort: "Deep" },
      },
    });
  });

  it.each(["Other Fixture Model", "Fixture Model"])(
    "rejects mismatched model/effort: %s",
    (model) => {
      const input = fixture();
      input.observed.modelValues = [model];
      if (model === "Fixture Model") input.observed.effortValues = ["Quick"];
      rejected(input, "SELECTION_MISMATCH");
    },
  );

  for (const source of ["requested", "observed"] as const) {
    it.each([
      "taskId",
      "conversationId",
      "documentGeneration",
      "buildId",
    ] as const)(`rejects stale ${source} %s`, (key) => {
      const input = fixture();
      if (key === "documentGeneration") input[source].binding[key] = 2;
      else input[source].binding[key] = "stale";
      rejected(input, "BINDING_STALE");
    });
  }

  it.each([899, 1_011])(
    "rejects expired or future observations: %s",
    (time) => {
      const input = fixture();
      input.observed.observedAtMs = time;
      rejected(input, "OBSERVATION_STALE");
    },
  );

  it("accepts the explicit freshness boundary", () => {
    const input = fixture();
    input.observed.observedAtMs = 910;
    expect(validateChatGptModelBeforeSend(input)).toMatchObject({ ok: true });
    input.observed.observedAtMs = 909;
    rejected(input, "OBSERVATION_STALE");
  });

  for (const key of ["modelValues", "effortValues"] as const) {
    it(`rejects missing ${key} without substituting the request`, () => {
      const input = fixture();
      input.observed[key] = [];
      rejected(input, "SELECTION_MISSING");
    });
    it.each([false, true])(
      `rejects multiple ${key}, duplicate=%s`,
      (duplicate) => {
        const input = fixture();
        input.observed[key].push(duplicate ? input.observed[key][0]! : "Other");
        rejected(input, "SELECTION_AMBIGUOUS");
      },
    );
  }

  it.each([
    "farol-next/chatgpt",
    "chatgpt",
    "farol/chatgpt",
    "Fixture Model",
    "FIXTURE-MODEL",
    "fixture-model ",
  ])("does not infer a model from unsupported request %s", (model) => {
    const input = fixture();
    input.requested.model = model;
    rejected(input, "REQUEST_UNSUPPORTED");
  });

  it("rejects an unsupported requested effort without fallback", () => {
    const input = fixture();
    input.requested.effort = "unspecified";
    rejected(input, "REQUEST_UNSUPPORTED");
  });

  it.each([
    "fixture-model",
    "farol-next/chatgpt",
    "chatgpt",
    "farol/chatgpt",
    "fixture model",
    "Fixture Model ",
  ])("requires explicitly supported literal public model value %s", (model) => {
    const input = fixture();
    input.observed.modelValues = [model];
    rejected(input, "OBSERVATION_UNSUPPORTED");
  });

  it("does not treat a requested effort alias as a public control value", () => {
    const input = fixture();
    input.observed.effortValues = ["careful"];
    rejected(input, "OBSERVATION_UNSUPPORTED");
  });

  it.each([
    "model",
    "model alias",
    "public model",
    "effort",
    "effort alias",
    "public effort",
  ])("rejects ambiguous catalogue %s", (collision) => {
    const input = fixture();
    const first = input.catalogue[0]!;
    const second = input.catalogue[1]!;
    if (collision === "model") second.model = first.model;
    if (collision === "model alias") second.aliases = [first.model];
    if (collision === "public model") second.publicValues = first.publicValues;
    if (collision === "effort") first.efforts[1]!.effort = "deep";
    if (collision === "effort alias") first.efforts[1]!.aliases = ["deep"];
    if (collision === "public effort")
      first.efforts[1]!.publicValues = ["Deep"];
    rejected(input, "CATALOGUE_AMBIGUOUS");
  });

  it("rejects duplicate catalogue aliases even on a single entry", () => {
    const input = fixture();
    input.catalogue[0]!.aliases = ["fixture-alias", "fixture-alias"];
    rejected(input, "CATALOGUE_AMBIGUOUS");
  });

  it("scopes supported efforts to the observed model", () => {
    const input = fixture();
    input.requested.model = "other-fixture-model";
    input.observed.modelValues = ["Other Fixture Model"];
    input.observed.effortValues = ["Quick"];
    rejected(input, "OBSERVATION_UNSUPPORTED");
  });

  it.each([null, undefined, false, [], {}, { ...fixture(), unexpected: true }])(
    "runtime-rejects invalid boundary data %#",
    (input) => rejected(input, "INVALID"),
  );

  it.each([
    { model: "" },
    { model: " " },
    { model: "x".repeat(257) },
    { effort: null },
    { model: "model\nname" },
    { prompt: "unexpected-field" },
  ])("rejects invalid requested metadata %#", (invalid) => {
    const input = fixture();
    rejected(
      { ...input, requested: { ...input.requested, ...invalid } },
      "INVALID",
    );
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN])(
    "rejects invalid generation/time %s",
    (invalid) => {
      const input = fixture();
      input.current.documentGeneration = invalid;
      rejected(input, "INVALID");
      rejected({ ...fixture(), nowMs: invalid }, "INVALID");
      rejected({ ...fixture(), maxAgeMs: invalid }, "INVALID");
    },
  );

  it("bounds catalogue, aliases, efforts and observation counts", () => {
    const input = fixture();
    const model = input.catalogue[0]!;
    rejected({ ...input, catalogue: [] }, "INVALID");
    rejected({ ...input, catalogue: Array(65).fill(model) }, "INVALID");
    for (const invalid of [
      { ...model, aliases: Array(17).fill("alias") },
      { ...model, publicValues: [] },
      { ...model, efforts: [] },
      { ...model, efforts: Array(33).fill(model.efforts[0]) },
    ])
      rejected({ ...input, catalogue: [invalid] }, "INVALID");
    rejected(
      {
        ...input,
        observed: { ...input.observed, modelValues: Array(9).fill("value") },
      },
      "INVALID",
    );
  });

  it("requires observed data instead of inferring it from the request", () => {
    const input = fixture();
    rejected({ ...input, observed: null }, "INVALID");
    rejected(
      { ...input, observed: { ...input.observed, effortValues: null } },
      "INVALID",
    );
    rejected(
      { ...input, observed: { ...input.observed, extra: "unknown" } },
      "INVALID",
    );
  });

  it("does not mutate input or retain input references in accepted evidence", () => {
    const input = fixture();
    const before = structuredClone(input);
    const result = validateChatGptModelBeforeSend(input);
    expect(input).toEqual(before);
    input.requested.model = "changed";
    input.observed.binding.taskId = "changed";
    expect(result).toMatchObject({
      ok: true,
      evidence: {
        requested: { model: "fixture-model" },
        observed: { binding: { taskId: "task-a" } },
      },
    });
  });
});
