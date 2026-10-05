import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  captureChatModelSnapshot,
  type CompiledChatModelProfile,
} from "../../apps/desktop/go-chat-model-snapshot.ts";
import { BridgeError } from "../../apps/desktop/bridge/client.ts";
import { validate } from "../../apps/desktop/bridge/wire.ts";
import { GoChatBrowserDriver } from "../../apps/desktop/go-chat-browser.ts";
import { taskPolicyIdentity } from "../../src/pkg/owner-config/contract.ts";

// Synthetic declarations only: no Go execution, physical browser, provider,
// native/filesystem route, production catalogue or startup qualification.
function tasks() {
  return {
    defaultHarness: "browser",
    harnesses: {
      browser: {
        defaultModel: "chatgpt",
        models: {
          chatgpt: { model: "controlled-model", defaultEffort: "low" },
        },
      },
    },
  };
}

function profile() {
  return {
    metadata: {
      id: "controlled-fixture-v1",
      executor: "browser",
      runtimeModel: "controlled-model",
      modelId: "controlled-model",
      defaultEffort: "low",
      mode: "" as "" | "standard" | "pro",
      efforts: [{ requested: "low", resolved: "low" }],
      required: { model: true, effort: true, mode: false, connector: false },
    },
    controls: {
      model: [{ value: "controlled-model", literal: "Test model" }],
      effort: [{ value: "low", literal: "Light" }],
      mode: [] as { value: string; literal: string }[],
      connector: [] as { value: string; literal: string }[],
    },
  };
}

