import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyFarolModelConfigBlock,
  applyFarolModelProviderSelection,
  previewFarolModelConfigBlock,
  previewFarolModelProviderSelection,
  rollbackFarolModelConfigBlock,
  rollbackFarolModelProviderSelection,
  type FarolModelProviderSpec,
} from "../../src/apps/desktop/farol-model-config-block";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function disposableConfig(initial?: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-model-config-"));
  roots.push(root);
  const configPath = path.join(root, "config.toml");
  if (initial !== undefined) {
    await fs.writeFile(configPath, initial, { mode: 0o644 });
  }
  return configPath;
}

const envKeySpec: FarolModelProviderSpec = {
  providerName: "farol",
  displayName: "Farol Model",
  baseUrl: "http://127.0.0.1:54217",
  model: "farol-model",
  wireApi: "responses",
  delivery: { mode: "env-key", envKeyName: "FAROL_MODEL_TOKEN" },
};

const bearerTokenSpec: FarolModelProviderSpec = {
  ...envKeySpec,
  delivery: { mode: "bearer-token", token: "s3cr3t-token" },
};

describe("Farol Model managed provider block", () => {
  it("installs into a config file that does not exist yet, and never writes a profile", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-model-config-"),
    );
    roots.push(root);
    const configPath = path.join(root, "sub", "config.toml");

    const preview = await previewFarolModelConfigBlock(configPath, envKeySpec);
    expect(preview.status).toBe("install");

    const result = await applyFarolModelConfigBlock(configPath, envKeySpec);
    expect(result.status).toBe("applied");
    const contents = await fs.readFile(configPath, "utf8");
    expect(contents).toContain("[model_providers.farol]");
    expect(contents).toContain('base_url = "http://127.0.0.1:54217"');
    expect(contents).toContain('env_key = "FAROL_MODEL_TOKEN"');
    expect(contents).not.toContain("[profiles.");
    expect(contents).not.toContain("experimental_bearer_token");
  });

  it("preserves every other section byte for byte", async () => {
    const other = [
      "[some_other_section]",
      'key = "value"',
      "",
      "[model_providers.openai]",
      'name = "OpenAI"',
      "",
    ].join("\n");
    const configPath = await disposableConfig(other);

    await applyFarolModelConfigBlock(configPath, envKeySpec);
    const contents = await fs.readFile(configPath, "utf8");
    expect(contents.startsWith(other.replace(/\s+$/u, ""))).toBe(true);
    expect(contents).toContain("[model_providers.farol]");
  });

  it("is idempotent: a second apply of the same spec is a no-op", async () => {
    const configPath = await disposableConfig("[unrelated]\nfoo = 1\n");
    const first = await applyFarolModelConfigBlock(configPath, envKeySpec);
    expect(first.status).toBe("applied");
    const afterFirst = await fs.readFile(configPath, "utf8");

    const second = await applyFarolModelConfigBlock(configPath, envKeySpec);
    expect(second.status).toBe("noop");
    const afterSecond = await fs.readFile(configPath, "utf8");
    expect(afterSecond).toBe(afterFirst);

    const preview = await previewFarolModelConfigBlock(configPath, envKeySpec);
    expect(preview.status).toBe("noop");
  });

  it("updates the block in place when the spec changes (e.g. a new port)", async () => {
    const configPath = await disposableConfig("[unrelated]\nfoo = 1\n");
    await applyFarolModelConfigBlock(configPath, envKeySpec);

    const changed: FarolModelProviderSpec = {
      ...envKeySpec,
      baseUrl: "http://127.0.0.1:9999",
    };
    const preview = await previewFarolModelConfigBlock(configPath, changed);
    expect(preview.status).toBe("update");

    const result = await applyFarolModelConfigBlock(configPath, changed);
    expect(result.status).toBe("applied");
    const contents = await fs.readFile(configPath, "utf8");
    expect(contents).toContain('base_url = "http://127.0.0.1:9999"');
    expect(contents).not.toContain("54217");
    // Still exactly one managed block.
    expect(contents.match(/BEGIN FAROL MANAGED BLOCK/gu)?.length).toBe(1);
  });

  it("rotating the token (bearer-token delivery) rewrites the block and is still idempotent", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-model-config-"),
    );
    roots.push(root);
    const configPath = path.join(root, "config.toml");

    const first = await applyFarolModelConfigBlock(configPath, bearerTokenSpec);
    expect(first.status).toBe("applied");
    expect(await fs.readFile(configPath, "utf8")).toContain(
      'experimental_bearer_token = "s3cr3t-token"',
    );

    const rotated: FarolModelProviderSpec = {
      ...bearerTokenSpec,
      delivery: { mode: "bearer-token", token: "rotated-token" },
    };
    const preview = await previewFarolModelConfigBlock(configPath, rotated);
    expect(preview.status).toBe("update");
    const applied = await applyFarolModelConfigBlock(configPath, rotated);
    expect(applied.status).toBe("applied");
    const contents = await fs.readFile(configPath, "utf8");
    expect(contents).toContain('experimental_bearer_token = "rotated-token"');
    expect(contents).not.toContain("s3cr3t-token");

    const noop = await applyFarolModelConfigBlock(configPath, rotated);
    expect(noop.status).toBe("noop");
  });

  it("reports a conflict for a foreign entry of the same name and never overwrites it", async () => {
    const foreign = [
      "[model_providers.farol]",
      'name = "Hand written"',
      "",
    ].join("\n");
    const configPath = await disposableConfig(foreign);

    const preview = await previewFarolModelConfigBlock(configPath, envKeySpec);
    expect(preview.status).toBe("conflict");
    if (preview.status === "conflict") {
      expect(preview.conflicts[0]?.table).toBe("model_providers.farol");
    }

    const result = await applyFarolModelConfigBlock(configPath, envKeySpec);
    expect(result.status).toBe("conflict");
    const contents = await fs.readFile(configPath, "utf8");
    expect(contents).toBe(foreign);
  });

  it("declining changes nothing at all", async () => {
    const configPath = await disposableConfig("[unrelated]\nfoo = 1\n");
    const before = await fs.readFile(configPath, "utf8");
    await previewFarolModelConfigBlock(configPath, envKeySpec);
    const after = await fs.readFile(configPath, "utf8");
    expect(after).toBe(before);
  });

  it("refuses a literal-token write against a group-readable config.toml, saying exactly why", async () => {
    const configPath = await disposableConfig("[unrelated]\nfoo = 1\n");
    await fs.chmod(configPath, 0o640);

    const preview = await previewFarolModelConfigBlock(
      configPath,
      bearerTokenSpec,
    );
    expect(preview.status).toBe("insecure_permissions");
    if (preview.status === "insecure_permissions") {
      expect(preview.mode).toBe(0o640);
    }

    const before = await fs.readFile(configPath, "utf8");
    const result = await applyFarolModelConfigBlock(
      configPath,
      bearerTokenSpec,
    );
    expect(result.status).toBe("insecure_permissions");
    expect(await fs.readFile(configPath, "utf8")).toBe(before);
  });

  it("refuses a literal-token write against a world-readable config.toml", async () => {
    const configPath = await disposableConfig("[unrelated]\nfoo = 1\n");
    await fs.chmod(configPath, 0o644);
    const result = await applyFarolModelConfigBlock(
      configPath,
      bearerTokenSpec,
    );
    expect(result.status).toBe("insecure_permissions");
  });

  it("does not refuse an env-key delivery against a group-readable config.toml (no secret in the file)", async () => {
    const configPath = await disposableConfig("[unrelated]\nfoo = 1\n");
    await fs.chmod(configPath, 0o644);
    const result = await applyFarolModelConfigBlock(configPath, envKeySpec);
    expect(result.status).toBe("applied");
  });

  it("creates a brand new config.toml 0600 for a literal-token delivery", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-model-config-"),
    );
    roots.push(root);
    const configPath = path.join(root, "config.toml");
    const result = await applyFarolModelConfigBlock(
      configPath,
      bearerTokenSpec,
    );
    expect(result.status).toBe("applied");
    expect((await fs.stat(configPath)).mode & 0o777).toBe(0o600);
  });

  it("rollback restores the exact previous bytes and mode", async () => {
    const before = "[unrelated]\nfoo = 1\n";
    const configPath = await disposableConfig(before);
    await fs.chmod(configPath, 0o640);
    const beforeMode = (await fs.stat(configPath)).mode & 0o777;

    await applyFarolModelConfigBlock(configPath, envKeySpec);
    expect(await fs.readFile(configPath, "utf8")).not.toBe(before);

    const rollback = await rollbackFarolModelConfigBlock(configPath);
    expect(rollback.status).toBe("restored");
    expect(await fs.readFile(configPath, "utf8")).toBe(before);
    expect((await fs.stat(configPath)).mode & 0o777).toBe(beforeMode);
  });

  it("rollback removes the file entirely when it did not exist before", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-model-config-"),
    );
    roots.push(root);
    const configPath = path.join(root, "config.toml");

    await applyFarolModelConfigBlock(configPath, envKeySpec);
    expect(
      await fs
        .stat(configPath)
        .then(() => true)
        .catch(() => false),
    ).toBe(true);

    await rollbackFarolModelConfigBlock(configPath);
    await expect(fs.stat(configPath)).rejects.toThrow();
  });

  it("reports no backup when nothing has been applied yet", async () => {
    const configPath = await disposableConfig("[unrelated]\nfoo = 1\n");
    const rollback = await rollbackFarolModelConfigBlock(configPath);
    expect(rollback.status).toBe("no_backup");
  });
});

