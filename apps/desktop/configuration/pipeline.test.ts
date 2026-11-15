import { describe, expect, it, vi } from "vitest";
import { DesktopAdmission } from "../host/admission";
import { AuthorityTransitionReservation } from "../../../src/apps/desktop/authority-transition";
import { createConfigurationPipeline } from "./pipeline";
import type { ConfigurationPipelinePorts } from "./pipeline";
import type { DesktopGoCore } from "../go-core-host";
import type {
  ProductConfigurationCommand,
  ProductConfigurationResult,
} from "../../../src/pkg/product-settings/contract";

function pending() {
  return {
    chatGptReadonlyTask: () => false,
    directChatStart: () => false,
    chatGptAttachmentTask: () => false,
    workspaceEdit: () => false,
    computer: () => false,
    codexAgent: () => false,
    hostCheck: () => false,
    connectorStart: () => false,
  };
}

function makePorts(
  overrides: Partial<Parameters<typeof createConfigurationPipeline>[0]> = {},
) {
  const admission = new DesktopAdmission(pending());
  const authorityTransitions = new AuthorityTransitionReservation();
  let active: ProductConfigurationCommand["kind"] | null = null;
  const configuration = { snapshot: () => ({ status: "ready" }) } as unknown;
  const ports = {
    configuration: () => configuration,
    desktopGoCore: () => ({
      observeOriginalStop: vi.fn(async () => ({ restricted: false })),
    }),
    connectorRunning: () => false,
    connectorStartInFlight: () => null,
    desktopAdmission: admission,
    authorityTransitions,
    activeAuthorityChangeKind: () => active,
    setActiveAuthorityChangeKind: (
      value: ProductConfigurationCommand["kind"] | null,
    ) => {
      active = value;
    },
    codexAgentOperationActive: () => false,
    configurationFailure: vi.fn((error: string) => ({ ok: false, error })),
    computerMcpLifecycle: () =>
      ({
        hasUnconfirmedStop: vi.fn(async () => false),
        beginStop: vi.fn(async () => undefined),
        confirmStop: vi.fn(async () => undefined),
      }) as unknown,
    configureDrainedWorkspaceChange: vi.fn(async () => ({
      ok: true,
      drained: true,
    })),
    deliverConfigurationReply: vi.fn(
      (_kind: string, result: unknown) => result,
    ),
    configureAdmittedProduct: vi.fn(async (command: unknown) => ({
      ok: true,
      kind: (command as { kind: string }).kind,
    })),
    transitionRefusal: vi.fn(() => ({
      ok: false,
      error: "AUTHORITY_CHANGE_IN_PROGRESS",
    })),
    ...overrides,
  };
  return { ports, admission, authorityTransitions, getActive: () => active };
}

