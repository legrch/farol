import { describe, expect, it, vi } from "vitest";
import { guidedSettingsFixture } from "../../../tests/fixtures/guided-onboarding";
import {
  ProductConfigurationResultSchema,
  ProductSettingsSchema,
  type ProductConfigurationResult,
} from "../../../src/pkg/product-settings/contract";
import {
  createConfigurationModel,
  modelStatusEvidencePayload,
  type ConfigurationModelPorts,
  type ModelConfigurationCommand,
} from "./model";

// These scripted ports cover command routing, refusal order and call order
// only. They do not qualify a real model endpoint, a native filesystem, a
// process-table scan, a live provider or a production profile.
const configPath = "/fixture/codex-home/config.toml";
const snapshot = {
  status: "ready",
  settings: ProductSettingsSchema.parse(guidedSettingsFixture()),
} as const;

const spec = {
  providerName: "farol",
  displayName: "Farol",
  baseUrl: "http://127.0.0.1:1234",
  model: "fixture-model",
  wireApi: "responses",
  delivery: { mode: "bearer-token", token: "fixture-token" },
} as never;

function command(value: object): ModelConfigurationCommand {
  return value as ModelConfigurationCommand;
}

function failureOf(result: ProductConfigurationResult) {
  return result.ok ? null : result.error;
}

type Step =
  | "status"
  | "spec"
  | "hostPresence"
  | "previewBlock"
  | "previewSelection"
  | "applyBlock"
  | "applySelection"
  | "rollbackBlock"
  | "rollbackSelection"
  | "rotate";

function scene(overrides: Partial<ConfigurationModelPorts> = {}) {
  const events: string[] = [];
  const failure = (error: string): ProductConfigurationResult =>
    ProductConfigurationResultSchema.parse({ ok: false, error, snapshot });
  // Each step records itself, then returns its scripted value or throws it.
  const script: Record<Step, unknown> = {
    status: { state: "listening", port: 1234, requestsServed: 0 },
    spec,
    hostPresence: "running",
    previewBlock: { status: "noop" },
    previewSelection: { status: "noop" },
    applyBlock: { status: "applied" },
    applySelection: { status: "applied" },
    rollbackBlock: { status: "restored" },
    rollbackSelection: { status: "restored" },
    rotate: {
      ok: true,
      providerBlockUpdated: true,
      providerBlockStatus: "applied",
    },
  };
  const step = async (name: Step) => {
    events.push(
      name === "status"
        ? "checkStatus"
        : name === "rotate"
          ? "rotateAndRewrite"
          : name,
    );
    const value = script[name];
    if (value instanceof Error) throw value;
    return value as never;
  };
  const lifecycle = {
    checkStatus: vi.fn(() => step("status")),
    rotateAndRewrite: vi.fn((..._arguments: unknown[]) => step("rotate")),
  };
  const configuration = {
    snapshot: vi.fn(() => {
      events.push("snapshot");
      return snapshot;
    }),
  };
  const ports = {
    configuration: () => configuration,
    modelLifecycle: () => lifecycle,
    configurationFailure: vi.fn((code: string) => {
      events.push(`failure:${code}`);
      return failure(code);
    }),
    farolModelProviderSpec: vi.fn(() => step("spec")),
    farolModelCodexConfigPath: vi.fn(() => {
      events.push("configPath");
      return configPath;
    }),
    farolModelCodexHostPresence: vi.fn(() => step("hostPresence")),
    previewFarolModelConfigBlock: vi.fn((..._arguments: unknown[]) =>
      step("previewBlock"),
    ),
    previewFarolModelProviderSelection: vi.fn((..._arguments: unknown[]) =>
      step("previewSelection"),
    ),
    applyFarolModelConfigBlock: vi.fn((..._arguments: unknown[]) =>
      step("applyBlock"),
    ),
    applyFarolModelProviderSelection: vi.fn((..._arguments: unknown[]) =>
      step("applySelection"),
    ),
    rollbackFarolModelConfigBlock: vi.fn((..._arguments: unknown[]) =>
      step("rollbackBlock"),
    ),
    rollbackFarolModelProviderSelection: vi.fn((..._arguments: unknown[]) =>
      step("rollbackSelection"),
    ),
    ...overrides,
  };
  const handler = createConfigurationModel(
    ports as unknown as ConfigurationModelPorts,
  );
  return {
    events,
    ports,
    lifecycle,
    configuration,
    handler,
    set: (name: Step, value: unknown) => {
      script[name] = value;
    },
  };
}

