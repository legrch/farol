import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyFarolModelConfigBlock,
  previewFarolModelConfigBlock,
  rollbackFarolModelConfigBlock,
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

const spec: FarolModelProviderSpec = {
  providerName: "farol",
  profileName: "farol",
  displayName: "Farol Model",
  baseUrl: "http://127.0.0.1:54217",
  envKeyName: "FAROL_MODEL_TOKEN",
  model: "farol-model",
  wireApi: "responses",
};

describe("Farol Model managed config block", () => {
  it("installs into a config file that does not exist yet", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-model-config-"),
    );
    roots.push(root);
    const configPath = path.join(root, "sub", "config.toml");

    const preview = await previewFarolModelConfigBlock(configPath, spec);
    expect(preview.status).toBe("install");

    const result = await applyFarolModelConfigBlock(configPath, spec);
    expect(result.status).toBe("applied");
    const contents = await fs.readFile(configPath, "utf8");
    expect(contents).toContain("[model_providers.farol]");
    expect(contents).toContain('base_url = "http://127.0.0.1:54217"');
    expect(contents).toContain("[profiles.farol]");
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

    await applyFarolModelConfigBlock(configPath, spec);
    const contents = await fs.readFile(configPath, "utf8");
    expect(contents.startsWith(other.replace(/\s+$/u, ""))).toBe(true);
    expect(contents).toContain("[model_providers.farol]");
  });

  it("is idempotent: a second apply of the same spec is a no-op", async () => {
    const configPath = await disposableConfig("[unrelated]\nfoo = 1\n");
    const first = await applyFarolModelConfigBlock(configPath, spec);
    expect(first.status).toBe("applied");
    const afterFirst = await fs.readFile(configPath, "utf8");

    const second = await applyFarolModelConfigBlock(configPath, spec);
    expect(second.status).toBe("noop");
    const afterSecond = await fs.readFile(configPath, "utf8");
    expect(afterSecond).toBe(afterFirst);

    const preview = await previewFarolModelConfigBlock(configPath, spec);
    expect(preview.status).toBe("noop");
  });

  it("updates the block in place when the spec changes (e.g. a new port)", async () => {
    const configPath = await disposableConfig("[unrelated]\nfoo = 1\n");
    await applyFarolModelConfigBlock(configPath, spec);

    const changed: FarolModelProviderSpec = {
      ...spec,
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

  it("reports a conflict for a foreign entry of the same name and never overwrites it", async () => {
    const foreign = [
      "[model_providers.farol]",
      'name = "Hand written"',
      "",
    ].join("\n");
    const configPath = await disposableConfig(foreign);

    const preview = await previewFarolModelConfigBlock(configPath, spec);
    expect(preview.status).toBe("conflict");
    if (preview.status === "conflict") {
      expect(preview.conflicts[0]?.table).toBe("model_providers.farol");
    }

    const result = await applyFarolModelConfigBlock(configPath, spec);
    expect(result.status).toBe("conflict");
    const contents = await fs.readFile(configPath, "utf8");
    expect(contents).toBe(foreign);
  });

  it("declining changes nothing at all", async () => {
    const configPath = await disposableConfig("[unrelated]\nfoo = 1\n");
    const before = await fs.readFile(configPath, "utf8");
    await previewFarolModelConfigBlock(configPath, spec);
    const after = await fs.readFile(configPath, "utf8");
    expect(after).toBe(before);
  });

  it("rollback restores the exact previous bytes and mode", async () => {
    const before = "[unrelated]\nfoo = 1\n";
    const configPath = await disposableConfig(before);
    await fs.chmod(configPath, 0o640);
    const beforeMode = (await fs.stat(configPath)).mode & 0o777;

    await applyFarolModelConfigBlock(configPath, spec);
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

    await applyFarolModelConfigBlock(configPath, spec);
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
