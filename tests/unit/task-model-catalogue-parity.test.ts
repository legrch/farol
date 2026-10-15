import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  describeTaskModels,
  RuntimeTaskCatalogueSchema,
} from "../../src/pkg/owner-config/contract.ts";
import { startGoTaskCatalogueFixture } from "../fixtures/go-task-catalogue-fixture/process.ts";

type RuntimeTaskCatalogue = z.infer<typeof RuntimeTaskCatalogueSchema>;

const go = process.env.FAROL_TEST_GO ?? "go";
const compilerUnavailable = (() => {
  try {
    execFileSync(go, ["version"], { stdio: "ignore", timeout: 5000 });
    return false;
  } catch (error) {
    return (
      !process.env.FAROL_TEST_GO &&
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    );
  }
})();

type ModelSpec = { model: string; defaultEffort?: string };
type Policy = {
  defaultHarness: string;
  harnesses: Record<
    string,
    { defaultModel: string; models: Record<string, ModelSpec> }
  >;
};
type RuntimeModel = Extract<
  RuntimeTaskCatalogue,
  { status: "ready" }
>["models"][number];

const ready = (
  models: RuntimeModel[],
  scope = "catalogue-fixture",
  observedAt = 0,
): RuntimeTaskCatalogue => ({
  status: "ready",
  source: "model/list",
  scope,
  observedAt,
  models,
});

function config(
  models: Record<string, ModelSpec>,
  defaultModel = "alpha",
): Policy {
  return {
    defaultHarness: "codex",
    harnesses: { codex: { defaultModel, models } },
  };
}

function runtime(
  model: string,
  supportedEfforts: string[] = [],
  extra: Partial<RuntimeModel> = {},
): RuntimeModel {
  return {
    id: `runtime-${model}`,
    model,
    displayName: `Runtime ${model}`,
    hidden: false,
    supportedEfforts,
    ...extra,
  } as RuntimeModel;
}

const policyCases: Array<[string, Policy]> = [
  ["default model, effort omitted", config({ alpha: { model: "m-alpha" } })],
  [
    "default effort high",
    config({ alpha: { model: "m-alpha", defaultEffort: "high" } }),
  ],
  [
    "default effort low",
    config({ alpha: { model: "m-alpha", defaultEffort: "low" } }),
  ],
  [
    "default effort xhigh",
    config({ alpha: { model: "m-alpha", defaultEffort: "xhigh" } }),
  ],
  [
    "two aliases in source order",
    config({ alpha: { model: "m-alpha" }, beta: { model: "m-beta" } }),
  ],
  [
    "three aliases with shared model",
    config({
      alpha: { model: "m-alpha" },
      beta: { model: "m-alpha", defaultEffort: "high" },
      gamma: { model: "m-gamma" },
    }),
  ],
  [
    "distinct efforts and models",
    config({
      alpha: { model: "m-alpha", defaultEffort: "high" },
      beta: { model: "m-beta", defaultEffort: "low" },
      gamma: { model: "m-gamma", defaultEffort: "medium" },
    }),
  ],
  [
    "ordered aliases with punctuation",
    config({
      alpha: { model: "m-alpha" },
      "beta.v2": { model: "m-beta" },
      "gamma-x": { model: "m-gamma" },
    }),
  ],
];

const catalogueCases: Array<[string, RuntimeTaskCatalogue]> = [
  ["no observations", ready([])],
  ["only alpha", ready([runtime("m-alpha")])],
  ["alpha supports high", ready([runtime("m-alpha", ["high"])])],
  ["alpha supports low", ready([runtime("m-alpha", ["low"])])],
  [
    "alpha supports several",
    ready([runtime("m-alpha", ["low", "medium", "high", "xhigh"])]),
  ],
  [
    "runtime default effort is preserved independently",
    ready([runtime("m-alpha", ["high"], { defaultEffort: "high" })]),
  ],
  ["other model only", ready([runtime("m-unconfigured")])],
  ["hidden alpha", ready([runtime("m-alpha", ["high"], { hidden: true })])],
  [
    "duplicate runtime first hidden entry wins",
    ready([
      runtime("m-alpha", [], {
        id: "first-hidden",
        displayName: "First",
        hidden: true,
      }),
      runtime("m-alpha", ["high"], {
        id: "second-visible",
        displayName: "Second",
        hidden: false,
      }),
    ]),
  ],
];

const vectors = policyCases.flatMap(([policyName, policy]) =>
  catalogueCases.map(([catalogueName, catalogue]) => ({
    name: `${policyName}; ${catalogueName}`,
    policy,
    catalogue,
  })),
);

const unavailableCatalogue: RuntimeTaskCatalogue = {
  status: "unavailable",
  code: "CODEX_MODEL_LIST_UNAVAILABLE",
};

let fixture: Awaited<ReturnType<typeof startGoTaskCatalogueFixture>>;