function evidenceOf(result: ProductConfigurationResult) {
  if (!result.ok) throw new Error(`expected success, got ${result.error}`);
  return (result as { evidence?: unknown }).evidence;
}

describe("model.status", () => {
  it("refuses without a lifecycle before probing or reading settings", async () => {
    const s = scene({ modelLifecycle: () => null });
    const result = await s.handler.configureAdmittedModel(
      command({ kind: "model.status" }),
    );
    expect(failureOf(result)).toBe("MODEL_ENDPOINT_UNAVAILABLE");
    expect(s.events).toEqual(["failure:MODEL_ENDPOINT_UNAVAILABLE"]);
    expect(s.lifecycle.checkStatus).not.toHaveBeenCalled();
  });

  it.each([
    [{ state: "not_running" }],
    [{ state: "sealed", port: 1234 }],
  ] as const)(
    "reports a %j endpoint as unavailable after one probe",
    async (status) => {
      const s = scene();
      s.set("status", status);
      const result = await s.handler.configureAdmittedModel(
        command({ kind: "model.status" }),
      );
      expect(failureOf(result)).toBe("MODEL_ENDPOINT_UNAVAILABLE");
      expect(s.events).toEqual([
        "checkStatus",
        "failure:MODEL_ENDPOINT_UNAVAILABLE",
      ]);
    },
  );

  it("reports a port conflict with the probed occupant and no requests", async () => {
    const s = scene();
    s.set("status", {
      state: "port_conflict",
      port: 4321,
      occupant: "foreign",
    });
    const result = await s.handler.configureAdmittedModel(
      command({ kind: "model.status" }),
    );
    expect(result.ok).toBe(true);
    expect(evidenceOf(result)).toEqual({
      kind: "model.status",
      state: "port_conflict",
      port: 4321,
      requestsServed: 0,
      occupant: "foreign",
    });
  });

  it.each(["listening", "connected"] as const)(
    "reports a %s endpoint with its served count and no occupant",
    async (state) => {
      const s = scene();
      s.set("status", {
        state,
        port: 1234,
        requestsServed: 7,
        lastAcceptedAtIso: undefined,
      });
      const result = await s.handler.configureAdmittedModel(
        command({ kind: "model.status" }),
      );
      expect(evidenceOf(result)).toEqual({
        kind: "model.status",
        state,
        port: 1234,
        requestsServed: 7,
      });
      expect(s.events).toEqual(["checkStatus", "snapshot"]);
    },
  );

  it("maps statuses through the shared payload helper without an occupant leak", () => {
    expect(
      modelStatusEvidencePayload({ state: "sealed", port: undefined }),
    ).toBeNull();
    expect(
      modelStatusEvidencePayload({
        state: "listening",
        port: 9,
        requestsServed: 1,
        lastAcceptedAtIso: "2026-11-24T00:00:00.000Z",
      }),
    ).toEqual({
      kind: "model.status",
      state: "listening",
      port: 9,
      requestsServed: 1,
    });
  });
});