function refused(run: () => unknown): void {
  let failure: unknown;
  try {
    run();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(BridgeError);
  expect((failure as BridgeError).state).toBe("refused");
}

function expectFrozen(value: unknown): void {
  if (value !== null && typeof value === "object") {
    expect(Object.isFrozen(value)).toBe(true);
    for (const child of Object.values(value)) expectFrozen(child);
  }
}

describe("existing settings to Go/browser model snapshot", () => {
  it("hashes exact taskPolicyIdentity bytes for the supplied d23b588 conformance fixture", () => {
    const config = tasks();
    const snapshot = captureChatModelSnapshot(config, [profile()]);
    const identity =
      '["farol-task-policy/1","browser",[["browser","chatgpt",[["chatgpt","controlled-model","low"]]]]]';
    expect(taskPolicyIdentity(config)).toBe(identity);
    expect(snapshot.configSHA256).toBe(
      "5bf5b497b199cfac19cccadec8ca426f7da9cbbe97b96eeec15364b138809e3e",
    );
    expect(snapshot.configSHA256).toBe(
      createHash("sha256").update(identity, "utf8").digest("hex"),
    );
    expect(snapshot.policy).toEqual({
      defaultHarness: "browser",
      harnesses: [
        {
          name: "browser",
          defaultModel: "chatgpt",
          models: [
            {
              alias: "chatgpt",
              model: "controlled-model",
              defaultEffort: "low",
            },
          ],
        },
      ],
    });
    expect(snapshot.profiles).toEqual([profile().metadata]);
    expect(snapshot.translations).toEqual([
      {
        ...profile().controls,
        version: "public-controls-v1",
        configSHA256: snapshot.configSHA256,
        translationId: profile().metadata.id,
      },
    ]);
    expect(validate("ChatModelPolicy", snapshot.policy)).toBe(true);
    expect(validate("ChatBrowserModelProfile[]", snapshot.profiles)).toBe(true);
    const lookup = vi.fn(() => undefined);
    expect(
      () =>
        new GoChatBrowserDriver({
          lookup,
          translations: snapshot.translations,
        }),
    ).not.toThrow();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("sorts config maps and preserves the canonical TS/Go encoding from modelselection/policy_test.go", () => {
    const browser = {
      defaultModel: "small",
      models: {
        wide: { model: "fixture/wide", defaultEffort: "high" },
        small: { model: "fixture/small", defaultEffort: "medium" },
        plain: { model: "fixture/no-effort" },
      },
    };
    const future = {
      defaultModel: "small",
      models: { small: { model: "fixture/future" } },
    };
    const config = {
      defaultHarness: "browser",
      harnesses: { future, browser },
    };
    const snapshot = captureChatModelSnapshot(config, [profile()]);
    const canonical =
      '["farol-task-policy/1","browser",[["browser","small",[["plain","fixture/no-effort",null],["small","fixture/small","medium"],["wide","fixture/wide","high"]]],["future","small",[["small","fixture/future",null]]]]]';
    expect(taskPolicyIdentity(config)).toBe(canonical);
    expect(snapshot.configSHA256).toBe(
      "5d867c69e7c53e6d7990743608cf091b905492879ff70b818c6c055fa32784be",
    );
    expect(snapshot.configSHA256).toBe(
      createHash("sha256").update(canonical, "utf8").digest("hex"),
    );
    expect(snapshot.policy.harnesses.map((harness) => harness.name)).toEqual([
      "browser",
      "future",
    ]);
    expect(
      snapshot.policy.harnesses[0]!.models.map((model) => model.alias),
    ).toEqual(["plain", "small", "wide"]);
    expect(snapshot.policy.harnesses[0]!.models[0]).not.toHaveProperty(
      "defaultEffort",
    );
    const reordered = {
      defaultHarness: "browser",
      harnesses: {
        browser: {
          ...browser,
          models: {
            plain: browser.models.plain,
            small: browser.models.small,
            wide: browser.models.wide,
          },
        },
        future,
      },
    };
    expect(captureChatModelSnapshot(reordered, [profile()])).toEqual(snapshot);
  });

  it("distinguishes omitted config effort from an explicit effort without inserting a route default", () => {
    const omitted = {
      defaultHarness: "browser",
      harnesses: {
        browser: {
          defaultModel: "chatgpt",
          models: { chatgpt: { model: "controlled-model" } },
        },
      },
    };
    const first = captureChatModelSnapshot(omitted, [profile()]);
    const explicit = captureChatModelSnapshot(tasks(), [profile()]);
    expect(first.policy.harnesses[0]!.models[0]).not.toHaveProperty(
      "defaultEffort",
    );
    expect(first.configSHA256).not.toBe(explicit.configSHA256);
    const noDefault = profile();
    noDefault.metadata.defaultEffort = "";
    expect(
      captureChatModelSnapshot(omitted, [noDefault]).profiles[0]!.defaultEffort,
    ).toBe("");
  });

  it("detaches and deeply freezes snapshots; later edits produce a separate capture", () => {
    const config = tasks(),
      rows = [profile()];
    const before = structuredClone({ config, rows });
    const old = captureChatModelSnapshot(config, rows);
    expect({ config, rows }).toEqual(before);
    expect(Object.isFrozen(config)).toBe(false);
    expect(Object.isFrozen(rows[0]!.controls.model[0])).toBe(false);
    expectFrozen(old);
    const admitted = structuredClone(old);
    config.harnesses.browser.models.chatgpt.defaultEffort = "high";
    rows[0]!.controls.model[0]!.literal = "Changed model";
    rows[0]!.metadata.efforts.push({ requested: "high", resolved: "high" });
    rows[0]!.controls.effort.push({ value: "high", literal: "Deep" });
    rows[0]!.metadata.required.effort = false;
    const next = captureChatModelSnapshot(config, rows);
    expect(old).toEqual(admitted);
    expect(next.configSHA256).not.toBe(old.configSHA256);
    expect(next.translations[0]!.configSHA256).toBe(next.configSHA256);
    expectFrozen(next);
    expect(() =>
      Object.assign(old.profiles[0]!.required, { effort: false }),
    ).toThrow(TypeError);
    expect(() =>
      Object.assign(old.translations[0]!.model[0]!, { literal: "Refresh" }),
    ).toThrow(TypeError);
    expect(() =>
      Object.assign(old.policy.harnesses[0]!.models[0]!, {
        defaultEffort: "high",
      }),
    ).toThrow(TypeError);
  });

  it("keeps caller profiles independent of config defaults, aliases and hash", () => {
    const config = {
      defaultHarness: "future",
      harnesses: {
        future: {
          defaultModel: "unmapped",
          models: {
            unmapped: { model: "not-compiled", defaultEffort: "unsupported" },
          },
        },
      },
    };
    const row = profile();
    row.metadata.runtimeModel = "caller/runtime";
    const snapshot = captureChatModelSnapshot(config, [row]);
    expect(snapshot.policy.harnesses[0]!.models[0]!.model).toBe("not-compiled");
    expect(snapshot.profiles).toEqual([row.metadata]);
    expect(snapshot.translations[0]!.model).toEqual(row.controls.model);
    const edited = profile();
    edited.controls.model[0]!.literal = "Caller qualified label";
    expect(captureChatModelSnapshot(config, [edited]).configSHA256).toBe(
      snapshot.configSHA256,
    );
  });

  it("supports explicit effort pairs sharing a resolved control and a declared mode", () => {
    const row = profile();
    row.metadata.efforts = [
      { requested: "high", resolved: "route-high" },
      { requested: "Ultra", resolved: "route-high" },
    ];
    row.metadata.defaultEffort = "route-high";
    row.metadata.mode = "pro";
    row.metadata.required.mode = true;
    row.controls.effort = [{ value: "route-high", literal: "Deep" }];
    row.controls.mode = [{ value: "pro", literal: "Pro" }];
    expect(captureChatModelSnapshot(tasks(), [row]).profiles[0]).toEqual(
      row.metadata,
    );
  });

  it("keeps multiple caller rows paired by their own ID and shares only the policy digest", () => {
    const first = profile(),
      second = profile();
    second.metadata.id = "second-route";
    second.metadata.runtimeModel = "second-runtime";
    second.metadata.modelId = "second-control";
    second.controls.model = [
      { value: "second-control", literal: "Second model" },
    ];
    const snapshot = captureChatModelSnapshot(tasks(), [second, first]);
    expect(snapshot.profiles.map((row) => row.id)).toEqual([
      "second-route",
      first.metadata.id,
    ]);
    expect(snapshot.translations.map((row) => row.translationId)).toEqual(
      snapshot.profiles.map((row) => row.id),
    );
    expect(
      snapshot.translations.every(
        (row) => row.configSHA256 === snapshot.configSHA256,
      ),
    ).toBe(true);
  });

  it.each([
    undefined,
    null,
    {},
    { ...tasks(), defaultHarness: "missing" },
    { ...tasks(), extra: true },
    { ...tasks(), harnesses: {} },
    {
      defaultHarness: "browser",
      harnesses: {
        browser: {
          defaultModel: "missing",
          models: tasks().harnesses.browser.models,
        },
      },
    },
    {
      defaultHarness: "browser",
      harnesses: {
        browser: {
          defaultModel: "chatgpt",
          models: { chatgpt: { model: "bad model" } },
        },
      },
    },
    {
      defaultHarness: "browser",
      harnesses: {
        browser: {
          defaultModel: "chatgpt",
          models: { chatgpt: { model: "controlled-model", defaultEffort: "" } },
        },
      },
    },
  ])("refuses invalid config without a fallback: %j", (config) => {
    refused(() => captureChatModelSnapshot(config, [profile()]));
  });

  it("classifies malformed accessors and uncloneable input as local refusals", () => {
    const config = {
      get defaultHarness() {
        throw new BridgeError("unknown", "input_accessor_failure");
      },
      harnesses: tasks().harnesses,
    };
    refused(() => captureChatModelSnapshot(config, [profile()]));
    const row = { ...profile(), uncloneable: () => undefined };
    refused(() => captureChatModelSnapshot(tasks(), [row]));
  });

  it.each([
    [],
    undefined,
    null,
    {},
    Array.from({ length: 129 }, () => profile()),
  ])("refuses absent or unbounded compiled profiles", (rows) => {
    refused(() =>
      captureChatModelSnapshot(
        tasks(),
        rows as readonly CompiledChatModelProfile[],
      ),
    );
  });

  it.each([
    [
      "model mismatch",
      (row: ReturnType<typeof profile>) => {
        row.controls.model[0]!.value = "other";
      },
    ],
    [
      "extra model",
      (row: ReturnType<typeof profile>) => {
        row.controls.model.push({ value: "other", literal: "Other" });
      },
    ],
    [
      "missing model",
      (row: ReturnType<typeof profile>) => {
        row.controls.model = [];
      },
    ],
    [
      "requested instead of resolved effort",
      (row: ReturnType<typeof profile>) => {
        row.metadata.efforts[0]!.resolved = "route-low";
        row.metadata.defaultEffort = "route-low";
      },
    ],
    [
      "extra effort",
      (row: ReturnType<typeof profile>) => {
        row.controls.effort.push({ value: "high", literal: "Deep" });
      },
    ],
    [
      "missing effort",
      (row: ReturnType<typeof profile>) => {
        row.controls.effort = [];
      },
    ],
    [
      "duplicate requested effort",
      (row: ReturnType<typeof profile>) => {
        row.metadata.efforts.push({ requested: "low", resolved: "low" });
      },
    ],
    [
      "no effort pairs",
      (row: ReturnType<typeof profile>) => {
        row.metadata.efforts = [];
      },
    ],
    [
      "unlisted default effort",
      (row: ReturnType<typeof profile>) => {
        row.metadata.defaultEffort = "high";
      },
    ],
    [
      "malformed requested effort",
      (row: ReturnType<typeof profile>) => {
        row.metadata.efforts[0]!.requested = "bad.value";
      },
    ],
    [
      "malformed resolved effort",
      (row: ReturnType<typeof profile>) => {
        row.metadata.efforts[0]!.resolved = "bad value";
      },
    ],
    [
      "mode flag mismatch",
      (row: ReturnType<typeof profile>) => {
        row.metadata.mode = "pro";
      },
    ],
    [
      "mode value mismatch",
      (row: ReturnType<typeof profile>) => {
        row.metadata.mode = "pro";
        row.metadata.required.mode = true;
        row.controls.mode = [{ value: "standard", literal: "Standard" }];
      },
    ],
    [
      "mode without metadata",
      (row: ReturnType<typeof profile>) => {
        row.controls.mode = [{ value: "standard", literal: "Standard" }];
      },
    ],
    [
      "no required model",
      (row: ReturnType<typeof profile>) => {
        row.metadata.required.model = false;
      },
    ],
    [
      "required connector",
      (row: ReturnType<typeof profile>) => {
        row.metadata.required.connector = true;
      },
    ],
    [
      "undeclared connector",
      (row: ReturnType<typeof profile>) => {
        row.controls.connector = [{ value: "connector", literal: "Connector" }];
      },
    ],
    [
      "duplicate control value",
      (row: ReturnType<typeof profile>) => {
        row.controls.effort.push({ value: "low", literal: "Other light" });
      },
    ],
    [
      "duplicate control literal",
      (row: ReturnType<typeof profile>) => {
        row.metadata.efforts.push({ requested: "high", resolved: "high" });
        row.controls.effort.push({ value: "high", literal: "Light" });
      },
    ],
    [
      "Go ID bound",
      (row: ReturnType<typeof profile>) => {
        row.metadata.id = "a".repeat(121);
      },
    ],
    [
      "Go model ID bound",
      (row: ReturnType<typeof profile>) => {
        row.metadata.modelId = "a".repeat(121);
        row.controls.model[0]!.value = row.metadata.modelId;
      },
    ],
  ] as const)(
    "refuses invalid or ambiguous compiled controls: %s",
    (_name, edit) => {
      const row = profile();
      edit(row);
      refused(() => captureChatModelSnapshot(tasks(), [row]));
    },
  );

  it.each([
    "",
    "\u0085",
    "\u3000",
    "line\nfeed",
    "tab\t",
    "\u007f",
    "\ud800",
    "é".repeat(129),
  ])(
    "refuses malformed literal %j using browser constructor validation",
    (literal) => {
      const row = profile();
      row.controls.model[0]!.literal = literal;
      refused(() => captureChatModelSnapshot(tasks(), [row]));
    },
  );

  it("preserves literal bytes without normalizing Unicode or trimming", () => {
    const row = profile();
    row.controls.model[0]!.literal = "  Modèle 🧭  ";
    expect(
      captureChatModelSnapshot(tasks(), [row]).translations[0]!.model[0]!
        .literal,
    ).toBe(row.controls.model[0]!.literal);
  });

  it.each(["id", "runtime"])(
    "refuses ambiguous duplicate %s rows in either order",
    (kind) => {
      const first = profile(),
        second = profile();
      if (kind === "id") second.metadata.runtimeModel = "other-runtime";
      else second.metadata.id = "other-id";
      refused(() => captureChatModelSnapshot(tasks(), [first, second]));
      refused(() => captureChatModelSnapshot(tasks(), [second, first]));
    },
  );

  it.each([
    null,
    {},
    { ...profile(), extra: true },
    { ...profile(), metadata: { ...profile().metadata, extra: true } },
    { ...profile(), controls: { ...profile().controls, extra: [] } },
    {
      ...profile(),
      controls: {
        ...profile().controls,
        model: [
          { value: "controlled-model", literal: "Test model", extra: true },
        ],
      },
    },
    { ...profile(), controls: { ...profile().controls, effort: null } },
  ])("refuses malformed or open compiled shape: %j", (row) => {
    refused(() =>
      captureChatModelSnapshot(tasks(), [
        row,
      ] as unknown as readonly CompiledChatModelProfile[]),
    );
  });
});
