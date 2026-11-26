import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrivateConnectorKeyStore } from "../../../src/apps/desktop/connector-key-store";
import {
  ProductConfigurationService,
  ProductSettingsStore,
} from "../../../src/apps/desktop/product-configuration";
import { fixtureTaskSettingsCompare } from "../../../tests/fixtures/task-settings-projection";
import { fixtureTaskModelPolicy } from "../../../tests/fixtures/task-policy";
import { AuthorityTransitionReservation } from "../../../src/apps/desktop/authority-transition";
import { admissionFixture } from "../../../tests/support/desktop-admission";
import {
  fixtureBuildId,
  guidedSettingsFixture,
} from "../../../tests/fixtures/guided-onboarding";
import {
  ProductConfigurationResultSchema,
  type ProductConfigurationResult,
  type ProductConfigurationSnapshot,
} from "../../../src/pkg/product-settings/contract";
import {
  createConfigurationConnector,
  type ConfigurationConnectorPorts,
} from "./connector";

// These scripted ports cover command routing only. They do not qualify native
// startup, credentials, filesystem Stop, a live provider or a production profile.
function fixture() {
  const snapshot = { status: "error", error: "SETTINGS_READ_FAILED" } as const;
  const result = ProductConfigurationResultSchema.parse({ ok: true, snapshot });
  const start = vi.fn(async () => result);
  const verifyClient = vi.fn(async () => result);
  const selected = vi.fn(async () => "cancelled");
  const boundary = {
    configuration: () => ({ snapshot: () => snapshot }),
    configurationFailure: (error: string) =>
      ProductConfigurationResultSchema.parse({ ok: false, error, snapshot }),
    startSecureMcpConnector: start,
    selectedTunnelClientExecutable: selected,
    verifyTunnelClientExecutable: verifyClient,
  };
  // One test-only cast admits partial owners. Each test may call only the
  // explicitly scripted ports; a missing port fails rather than hiding effects.
  const handler = createConfigurationConnector(
    boundary as unknown as ConfigurationConnectorPorts,
  );
  return { handler, result, start, verifyClient, selected };
}

describe("connector configuration command routing", () => {
  it.each([
    ["connector.start", false],
    ["connector.repair", true],
  ] as const)(
    "keeps %s on its existing single start path",
    async (kind, repair) => {
      const f = fixture();
      expect(await f.handler.configureAdmittedConnector({ kind })).toBe(
        f.result,
      );
      expect(f.start).toHaveBeenCalledExactlyOnceWith(repair);
      expect(f.verifyClient).not.toHaveBeenCalled();
    },
  );

  it("refuses retained save-and-connect without entering the ordinary start path", async () => {
    const f = fixture();
    expect(
      await f.handler.configureAdmittedConnector({
        kind: "connector.save-and-connect",
        operationId: "11111111-1111-4111-8111-111111111111",
        buildId: "a".repeat(64),
        tunnelId: "fixture",
        runtimeKey: "fixture-runtime-key-000000000000",
      }),
    ).toMatchObject({ ok: false, error: "AUTHORITY_CHANGE_IN_PROGRESS" });
    expect(f.start).not.toHaveBeenCalled();
    expect(f.selected).not.toHaveBeenCalled();
  });

  it("stops cancelled selection before any verification effect", async () => {
    const f = fixture();
    expect(
      await f.handler.configureAdmittedConnector({
        kind: "connector.select-client",
      }),
    ).toMatchObject({ ok: false, error: "TUNNEL_CLIENT_PICKER_CANCELLED" });
    expect(f.selected).toHaveBeenCalledOnce();
    expect(f.verifyClient).not.toHaveBeenCalled();
  });
});