describe("model.preview", () => {
  it("refuses without a provider spec before reading the config path", async () => {
    const s = scene({ farolModelProviderSpec: vi.fn(async () => null) });
    const result = await s.handler.configureAdmittedModel(
      command({ kind: "model.preview", selectAsDefault: true }),
    );
    expect(failureOf(result)).toBe("MODEL_ENDPOINT_UNAVAILABLE");
    expect(s.events).toEqual(["failure:MODEL_ENDPOINT_UNAVAILABLE"]);
    expect(s.ports.farolModelCodexConfigPath).not.toHaveBeenCalled();
  });

  it("previews only the block when the selection is not requested", async () => {
    const s = scene();
    s.set("previewBlock", {
      status: "install",
      diff: "+block",
      tokenRedacted: true,
    } as never);
    const result = await s.handler.configureAdmittedModel(
      command({ kind: "model.preview", selectAsDefault: false }),
    );
    expect(evidenceOf(result)).toEqual({
      kind: "model.config-preview",
      configPath,
      providerBlockStatus: "install",
      providerBlockDiff: "+block",
      providerBlockTokenRedacted: true,
      providerSelectionRequested: false,
    });
    expect(s.events).toEqual([
      "spec",
      "configPath",
      "previewBlock",
      "snapshot",
    ]);
    expect(s.ports.previewFarolModelConfigBlock).toHaveBeenCalledWith(
      configPath,
      spec,
    );
  });

  it("previews the selection after the block and reports both diffs", async () => {
    const s = scene();
    s.set("previewBlock", {
      status: "update",
      diff: "~block",
      tokenRedacted: false,
    } as never);
    s.set("previewSelection", {
      status: "install",
      diff: "+selection",
    } as never);
    const result = await s.handler.configureAdmittedModel(
      command({ kind: "model.preview", selectAsDefault: true }),
    );
    expect(evidenceOf(result)).toEqual({
      kind: "model.config-preview",
      configPath,
      providerBlockStatus: "update",
      providerBlockDiff: "~block",
      providerBlockTokenRedacted: false,
      providerSelectionRequested: true,
      providerSelectionStatus: "install",
      providerSelectionDiff: "+selection",
    });
    expect(s.events).toEqual([
      "spec",
      "configPath",
      "previewBlock",
      "previewSelection",
      "snapshot",
    ]);
  });

  it("reports block and selection conflicts", async () => {
    const s = scene();
    const conflicts = [{ table: "model_providers.farol", line: "x = 1" }];
    s.set("previewBlock", {
      status: "conflict",
      conflicts,
    } as never);
    s.set("previewSelection", {
      status: "conflict",
      conflicts: [{ table: "model_provider", line: "model_provider = 'x'" }],
    } as never);
    const result = await s.handler.configureAdmittedModel(
      command({ kind: "model.preview", selectAsDefault: true }),
    );
    expect(evidenceOf(result)).toEqual({
      kind: "model.config-preview",
      configPath,
      providerBlockStatus: "conflict",
      providerBlockConflicts: conflicts,
      providerSelectionRequested: true,
      providerSelectionStatus: "conflict",
      providerSelectionConflicts: [
        { table: "model_provider", line: "model_provider = 'x'" },
      ],
    });
  });

  it("reports the selection status alone when the selection is a no-op", async () => {
    const s = scene();
    const result = await s.handler.configureAdmittedModel(
      command({ kind: "model.preview", selectAsDefault: true }),
    );
    expect(evidenceOf(result)).toEqual({
      kind: "model.config-preview",
      configPath,
      providerBlockStatus: "noop",
      providerSelectionRequested: true,
      providerSelectionStatus: "noop",
    });
  });

  it("reports an insecure mode and never previews the selection over it", async () => {
    const s = scene();
    s.set("previewBlock", {
      status: "insecure_permissions",
      mode: 0o666,
    } as never);
    const result = await s.handler.configureAdmittedModel(
      command({ kind: "model.preview", selectAsDefault: true }),
    );
    expect(evidenceOf(result)).toEqual({
      kind: "model.config-preview",
      configPath,
      providerBlockStatus: "insecure_permissions",
      providerBlockInsecureMode: 0o666,
      providerSelectionRequested: true,
    });
    expect(s.ports.previewFarolModelProviderSelection).not.toHaveBeenCalled();
  });

  it.each(["symlink", "malformed"] as const)(
    "does not preview the selection over a %s block",
    async (status) => {
      const s = scene();
      s.set("previewBlock", {
        status,
      } as never);
      const result = await s.handler.configureAdmittedModel(
        command({ kind: "model.preview", selectAsDefault: true }),
      );
      expect(evidenceOf(result)).toEqual({
        kind: "model.config-preview",
        configPath,
        providerBlockStatus: status,
        providerSelectionRequested: true,
      });
      expect(s.ports.previewFarolModelProviderSelection).not.toHaveBeenCalled();
    },
  );

  it("does not catch a preview failure", async () => {
    const s = scene();
    s.set("previewBlock", new Error("PREVIEW_FIXTURE"));
    await expect(
      s.handler.configureAdmittedModel(
        command({ kind: "model.preview", selectAsDefault: false }),
      ),
    ).rejects.toThrow("PREVIEW_FIXTURE");
  });
});

