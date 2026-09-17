import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PrivateConnectorKeyStore } from "../../src/apps/desktop/connector-key-store";

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
    path.join(os.tmpdir(), "farol-next-connector-credential-"),
  );
  roots.push(root);
  return path.join(root, "private", "connector");
}

describe("Farol Next connector credential store", () => {
  it("stores only a private file reference for tunnel-client", async () => {
    const root = await stateRoot();
    const store = new PrivateConnectorKeyStore({ root });
    const value = "sk-runtime-farol-next-example-1234567890";

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
});