function setupFixture() {
  const settings = guidedSettingsFixture();
  const snapshot = { status: "ready", settings } as const;
  const command = {
    kind: "connector.save-and-connect",
    operationId: "11111111-1111-4111-8111-111111111111",
    buildId: fixtureBuildId,
    tunnelId: settings.connectors.secureMcp.tunnelId!,
    runtimeKey: "fixture-runtime-key-000000000000",
  } as const;
  const desktopAdmission = admissionFixture({}).desktopAdmission;
  const authorityTransitions = new AuthorityTransitionReservation();
  const active: (string | null)[] = [];
  const events: string[] = [];
  const result = ProductConfigurationResultSchema.parse({ ok: true, snapshot });
  const custody = vi.fn(async () => {
    events.push("custody");
    return { restricted: false };
  });
  const save = vi.fn(async () => {
    expect(desktopAdmission.occupied("connector-task")).toBe(true);
    expect(authorityTransitions.current()).toBe("authority-change");
    events.push("save");
    return result;
  });
  const start = vi.fn(async () => {
    expect(desktopAdmission.occupied("connector-task")).toBe(true);
    expect(authorityTransitions.current()).toBe("authority-change");
    events.push("start");
    return ProductConfigurationResultSchema.parse({
      ok: true,
      snapshot,
      evidence: {
        kind: "connector.runtime",
        state: "ready",
        runtimeGeneration:
          settings.connectors.secureMcp.runtime!.runtimeGeneration,
        computerGeneration: settings.computer.generation,
        buildId: fixtureBuildId,
      },
    });
  });
  const boundary = {
    desktopAdmission,
    authorityTransitions,
    setActiveAuthorityChangeKind: (kind: string | null) => active.push(kind),
    desktopGoCore: () => ({ observeOriginalStop: custody }),
    configuration: () => ({ snapshot: () => snapshot }),
    connectorCredentialStore: () => ({}),
    secureMcpConnectorRuntime: () => ({
      hasUnresolvedEffect: () => false,
      isRunning: () => false,
    }),
    buildIdentity: () => ({ buildId: fixtureBuildId }),
    configurationFailure: (error: string) =>
      ProductConfigurationResultSchema.parse({ ok: false, error, snapshot }),
    observeConnectorStart: async (
      work: () => Promise<ProductConfigurationResult>,
    ) => {
      events.push("observed-start");
      return work();
    },
    configureAdmittedProduct: save,
    startAdmittedSecureMcpConnector: start,
    deliverConfigurationReply: (
      _kind: string,
      value: ProductConfigurationResult,
    ) => value,
  };
  // Identity-bearing owner objects are partial scripted doubles at this one
  // test-only boundary. The real coordinator, result parser and admissions run.
  const handler = createConfigurationConnector(
    boundary as unknown as ConfigurationConnectorPorts,
  );
  return {
    command,
    handler,
    desktopAdmission,
    authorityTransitions,
    active,
    events,
    custody,
    save,
    start,
    snapshot,
  };
}

describe("connector Setup composition", () => {
  it("holds both reservations from original Stop custody through Save and Start", async () => {
    const f = setupFixture();
    const result = await f.handler.configureSaveAndConnect(f.command);
    expect(result).toMatchObject({
      ok: true,
      connectorSetup: {
        state: "completed",
        credentials: "saved",
        connection: "connected",
        externalVerification: "not-proven",
      },
    });
    expect(f.events).toEqual(["custody", "observed-start", "save", "start"]);
    expect(f.save).toHaveBeenCalledExactlyOnceWith({
      kind: "connector.configure",
      tunnelId: f.command.tunnelId,
      runtimeKey: f.command.runtimeKey,
    });
    expect(f.start).toHaveBeenCalledExactlyOnceWith(false);
    expect(f.active).toEqual(["connector.save-and-connect", null]);
    expect(f.desktopAdmission.occupied("connector-task")).toBe(false);
    expect(f.desktopAdmission.configurationRequests).toBe(0);
    expect(f.authorityTransitions.current()).toBeNull();
  });

  it("keeps unresolved original Stop custody ahead of both effects", async () => {
    const f = setupFixture();
    f.custody.mockResolvedValue({ restricted: true });
    expect(await f.handler.configureSaveAndConnect(f.command)).toMatchObject({
      ok: false,
      error: "AUTHORITY_CHANGE_IN_PROGRESS",
      connectorSetup: {
        state: "refused",
        credentials: "not-started",
        connection: "not-started",
      },
    });
    expect(f.events).toEqual([]);
    expect(f.save).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
    expect(f.active).toEqual(["connector.save-and-connect", null]);
    expect(f.desktopAdmission.configurationRequests).toBe(0);
    expect(f.desktopAdmission.occupied("connector-task")).toBe(false);
    expect(f.authorityTransitions.current()).toBeNull();
  });

  it("retains credential UNKNOWN without issuing Start or retrying Save", async () => {
    const f = setupFixture();
    f.save.mockResolvedValue(
      ProductConfigurationResultSchema.parse({
        ok: false,
        error: "CONNECTOR_CREDENTIAL_OUTCOME_UNKNOWN",
        snapshot: f.snapshot,
      }),
    );
    expect(await f.handler.configureSaveAndConnect(f.command)).toMatchObject({
      ok: false,
      error: "CONNECTOR_CREDENTIAL_OUTCOME_UNKNOWN",
      connectorSetup: { state: "unknown", connection: "not-started" },
    });
    expect(f.save).toHaveBeenCalledOnce();
    expect(f.start).not.toHaveBeenCalled();
    expect(f.desktopAdmission.configurationRequests).toBe(0);
    expect(f.desktopAdmission.occupied("connector-task")).toBe(false);
    expect(f.authorityTransitions.current()).toBeNull();
  });
});

