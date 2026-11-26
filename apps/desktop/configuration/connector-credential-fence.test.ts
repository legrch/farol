import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrivateConnectorKeyStore } from "../../../src/apps/desktop/connector-key-store";
import {
  ProductConfigurationService,
  ProductSettingsStore,
} from "../../../src/apps/desktop/product-configuration";
import {
  ProductConfigurationResultSchema,
  type ProductConfigurationSnapshot,
} from "../../../src/pkg/product-settings/contract";
import { fixtureTaskSettingsCompare } from "../../../tests/fixtures/task-settings-projection";
import { fixtureTaskModelPolicy } from "../../../tests/fixtures/task-policy";
import {
  createConfigurationConnector,
  type ConfigurationConnectorPorts,
} from "./connector";

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