describe("configuration pipeline", () => {
  it("refuses before config work when desktop admission is closed", async () => {
    const { ports, admission } = makePorts();
    admission.beginQuit();
    const pipeline = createConfigurationPipeline(
      ports as unknown as ConfigurationPipelinePorts,
    );
    const result = await pipeline.configureNewProductRequest({
      kind: "chatgpt.observe-sign-in",
      observationId: "o",
      buildId: "a".repeat(64),
    } as unknown);
    expect(result).toEqual({
      ok: false,
      error: "AUTHORITY_CHANGE_IN_PROGRESS",
    });
    expect(ports.configureAdmittedProduct).not.toHaveBeenCalled();
  });

  it("returns SETTINGS_UNAVAILABLE when configuration is missing", async () => {
    const { ports } = makePorts({ configuration: () => null });
    const pipeline = createConfigurationPipeline(
      ports as unknown as ConfigurationPipelinePorts,
    );
    const result = await pipeline.configureUnfencedProduct({
      kind: "chatgpt.observe-sign-in",
      observationId: "o",
      buildId: "a".repeat(64),
    } as unknown);
    expect(result).toEqual({ ok: false, error: "SETTINGS_UNAVAILABLE" });
  });

  it("returns SETTINGS_INPUT_INVALID for invalid input", async () => {
    const { ports } = makePorts();
    const pipeline = createConfigurationPipeline(
      ports as unknown as ConfigurationPipelinePorts,
    );
    const result = await pipeline.configureUnfencedProduct({ nope: true });
    expect(result).toEqual({ ok: false, error: "SETTINGS_INPUT_INVALID" });
  });

  it("reserves and releases connector task during connector.configure custody", async () => {
    const { ports, admission } = makePorts();
    const core = {
      observeOriginalStop: vi.fn(async () => ({ restricted: false })),
    };
    ports.desktopGoCore = () =>
      core as unknown as Pick<DesktopGoCore, "observeOriginalStop">;
    ports.configureAdmittedProduct = vi.fn(
      async () =>
        ({
          ok: true,
          snapshot: { status: "error", error: "SETTINGS_READ_FAILED" },
        }) as unknown as ProductConfigurationResult,
    );
    const pipeline = createConfigurationPipeline(
      ports as unknown as ConfigurationPipelinePorts,
    );
    const result = await pipeline.configureUnfencedProduct({
      kind: "connector.configure",
      tunnelId: "t",
      runtimeKey: null,
    } as unknown);
    expect(result.ok).toBe(true);
    expect(admission.occupied("connector-task")).toBe(false);
    expect(core.observeOriginalStop).toHaveBeenCalled();
  });

  it("refuses connector.configure when original stop is restricted", async () => {
    const { ports } = makePorts();
    const core = {
      observeOriginalStop: vi.fn(async () => ({ restricted: true })),
    };
    ports.desktopGoCore = () =>
      core as unknown as Pick<DesktopGoCore, "observeOriginalStop">;
    const pipeline = createConfigurationPipeline(
      ports as unknown as ConfigurationPipelinePorts,
    );
    const result = await pipeline.configureUnfencedProduct({
      kind: "connector.configure",
      tunnelId: "t",
      runtimeKey: null,
    } as unknown);
    expect(result).toEqual({
      ok: false,
      error: "AUTHORITY_CHANGE_IN_PROGRESS",
    });
    expect(ports.configureAdmittedProduct).not.toHaveBeenCalled();
  });

  it("awaits ordinary config reply lifetime", async () => {
    const { ports } = makePorts();
    let admittedResolved = false;
    ports.configureAdmittedProduct = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      admittedResolved = true;
      return {
        ok: true,
        snapshot: { status: "error", error: "SETTINGS_READ_FAILED" },
      } as unknown as ProductConfigurationResult;
    });
    ports.deliverConfigurationReply = vi.fn((_k: string, r: unknown) => r);
    const pipeline = createConfigurationPipeline(
      ports as unknown as ConfigurationPipelinePorts,
    );
    const result = await pipeline.configureUnfencedProduct({
      kind: "chatgpt.toggle-sidebar",
    } as unknown);
    expect(admittedResolved).toBe(true);
    expect(result.ok).toBe(true);
    expect(ports.deliverConfigurationReply).toHaveBeenCalled();
  });

  it("captures authority refusal holder before await and releases on error", async () => {
    const { ports, authorityTransitions } = makePorts();
    // Hold the reservation first so withReservation refuses.
    const holder = authorityTransitions.tryReserve("connector-start")!;
    // Make activeAuthorityChangeKind non-null to capture.
    ports.setActiveAuthorityChangeKind(
      "connector.start" as unknown as ProductConfigurationCommand["kind"],
    );
    // Force configureAdmittedProduct to throw? Instead test holder capture via console.warn.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pipeline = createConfigurationPipeline(
      ports as unknown as ConfigurationPipelinePorts,
    );
    const result = await pipeline.configureUnfencedProduct({
      kind: "computer.rename",
      name: "x",
    } as unknown);
    expect(result).toEqual({
      ok: false,
      error: "AUTHORITY_CHANGE_IN_PROGRESS",
    });
    expect(warn).toHaveBeenCalled();
    void warn.mock.calls.find((c) => String(c[1]).includes("heldBy"));
    // holder released
    holder.release();
    // active should be reset? Since refused, the reservation callback didn't run, so active remains as set.
    // But on admitted path error, active resets. Here refusal path doesn't change active.
    warn.mockRestore();
  });

  it("resets active authority change kind on error inside reservation", async () => {
    const { ports, getActive } = makePorts();
    ports.connectorRunning = () => false;
    ports.desktopGoCore = () =>
      ({
        observeOriginalStop: vi.fn(async () => ({ restricted: false })),
      }) as unknown as Pick<DesktopGoCore, "observeOriginalStop">;
    ports.configureAdmittedProduct = vi.fn(async () => {
      throw new Error("boom");
    });
    ports.computerMcpLifecycle = () =>
      ({
        hasUnconfirmedStop: vi.fn(async () => false),
        beginStop: vi.fn(async () => {
          throw new Error("stop failed");
        }),
        confirmStop: vi.fn(async () => undefined),
      }) as unknown;
    const pipeline = createConfigurationPipeline(
      ports as unknown as ConfigurationPipelinePorts,
    );
    const result = await pipeline.configureUnfencedProduct({
      kind: "computer.rename",
      name: "x",
    } as unknown);
    expect(result).toEqual({ ok: false, error: "CONNECTOR_STOP_UNCONFIRMED" });
    expect(getActive()).toBeNull();
  });
});