// Real Settings service and real private key store over disposable temp roots.
// Only the credential owner's ports are scripted; no installed profile, real
// keychain or live connector is touched.

const OLD_KEY = "synthetic-old-key-1234567890-aaaa";
const NEW_KEY = "synthetic-new-key-1234567890-bbbb";
const OTHER_KEY = "synthetic-other-key-1234567890-cccc";
const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function harness() {
  const base = await fs.mkdtemp(
    path.join(os.tmpdir(), "farol-connector-fence-"),
  );
  roots.push(base);
  const keyRoot = path.join(base, "private-key");
  const settings = new ProductSettingsStore({ root: path.join(base, "state") });
  let sequence = 0;
  const service = new ProductConfigurationService(settings, {
    taskModelPolicy: fixtureTaskModelPolicy,
    taskSettingsCompare: fixtureTaskSettingsCompare,
    now: () => "2026-09-16T10:00:00.000Z",
    id: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
  });
  await service.initialize();
  const hooks: { beforeCommit: () => Promise<void> } = {
    beforeCommit: async () => undefined,
  };
  const credentials = new PrivateConnectorKeyStore(
    { root: keyRoot },
    { beforeCommit: () => hooks.beforeCommit() },
  );
  const storeSpy = vi.spyOn(credentials, "store");
  const handler = createConfigurationConnector({
    configuration: () => service,
    connectorCredentialStore: () => credentials,
    secureMcpConnectorRuntime: () => ({
      hasUnresolvedEffect: () => false,
      isRunning: () => false,
    }),
    configurationFailure: (error: string) =>
      ProductConfigurationResultSchema.parse({
        ok: false,
        error,
        snapshot: service.snapshot(),
      }),
    // One test-only cast admits the partial owner: each case drives only the
    // `connector.configure` route, and any other port would fail loudly.
  } as unknown as ConfigurationConnectorPorts);
  await credentials.store(OLD_KEY);
  storeSpy.mockClear();
  await service.configureSecureMcpTunnel({ tunnelId: "original" });
  await service.recordSecureMcpCredential("stored");
  const keyFile = path.join(keyRoot, "control-plane-api-key");
  return {
    settings,
    service,
    credentials,
    handler,
    hooks,
    storeSpy,
    keyFile,
    configure: (runtimeKey: string | null) =>
      handler.configureAdmittedConnector({
        kind: "connector.configure",
        tunnelId: "replacement",
        runtimeKey,
      }),
    key: () => fs.readFile(keyFile, "utf8"),
  };
}

function connectState(snapshot: ProductConfigurationSnapshot) {
  if (snapshot.status !== "ready") throw new Error("settings missing");
  return snapshot.settings.setup.connect;
}