describe.skipIf(compilerUnavailable)(
  "Go Task catalogue parity with the existing TypeScript view",
  () => {
    beforeAll(async () => {
      fixture = await startGoTaskCatalogueFixture();
    }, 40000);
    afterAll(async () => {
      await fixture?.close();
    });

    it.each(vectors)(
      "matches the published Go contract for $name",
      async ({ policy, catalogue }) => {
        const harness = "codex";
        const reply = await fixture.describe(
          JSON.stringify(policy),
          harness,
          JSON.stringify(catalogue),
        );
        expect(reply).toEqual({
          view: describeTaskModels(policy, harness, catalogue),
        });
      },
    );

    it.each([
      [
        "unavailable catalogue preserves unknown and null effort",
        config({ alpha: { model: "m-alpha", defaultEffort: "high" } }),
        "codex",
        unavailableCatalogue,
      ],
      [
        "missing config returns empty configured rows",
        undefined,
        "codex",
        ready([]),
      ],
      [
        "invalid policy returns config error",
        {
          defaultHarness: "codex",
          harnesses: { codex: { defaultModel: "alpha", models: {} } },
        },
        "codex",
        ready([]),
      ],
      [
        "invalid other harness invalidates policy",
        {
          ...config({ alpha: { model: "m-alpha" } }),
          harnesses: {
            ...config({ alpha: { model: "m-alpha" } }).harnesses,
            other: {
              defaultModel: "beta",
              models: { beta: { model: "invalid model" } },
            },
          },
        },
        "codex",
        ready([]),
      ],
      [
        "requested harness missing returns config error",
        config({ alpha: { model: "m-alpha" } }),
        "missing",
        ready([]),
      ],
    ] as Array<[string, unknown, string, RuntimeTaskCatalogue]>)(
      "matches TypeScript policy fallback: %s",
      async (_name, policy, harness, catalogue) => {
        const reply = await fixture.describe(
          policy === undefined ? "" : JSON.stringify(policy),
          harness,
          JSON.stringify(catalogue),
        );
        expect(reply).toEqual({
          view: describeTaskModels(policy, harness, catalogue),
        });
      },
    );

    it("preserves 64 configured aliases, their insertion order and optional fields", async () => {
      const models = Object.fromEntries(
        Array.from({ length: 64 }, (_, index) => [
          index === 0 ? "alpha" : `alias-${String(index).padStart(2, "0")}`,
          {
            model: `m-${index}`,
            ...(index % 2 ? { defaultEffort: "high" } : {}),
          },
        ]),
      );
      const policy = config(models);
      const catalogue = ready([runtime("m-0", ["high"]), runtime("m-63")]);
      const reply = await fixture.describe(
        JSON.stringify(policy),
        "codex",
        JSON.stringify(catalogue),
      );
      expect(reply).toEqual({
        view: describeTaskModels(policy, "codex", catalogue),
      });
      if ("view" in reply) {
        const view = reply.view as ReturnType<typeof describeTaskModels>;
        expect(view.configured.map((row) => row.alias)).toEqual(
          Object.keys(models),
        );
        expect(view.configured).toHaveLength(64);
      }
    });

    it("matches UTF-16 string counts and safe integer timestamps at boundaries", async () => {
      const policy = config({
        alpha: { model: "m-alpha", defaultEffort: "high" },
      });
      const boundary = ready(
        [
          runtime("m-alpha", ["high"], { displayName: "😀".repeat(120) }),
          runtime("m-unused", [], { id: "😀".repeat(80), displayName: "" }),
        ],
        "😀".repeat(120),
        Number.MAX_SAFE_INTEGER,
      );
      const reply = await fixture.describe(
        JSON.stringify(policy),
        "codex",
        JSON.stringify(boundary),
      );
      expect(reply).toEqual({
        view: describeTaskModels(policy, "codex", boundary),
      });
    });

    it.each([
      ["unknown status", '{"status":"unknown"}'],
      [
        "missing ready source",
        '{"status":"ready","scope":"x","observedAt":0,"models":[]}',
      ],
      [
        "unsafe timestamp",
        '{"status":"ready","source":"model/list","scope":"x","observedAt":9007199254740992,"models":[]}',
      ],
      [
        "too many efforts",
        JSON.stringify({
          status: "ready",
          source: "model/list",
          scope: "x",
          observedAt: 0,
          models: [
            runtime(
              "m-alpha",
              Array.from({ length: 33 }, (_, i) => `e${i}`),
            ),
          ],
        }),
      ],
      ["unpaired Unicode", '{"status":"unavailable","code":"\\ud800"}'],
    ])(
      "rejects invalid Go catalogue boundary: %s",
      async (_name, catalogue) => {
        expect(
          await fixture.describe(
            JSON.stringify(config({ alpha: { model: "m-alpha" } })),
            "codex",
            catalogue,
          ),
        ).toEqual({
          error: "TASK_MODEL_CATALOGUE_INVALID",
        });
      },
    );

    it("preserves present empty catalogues and exact observation fields", async () => {
      const policy = config({ alpha: { model: "m-alpha" } });
      const catalogue = ready([], "scope-v2", 123456789);
      const reply = await fixture.describe(
        JSON.stringify(policy),
        "codex",
        JSON.stringify(catalogue),
      );
      expect(reply).toEqual({
        view: describeTaskModels(policy, "codex", catalogue),
      });
    });
  },
);