describe("model.apply", () => {
  it("refuses without a provider spec before touching the config", async () => {
    const s = scene({ farolModelProviderSpec: vi.fn(async () => null) });
    const result = await s.handler.configureAdmittedModel(
      command({ kind: "model.apply", selectAsDefault: true }),
    );
    expect(failureOf(result)).toBe("MODEL_ENDPOINT_UNAVAILABLE");
    expect(s.events).toEqual(["failure:MODEL_ENDPOINT_UNAVAILABLE"]);
  });

  it("applies the block, then the selection, then reads host presence", async () => {
    const s = scene();
    const result = await s.handler.configureAdmittedModel(
      command({ kind: "model.apply", selectAsDefault: true }),
    );
    expect(evidenceOf(result)).toEqual({
      kind: "model.config-applied",
      providerBlockApplied: true,
      providerSelectionApplied: true,
      restartStep: "restart_codex_to_apply",
      codexHost: "running",
    });
    expect(s.events).toEqual([
      "spec",
      "configPath",
      "applyBlock",
      "applySelection",
      "hostPresence",
      "snapshot",
    ]);
    expect(s.ports.applyFarolModelConfigBlock).toHaveBeenCalledWith(
      configPath,
      spec,
    );
    expect(s.ports.applyFarolModelProviderSelection).toHaveBeenCalledWith(
      configPath,
      spec,
    );
  });

  it("skips the selection when it was not requested", async () => {
    const s = scene();
    s.set("applyBlock", {
      status: "noop",
    } as never);
    const result = await s.handler.configureAdmittedModel(
      command({ kind: "model.apply", selectAsDefault: false }),
    );
    expect(evidenceOf(result)).toMatchObject({
      providerBlockApplied: false,
      providerSelectionApplied: false,
    });
    expect(s.ports.applyFarolModelProviderSelection).not.toHaveBeenCalled();
  });

  it("reports a no-op selection as not applied", async () => {
    const s = scene();
    s.set("applySelection", {
      status: "noop",
    } as never);
    const result = await s.handler.configureAdmittedModel(
      command({ kind: "model.apply", selectAsDefault: true }),
    );
    expect(evidenceOf(result)).toMatchObject({
      providerBlockApplied: true,
      providerSelectionApplied: false,
    });
  });

  it.each([
    [
      { status: "insecure_permissions", mode: 0o666 },
      "MODEL_CONFIG_INSECURE_PERMISSIONS",
    ],
    [{ status: "conflict", conflicts: [] }, "MODEL_CONFIG_CONFLICT"],
    [{ status: "symlink" }, "MODEL_CONFIG_SYMLINK"],
    [{ status: "malformed" }, "MODEL_CONFIG_MALFORMED"],
  ] as const)(
    "refuses a %j block before the selection or host presence",
    async (blockResult, code) => {
      const s = scene();
      s.set("applyBlock", blockResult as never);
      const result = await s.handler.configureAdmittedModel(
        command({ kind: "model.apply", selectAsDefault: true }),
      );
      expect(failureOf(result)).toBe(code);
      expect(s.events).toEqual([
        "spec",
        "configPath",
        "applyBlock",
        `failure:${code}`,
      ]);
    },
  );

  it.each([
    [{ status: "conflict", conflicts: [] }, "MODEL_CONFIG_CONFLICT"],
    [{ status: "symlink" }, "MODEL_CONFIG_SYMLINK"],
    [{ status: "malformed" }, "MODEL_CONFIG_MALFORMED"],
  ] as const)(
    "refuses a %j selection after the block without reading host presence",
    async (selectionResult, code) => {
      const s = scene();
      s.set("applySelection", selectionResult as never);
      const result = await s.handler.configureAdmittedModel(
        command({ kind: "model.apply", selectAsDefault: true }),
      );
      expect(failureOf(result)).toBe(code);
      expect(s.events).toEqual([
        "spec",
        "configPath",
        "applyBlock",
        "applySelection",
        `failure:${code}`,
      ]);
      expect(s.ports.farolModelCodexHostPresence).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["block", "applyBlock", 0],
    ["selection", "applySelection", 1],
    ["host presence", "hostPresence", 1],
  ] as const)(
    "turns a thrown %s step into one failure without a retry",
    async (_label, port, selectionCalls) => {
      const s = scene();
      s.set(port, new Error("FIXTURE"));
      const result = await s.handler.configureAdmittedModel(
        command({ kind: "model.apply", selectAsDefault: true }),
      );
      expect(failureOf(result)).toBe("MODEL_CONFIG_APPLY_FAILED");
      expect(s.ports.applyFarolModelConfigBlock).toHaveBeenCalledTimes(1);
      expect(s.ports.applyFarolModelProviderSelection).toHaveBeenCalledTimes(
        selectionCalls,
      );
    },
  );

  it("does not catch a config path failure raised before the guarded section", async () => {
    const s = scene({
      farolModelCodexConfigPath: vi.fn(() => {
        throw new Error("PATH_FIXTURE");
      }),
    });
    await expect(
      s.handler.configureAdmittedModel(
        command({ kind: "model.apply", selectAsDefault: false }),
      ),
    ).rejects.toThrow("PATH_FIXTURE");
    expect(s.ports.applyFarolModelConfigBlock).not.toHaveBeenCalled();
  });
});