describe("credential replacement fence settlement", () => {
  it("(a) releases the fence when the first Settings readback after the begin write fails", async () => {
    const h = await harness();
    vi.spyOn(h.settings, "load").mockRejectedValueOnce(
      new Error("synthetic first readback failure"),
    );

    const failed = await h.configure(NEW_KEY);

    expect(failed).toMatchObject({ ok: false, error: "SETTINGS_WRITE_FAILED" });
    // The key store was never invoked, so the old key is provably intact.
    expect(h.storeSpy).not.toHaveBeenCalled();
    expect(await h.key()).toBe(OLD_KEY);
    expect(connectState(h.service.snapshot()).outcomeUnknown).toBe(false);

    const retried = await h.configure(NEW_KEY);
    expect(retried.ok).toBe(true);
    expect(await h.key()).toBe(NEW_KEY);
    expect(connectState(retried.snapshot).outcomeUnknown).toBe(false);
  });

  it("(b) releases the fence when the key store fails before its rename", async () => {
    const h = await harness();
    h.hooks.beforeCommit = async () => {
      throw new Error("synthetic failure before rename");
    };

    const failed = await h.configure(NEW_KEY);

    expect(failed).toMatchObject({
      ok: false,
      error: "CONNECTOR_CREDENTIAL_STORE_FAILED",
    });
    expect(await h.key()).toBe(OLD_KEY);
    expect(connectState(failed.snapshot).outcomeUnknown).toBe(false);

    h.hooks.beforeCommit = async () => undefined;
    const retried = await h.configure(NEW_KEY);
    expect(retried.ok).toBe(true);
    expect(await h.key()).toBe(NEW_KEY);
    expect(connectState(retried.snapshot).outcomeUnknown).toBe(false);
  });

  it("(c) lets a retry settle the known-new key when the completion save fails", async () => {
    const h = await harness();
    const save = h.settings.save.bind(h.settings);
    let saves = 0;
    vi.spyOn(h.settings, "save").mockImplementation(async (...args) => {
      // The begin write lands; the completion write is refused outright.
      if (++saves === 2) throw new Error("synthetic completion save failure");
      return save(...args);
    });

    const failed = await h.configure(NEW_KEY);

    expect(failed).toMatchObject({ ok: false, error: "SETTINGS_WRITE_FAILED" });
    expect(await h.key()).toBe(NEW_KEY);
    expect(connectState(failed.snapshot).outcomeUnknown).toBe(true);

    const retried = await h.configure(NEW_KEY);
    expect(retried.ok).toBe(true);
    // The retry settles the fence; it does not write the key a second time.
    expect(h.storeSpy).toHaveBeenCalledOnce();
    expect(await h.key()).toBe(NEW_KEY);
    expect(connectState(retried.snapshot).outcomeUnknown).toBe(false);
    const snapshot = h.service.snapshot();
    if (snapshot.status !== "ready") throw new Error("settings missing");
    expect(snapshot.settings.connectors.secureMcp).toMatchObject({
      tunnelId: "replacement",
      credential: "stored",
    });
  });

  it("(c) refuses to settle when the stored key is no longer the one that was written", async () => {
    const h = await harness();
    const save = h.settings.save.bind(h.settings);
    let saves = 0;
    vi.spyOn(h.settings, "save").mockImplementation(async (...args) => {
      if (++saves === 2) throw new Error("synthetic completion save failure");
      return save(...args);
    });
    await h.configure(NEW_KEY);
    // Another writer replaced the file after the first attempt.
    await fs.writeFile(h.keyFile, OTHER_KEY, { mode: 0o600 });

    const retried = await h.configure(NEW_KEY);

    expect(retried).toMatchObject({
      ok: false,
      error: "CONNECTOR_RUNTIME_OUTCOME_UNKNOWN",
    });
    expect(connectState(retried.snapshot).outcomeUnknown).toBe(true);
  });

  it("(c) refuses to settle a retry that submits a different key", async () => {
    const h = await harness();
    const save = h.settings.save.bind(h.settings);
    let saves = 0;
    vi.spyOn(h.settings, "save").mockImplementation(async (...args) => {
      if (++saves === 2) throw new Error("synthetic completion save failure");
      return save(...args);
    });
    await h.configure(NEW_KEY);

    const retried = await h.configure(OTHER_KEY);

    expect(retried).toMatchObject({
      ok: false,
      error: "CONNECTOR_RUNTIME_OUTCOME_UNKNOWN",
    });
    expect(h.storeSpy).toHaveBeenCalledOnce();
    expect(await h.key()).toBe(NEW_KEY);
  });

  it("keeps the fence, and never replays the write, when the key store outcome is unknown", async () => {
    const h = await harness();
    // The rename has happened; the failure comes after it.
    const chmod = fs.chmod.bind(fs);
    vi.spyOn(fs, "chmod").mockImplementation(async (target, mode) => {
      if (String(target).endsWith("control-plane-api-key"))
        throw new Error("synthetic post-rename failure");
      return chmod(target, mode);
    });

    const failed = await h.configure(NEW_KEY);

    expect(failed).toMatchObject({
      ok: false,
      error: "CONNECTOR_CREDENTIAL_OUTCOME_UNKNOWN",
    });
    expect(await h.key()).toBe(NEW_KEY);
    expect(connectState(failed.snapshot).outcomeUnknown).toBe(true);

    const retried = await h.configure(NEW_KEY);
    expect(retried).toMatchObject({
      ok: false,
      error: "CONNECTOR_RUNTIME_OUTCOME_UNKNOWN",
    });
    expect(h.storeSpy).toHaveBeenCalledOnce();
    expect(connectState(retried.snapshot).outcomeUnknown).toBe(true);
  });
});