describe("Farol Model provider selection (separate consent)", () => {
  it("is not written unless applied separately, even after the provider block is installed", async () => {
    const configPath = await disposableConfig("[unrelated]\nfoo = 1\n");
    await applyFarolModelConfigBlock(configPath, envKeySpec);
    const contents = await fs.readFile(configPath, "utf8");
    expect(contents).not.toContain("model_provider =");
  });

  it("previews and applies before the provider block's own table header, staying valid TOML root placement", async () => {
    const configPath = await disposableConfig("[unrelated]\nfoo = 1\n");
    await applyFarolModelConfigBlock(configPath, envKeySpec);

    const preview = await previewFarolModelProviderSelection(
      configPath,
      "farol",
    );
    expect(preview.status).toBe("install");

    const applied = await applyFarolModelProviderSelection(configPath, "farol");
    expect(applied.status).toBe("applied");

    const contents = await fs.readFile(configPath, "utf8");
    const selectionIndex = contents.indexOf("model_provider =");
    const firstTableIndex = contents.indexOf("[");
    expect(selectionIndex).toBeGreaterThan(-1);
    expect(selectionIndex).toBeLessThan(firstTableIndex);
    expect(contents).toContain('model_provider = "farol"');
  });

  it("is idempotent and independent of the provider block's own apply/rollback", async () => {
    const configPath = await disposableConfig("[unrelated]\nfoo = 1\n");
    await applyFarolModelConfigBlock(configPath, envKeySpec);
    await applyFarolModelProviderSelection(configPath, "farol");
    const afterFirst = await fs.readFile(configPath, "utf8");

    const second = await applyFarolModelProviderSelection(configPath, "farol");
    expect(second.status).toBe("noop");
    expect(await fs.readFile(configPath, "utf8")).toBe(afterFirst);
  });

  it("reports a conflict for a foreign top-level model_provider line and never overwrites it", async () => {
    const foreign = [
      'model_provider = "openai"',
      "",
      "[unrelated]",
      "foo = 1",
      "",
    ].join("\n");
    const configPath = await disposableConfig(foreign);

    const preview = await previewFarolModelProviderSelection(
      configPath,
      "farol",
    );
    expect(preview.status).toBe("conflict");

    const result = await applyFarolModelProviderSelection(configPath, "farol");
    expect(result.status).toBe("conflict");
    expect(await fs.readFile(configPath, "utf8")).toBe(foreign);
  });

  it("rollback restores the exact previous bytes without touching the provider block", async () => {
    const configPath = await disposableConfig("[unrelated]\nfoo = 1\n");
    await applyFarolModelConfigBlock(configPath, envKeySpec);
    const withBlockOnly = await fs.readFile(configPath, "utf8");

    await applyFarolModelProviderSelection(configPath, "farol");
    expect(await fs.readFile(configPath, "utf8")).not.toBe(withBlockOnly);

    const rollback = await rollbackFarolModelProviderSelection(configPath);
    expect(rollback.status).toBe("restored");
    expect(await fs.readFile(configPath, "utf8")).toBe(withBlockOnly);
    expect(await fs.readFile(configPath, "utf8")).toContain(
      "[model_providers.farol]",
    );
  });

  it("reports no backup when nothing has been applied yet", async () => {
    const configPath = await disposableConfig("[unrelated]\nfoo = 1\n");
    const rollback = await rollbackFarolModelProviderSelection(configPath);
    expect(rollback.status).toBe("no_backup");
  });
});