describe("model.rollback", () => {
  it("rolls the selection back before the block and reports both", async () => {
    const s = scene();
    s.set("rollbackBlock", {
      status: "not_present",
    } as never);
    const result = await s.handler.configureAdmittedModel(
      command({ kind: "model.rollback" }),
    );
    expect(evidenceOf(result)).toEqual({
      kind: "model.config-rollback",
      providerBlockRestored: false,
      providerSelectionRestored: true,
    });
    expect(s.events).toEqual([
      "configPath",
      "rollbackSelection",
      "rollbackBlock",
      "snapshot",
    ]);
    expect(s.ports.rollbackFarolModelProviderSelection).toHaveBeenCalledWith(
      configPath,
    );
    expect(s.ports.rollbackFarolModelConfigBlock).toHaveBeenCalledWith(
      configPath,
    );
  });

  it("reports a restored block with an absent selection", async () => {
    const s = scene();
    s.set("rollbackSelection", {
      status: "not_present",
    } as never);
    const result = await s.handler.configureAdmittedModel(
      command({ kind: "model.rollback" }),
    );
    expect(evidenceOf(result)).toEqual({
      kind: "model.config-rollback",
      providerBlockRestored: true,
      providerSelectionRestored: false,
    });
  });

  it.each([
    ["symlink", "MODEL_CONFIG_SYMLINK"],
    ["malformed", "MODEL_CONFIG_MALFORMED"],
  ] as const)(
    "stops at a %s selection without touching the block",
    async (status, code) => {
      const s = scene();
      s.set("rollbackSelection", {
        status,
      } as never);
      const result = await s.handler.configureAdmittedModel(
        command({ kind: "model.rollback" }),
      );
      expect(failureOf(result)).toBe(code);
      expect(s.events).toEqual([
        "configPath",
        "rollbackSelection",
        `failure:${code}`,
      ]);
      expect(s.ports.rollbackFarolModelConfigBlock).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["symlink", "MODEL_CONFIG_SYMLINK"],
    ["malformed", "MODEL_CONFIG_MALFORMED"],
  ] as const)(
    "refuses a %s block after the selection rolled back",
    async (status, code) => {
      const s = scene();
      s.set("rollbackBlock", {
        status,
      } as never);
      const result = await s.handler.configureAdmittedModel(
        command({ kind: "model.rollback" }),
      );
      expect(failureOf(result)).toBe(code);
      expect(s.events).toEqual([
        "configPath",
        "rollbackSelection",
        "rollbackBlock",
        `failure:${code}`,
      ]);
    },
  );

  it.each([
    ["selection", "rollbackSelection", 0],
    ["block", "rollbackBlock", 1],
  ] as const)(
    "turns a thrown %s rollback into one failure without a retry",
    async (_label, port, blockCalls) => {
      const s = scene();
      s.set(port, new Error("FIXTURE"));
      const result = await s.handler.configureAdmittedModel(
        command({ kind: "model.rollback" }),
      );
      expect(failureOf(result)).toBe("MODEL_CONFIG_ROLLBACK_FAILED");
      expect(s.ports.rollbackFarolModelProviderSelection).toHaveBeenCalledTimes(
        1,
      );
      expect(s.ports.rollbackFarolModelConfigBlock).toHaveBeenCalledTimes(
        blockCalls,
      );
    },
  );
});

