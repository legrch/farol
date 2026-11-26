import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ConnectorKeyNotReplacedError,
  PrivateConnectorKeyStore,
  connectorKeyDigest,
} from "../../src/apps/desktop/connector-key-store";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function stateRoot(): Promise<string> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "farol-connector-credential-"),
  );
  roots.push(root);
  return path.join(root, "private", "connector");
}

describe("Farol connector credential store", () => {
  it("stores only a private file reference for tunnel-client", async () => {
    const root = await stateRoot();
    const store = new PrivateConnectorKeyStore({ root });
    const value = "sk-runtime-farol-example-1234567890";

    expect(await store.status()).toBe("missing");
    await store.store(value);

    expect(await store.status()).toBe("stored");
    expect(await store.reference()).toBe(
      `file:${path.join(root, "control-plane-api-key")}`,
    );
    expect(
      await fs.readFile(path.join(root, "control-plane-api-key"), "utf8"),
    ).toBe(value);
    expect((await fs.stat(root)).mode & 0o777).toBe(0o700);
    expect(
      (await fs.stat(path.join(root, "control-plane-api-key"))).mode & 0o777,
    ).toBe(0o600);

    await store.remove();
    expect(await store.status()).toBe("missing");
    await expect(store.reference()).rejects.toThrow(
      "CONNECTOR_CREDENTIAL_MISSING",
    );
  });

  it("rejects unsafe values and filesystem aliases", async () => {
    const root = await stateRoot();
    const store = new PrivateConnectorKeyStore({ root });

    await expect(store.store("line-one\nline-two")).rejects.toThrow(
      "CONNECTOR_CREDENTIAL_INVALID",
    );
    await expect(store.store("short")).rejects.toThrow(
      "CONNECTOR_CREDENTIAL_INVALID",
    );

    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const outside = path.join(path.dirname(root), "outside");
    await fs.writeFile(outside, "preserve", { mode: 0o600 });
    await fs.symlink(outside, path.join(root, "control-plane-api-key"));

    await expect(store.status()).rejects.toThrow("CONNECTOR_CREDENTIAL_UNSAFE");
    await expect(
      store.store("sk-runtime-safe-example-1234567890"),
    ).rejects.toThrow("CONNECTOR_CREDENTIAL_UNSAFE");
    expect(await fs.readFile(outside, "utf8")).toBe("preserve");
  });

  it("keeps the previous credential when atomic replacement is interrupted", async () => {
    const root = await stateRoot();
    const stable = new PrivateConnectorKeyStore({ root });
    await stable.store("sk-runtime-original-example-1234567890");
    const interrupted = new PrivateConnectorKeyStore(
      { root },
      {
        beforeCommit: async () => {
          throw new Error("interrupted");
        },
      },
    );

    await expect(
      interrupted.store("sk-runtime-replacement-example-1234567890"),
    ).rejects.toThrow("interrupted");
    expect(
      await fs.readFile(path.join(root, "control-plane-api-key"), "utf8"),
    ).toBe("sk-runtime-original-example-1234567890");
  });

  it("classifies only a failure before the rename as leaving the key unreplaced", async () => {
    const root = await stateRoot();
    const original = "sk-runtime-original-example-1234567890";
    await new PrivateConnectorKeyStore({ root }).store(original);
    const beforeRename = new PrivateConnectorKeyStore(
      { root },
      {
        beforeCommit: async () => {
          throw new Error("interrupted");
        },
      },
    );
    const refused = await beforeRename
      .store("sk-runtime-replacement-example-1234567890")
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ConnectorKeyNotReplacedError);
    expect((refused as Error).message).toBe("interrupted");
    await expect(beforeRename.store("short")).rejects.toBeInstanceOf(
      ConnectorKeyNotReplacedError,
    );
    expect(
      await fs.readFile(path.join(root, "control-plane-api-key"), "utf8"),
    ).toBe(original);

    // After the rename the new key is on disk: the outcome is not "unreplaced".
    const chmod = fs.chmod.bind(fs);
    vi.spyOn(fs, "chmod").mockImplementation(async (target, mode) => {
      if (String(target).endsWith("control-plane-api-key"))
        throw new Error("post-rename failure");
      return chmod(target, mode);
    });
    const unknown = await new PrivateConnectorKeyStore({ root })
      .store("sk-runtime-replacement-example-1234567890")
      .catch((error: unknown) => error);
    vi.restoreAllMocks();
    expect(unknown).toBeInstanceOf(Error);
    expect(unknown).not.toBeInstanceOf(ConnectorKeyNotReplacedError);
  });

  it("reports the digest of the stored key, or null when none is stored", async () => {
    const root = await stateRoot();
    const store = new PrivateConnectorKeyStore({ root });
    expect(await store.digest()).toBeNull();
    const value = "sk-runtime-farol-example-1234567890";
    await store.store(value);
    expect(await store.digest()).toBe(connectorKeyDigest(value));
    expect(connectorKeyDigest(value)).not.toBe(
      connectorKeyDigest("sk-runtime-other-example-1234567890"),
    );
  });
});