describe("model.rotate-token", () => {
  it("refuses without a lifecycle before reading the config path", async () => {
    const s = scene({ modelLifecycle: () => null });
    const result = await s.handler.configureAdmittedModel(
      command({ kind: "model.rotate-token" }),
    );
    expect(failureOf(result)).toBe("MODEL_ENDPOINT_UNAVAILABLE");
    expect(s.events).toEqual(["failure:MODEL_ENDPOINT_UNAVAILABLE"]);
  });

  it("hands the lifecycle the path, the spec reader and both block operations once", async () => {
    const s = scene();
    const result = await s.handler.configureAdmittedModel(
      command({ kind: "model.rotate-token" }),
    );
    expect(evidenceOf(result)).toEqual({
      kind: "model.token-rotated",
      providerBlockUpdated: true,
      providerBlockStatus: "applied",
    });
    expect(s.lifecycle.rotateAndRewrite).toHaveBeenCalledTimes(1);
    expect(s.lifecycle.rotateAndRewrite).toHaveBeenCalledWith({
      configPath,
      spec: s.ports.farolModelProviderSpec,
      preview: s.ports.previewFarolModelConfigBlock,
      apply: s.ports.applyFarolModelConfigBlock,
    });
    expect(s.events).toEqual(["configPath", "rotateAndRewrite", "snapshot"]);
  });

  it("returns the lifecycle's refusal code and never reads settings", async () => {
    const s = scene();
    s.set("rotate", {
      ok: false,
      code: "FAROL_MODEL_ROTATE_RESTORE_FAILED",
    } as never);
    const result = await s.handler.configureAdmittedModel(
      command({ kind: "model.rotate-token" }),
    );
    expect(failureOf(result)).toBe("FAROL_MODEL_ROTATE_RESTORE_FAILED");
    expect(s.configuration.snapshot).not.toHaveBeenCalled();
    expect(s.events).toEqual([
      "configPath",
      "rotateAndRewrite",
      "failure:FAROL_MODEL_ROTATE_RESTORE_FAILED",
    ]);
  });

  it("turns a thrown rotation into one failure without a retry", async () => {
    const s = scene();
    s.set("rotate", new Error("FIXTURE"));
    const result = await s.handler.configureAdmittedModel(
      command({ kind: "model.rotate-token" }),
    );
    expect(failureOf(result)).toBe("MODEL_TOKEN_ROTATE_FAILED");
    expect(s.lifecycle.rotateAndRewrite).toHaveBeenCalledTimes(1);
  });

  it("turns a failed config path read into the rotation failure", async () => {
    const s = scene({
      farolModelCodexConfigPath: vi.fn(() => {
        throw new Error("PATH_FIXTURE");
      }),
    });
    const result = await s.handler.configureAdmittedModel(
      command({ kind: "model.rotate-token" }),
    );
    expect(failureOf(result)).toBe("MODEL_TOKEN_ROTATE_FAILED");
    expect(s.lifecycle.rotateAndRewrite).not.toHaveBeenCalled();
  });
});
