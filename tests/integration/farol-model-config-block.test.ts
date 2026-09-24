import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  FAROL_MODEL_HOST_TUNING,
  FAROL_MODEL_TOKEN_PLACEHOLDER,
  applyFarolModelConfigBlock,
  applyFarolModelProviderSelection,
  previewFarolModelConfigBlock,
  previewFarolModelProviderSelection,
  rollbackFarolModelConfigBlock,
  rollbackFarolModelProviderSelection,
  type FarolModelProviderSelection,
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

async function disposableRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-model-config-"));
  roots.push(root);
  return root;
}

async function disposableConfig(initial?: string): Promise<string> {
  const configPath = path.join(await disposableRoot(), "config.toml");
  if (initial !== undefined) {
    await fs.writeFile(configPath, initial, { mode: 0o644 });
  }
  return configPath;
}

async function exists(target: string): Promise<boolean> {
  return fs.lstat(target).then(
    () => true,
    () => false,
  );
}

// The provider-local default alias, not an exact upstream version pin.
const MODEL = "chatgpt";

const envKeySpec: FarolModelProviderSpec = {
  providerName: "farol",
  displayName: "Farol",
  baseUrl: "http://127.0.0.1:54217",
  model: MODEL,
  wireApi: "responses",
  delivery: { mode: "env-key", envKeyName: "FAROL_MODEL_TOKEN" },
};

const bearerTokenSpec: FarolModelProviderSpec = {
  ...envKeySpec,
  delivery: { mode: "bearer-token", token: "s3cr3t-token" },
};

const selection: FarolModelProviderSelection = {
  providerName: "farol",
  model: MODEL,
};

const BLOCK_BEGIN = "# BEGIN FAROL MANAGED BLOCK — do not edit by hand";
const BLOCK_END = "# END FAROL MANAGED BLOCK";
const SELECTION_BEGIN =
  "# BEGIN FAROL MANAGED MODEL_PROVIDER SELECTION — do not edit by hand";
const SELECTION_END = "# END FAROL MANAGED MODEL_PROVIDER SELECTION";

/** The exact block text the module must write for `spec`. */
function blockFor(spec: FarolModelProviderSpec): string {
  return [
    BLOCK_BEGIN,
    `[model_providers.${spec.providerName}]`,
    `name = "${spec.displayName}"`,
    `base_url = "${spec.baseUrl}"`,
    spec.delivery.mode === "env-key"
      ? `env_key = "${spec.delivery.envKeyName}"`
      : `experimental_bearer_token = "${spec.delivery.token}"`,
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "request_max_retries = 0",
    "stream_max_retries = 0",
    "stream_idle_timeout_ms = 120000",
    BLOCK_END,
  ].join("\n");
}

function selectionFor(target: FarolModelProviderSelection): string {
  return [
    SELECTION_BEGIN,
    `model_provider = "${target.providerName}"`,
    `model = "${target.model}"`,
    SELECTION_END,
  ].join("\n");
}

describe("Farol Model managed provider block", () => {
  it("previews and updates only owned route fields without relabelling foreign state", async () => {
    const unrelated = '[unrelated]\nlabel = "farol-next/chatgpt"\n';
    const configPath = await disposableConfig(unrelated);
    const oldSpec = {
      ...envKeySpec,
      providerName: "farol_next",
      displayName: "Farol Next",
      model: "farol-next/chatgpt",
    };
    await applyFarolModelConfigBlock(configPath, oldSpec);
    await applyFarolModelProviderSelection(configPath, oldSpec);
    const before = await fs.readFile(configPath, "utf8");
    const blockPreview = await previewFarolModelConfigBlock(
      configPath,
      envKeySpec,
    );
    const selectionPreview = await previewFarolModelProviderSelection(
      configPath,
      selection,
    );
    expect(blockPreview.status).toBe("update");
    expect(selectionPreview.status).toBe("update");
    expect(await fs.readFile(configPath, "utf8")).toBe(before);
    await applyFarolModelConfigBlock(configPath, envKeySpec);
    await applyFarolModelProviderSelection(configPath, selection);
    const updated = await fs.readFile(configPath, "utf8");
    expect(updated).toContain('model_provider = "farol"');
    expect(updated).toContain('model = "chatgpt"');
    expect(updated).toContain("[model_providers.farol]");
    expect(updated).not.toContain("[model_providers.farol_next]");
    expect(updated).toContain(unrelated);
    await rollbackFarolModelProviderSelection(configPath);
    await rollbackFarolModelConfigBlock(configPath);
    expect(await fs.readFile(configPath, "utf8")).toBe(unrelated);
  });

  it("installs into a config file that does not exist yet, and never writes a profile", async () => {
    const configPath = path.join(await disposableRoot(), "sub", "config.toml");

    const preview = await previewFarolModelConfigBlock(configPath, envKeySpec);
    expect(preview.status).toBe("install");

    const result = await applyFarolModelConfigBlock(configPath, envKeySpec);
    expect(result.status).toBe("applied");
    const contents = await fs.readFile(configPath, "utf8");
    expect(contents).toBe(`${blockFor(envKeySpec)}\n`);
    expect(contents).toContain("[model_providers.farol]");
    expect(contents).toContain('base_url = "http://127.0.0.1:54217"');
    expect(contents).toContain('env_key = "FAROL_MODEL_TOKEN"');
    expect(contents).not.toContain("[profiles.");
    expect(contents).not.toContain("experimental_bearer_token");
  });

  it("pins the host retry contract in the block: no openai auth, no request or stream retries, a 120 s idle timeout (P1-3)", async () => {
    const configPath = await disposableConfig("[unrelated]\nfoo = 1\n");
    await applyFarolModelConfigBlock(configPath, envKeySpec);
    const contents = await fs.readFile(configPath, "utf8");
    const block = contents.slice(
      contents.indexOf(BLOCK_BEGIN),
      contents.indexOf(BLOCK_END),
    );
    const lines = block.split("\n");
    expect(lines).toContain("requires_openai_auth = false");
    expect(lines).toContain("request_max_retries = 0");
    expect(lines).toContain("stream_max_retries = 0");
    expect(lines).toContain("stream_idle_timeout_ms = 120000");
    // The same values Farol's own internally launched host is given.
    expect(FAROL_MODEL_HOST_TUNING).toEqual({
      requiresOpenAiAuth: false,
      requestMaxRetries: 0,
      streamMaxRetries: 0,
      streamIdleTimeoutMs: 120_000,
    });
  });

  it("preserves every other byte exactly: the block is appended after one separator line, nothing is trimmed", async () => {
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
    expect(contents).toBe(`${other}\n${blockFor(envKeySpec)}\n`);

    const rollback = await rollbackFarolModelConfigBlock(configPath);
    expect(rollback.status).toBe("restored");
    expect(await fs.readFile(configPath, "utf8")).toBe(other);
  });

  it("preserves a file with no trailing newline, and a CRLF file, byte for byte through apply and rollback", async () => {
    const noNewline = await disposableConfig("a = 1");
    await applyFarolModelConfigBlock(noNewline, envKeySpec);
    expect(await fs.readFile(noNewline, "utf8")).toBe(
      `a = 1\n${blockFor(envKeySpec)}\n`,
    );
    await rollbackFarolModelConfigBlock(noNewline);
    expect(await fs.readFile(noNewline, "utf8")).toBe("a = 1");

    const crlf = await disposableConfig("a = 1\r\nb = 2\r\n");
    await applyFarolModelConfigBlock(crlf, envKeySpec);
    expect(await fs.readFile(crlf, "utf8")).toBe(
      `a = 1\r\nb = 2\r\n\n${blockFor(envKeySpec)}\n`,
    );
    await rollbackFarolModelConfigBlock(crlf);
    expect(await fs.readFile(crlf, "utf8")).toBe("a = 1\r\nb = 2\r\n");
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

  it("updates the block in place when the spec changes (e.g. a new port), leaving what follows it where it was", async () => {
    const configPath = await disposableConfig("[unrelated]\nfoo = 1\n");
    await applyFarolModelConfigBlock(configPath, envKeySpec);
    const ownerAddition = '[mcp_servers.x]\ncommand = "y"\n';
    await fs.appendFile(configPath, ownerAddition);

    const changed: FarolModelProviderSpec = {
      ...envKeySpec,
      baseUrl: "http://127.0.0.1:9999",
    };
    const preview = await previewFarolModelConfigBlock(configPath, changed);
    expect(preview.status).toBe("update");

    const result = await applyFarolModelConfigBlock(configPath, changed);
    expect(result.status).toBe("applied");
    const contents = await fs.readFile(configPath, "utf8");
    expect(contents).toBe(
      `[unrelated]\nfoo = 1\n\n${blockFor(changed)}\n${ownerAddition}`,
    );
    expect(contents).not.toContain("54217");
    // Still exactly one managed block.
    expect(contents.match(/BEGIN FAROL MANAGED BLOCK/gu)?.length).toBe(1);
  });

  it("rotating the token (bearer-token delivery) rewrites the block and is still idempotent", async () => {
    const configPath = path.join(await disposableRoot(), "config.toml");

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

  it("redacts every bearer-token literal from the preview diff and says that it did", async () => {
    const configPath = path.join(await disposableRoot(), "config.toml");
    const install = await previewFarolModelConfigBlock(
      configPath,
      bearerTokenSpec,
    );
    expect(install.status).toBe("install");
    if (install.status !== "install") return;
    expect(install.diff).not.toContain("s3cr3t-token");
    expect(install.diff).toContain(
      `+experimental_bearer_token = "${FAROL_MODEL_TOKEN_PLACEHOLDER}"`,
    );
    expect(install.tokenRedacted).toBe(true);

    await applyFarolModelConfigBlock(configPath, bearerTokenSpec);
    const rotated: FarolModelProviderSpec = {
      ...bearerTokenSpec,
      delivery: { mode: "bearer-token", token: "rotated-token" },
    };
    const update = await previewFarolModelConfigBlock(configPath, rotated);
    expect(update.status).toBe("update");
    if (update.status !== "update") return;
    // Neither the old literal (a "-" line) nor the new one (a "+" line).
    expect(update.diff).not.toContain("s3cr3t-token");
    expect(update.diff).not.toContain("rotated-token");
    expect(update.diff).toContain("experimental_bearer_token");
    expect(update.tokenRedacted).toBe(true);

    const envKey = await previewFarolModelConfigBlock(
      path.join(await disposableRoot(), "config.toml"),
      envKeySpec,
    );
    expect(envKey.status).toBe("install");
    if (envKey.status === "install") {
      expect(envKey.tokenRedacted).toBe(false);
      expect(envKey.diff).toContain('+env_key = "FAROL_MODEL_TOKEN"');
    }
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

  describe("detects every spelling of a foreign provider entry and leaves the file byte-identical (P2-2)", () => {
    const providerForms: readonly [string, string][] = [
      [
        "[model_providers] table with an inline farol entry",
        '[model_providers]\nfarol = { name = "x", base_url = "http://h" }\n',
      ],
      [
        "root-level dotted key",
        'model_providers.farol.base_url = "http://h"\n',
      ],
      [
        "quoted header (basic string)",
        '[model_providers."farol"]\nname = "x"\n',
      ],
      [
        "quoted header (literal string)",
        "[model_providers.'farol']\nname = \"x\"\n",
      ],
      ["spaced header", '[ model_providers . farol ]\nname = "x"\n'],
      [
        "header with a trailing comment",
        '[model_providers.farol] # hand written\nname = "x"\n',
      ],
      ["array-of-tables header", '[[model_providers.farol]]\nname = "x"\n'],
      [
        "[model_providers] table with a dotted quoted key",
        '[model_providers]\n"farol".name = "x"\n',
      ],
      [
        "root-level inline table nesting farol",
        'model_providers = { farol = { name = "x" } }\n',
      ],
      [
        "sub-table header under farol",
        "[model_providers.farol.extra]\nk = 1\n",
      ],
    ];

    it.each(providerForms)("%s", async (_name, foreign) => {
      const configPath = await disposableConfig(foreign);
      const preview = await previewFarolModelConfigBlock(
        configPath,
        envKeySpec,
      );
      expect(preview.status).toBe("conflict");
      if (preview.status === "conflict") {
        expect(preview.conflicts.length).toBeGreaterThan(0);
        expect(
          preview.conflicts[0]?.table.startsWith("model_providers.farol"),
        ).toBe(true);
      }
      const result = await applyFarolModelConfigBlock(configPath, envKeySpec);
      expect(result.status).toBe("conflict");
      expect(await fs.readFile(configPath)).toEqual(Buffer.from(foreign));
    });

    it.each([
      ["a different provider", '[model_providers.openai]\nname = "OpenAI"\n'],
      [
        "a name that merely shares the prefix",
        '[model_providers.farolx]\nname = "x"\n',
      ],
      [
        "farol under an unrelated table",
        '[mcp_servers]\nfarol = { command = "x" }\n',
      ],
    ])("does not mistake %s for a conflict", async (_name, benign) => {
      const configPath = await disposableConfig(benign);
      const preview = await previewFarolModelConfigBlock(
        configPath,
        envKeySpec,
      );
      expect(preview.status).toBe("install");
    });
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
    const configPath = path.join(await disposableRoot(), "config.toml");
    const result = await applyFarolModelConfigBlock(
      configPath,
      bearerTokenSpec,
    );
    expect(result.status).toBe("applied");
    expect((await fs.stat(configPath)).mode & 0o777).toBe(0o600);
  });

  it("refuses a symlinked config.toml with a closed status and never writes through it", async () => {
    const root = await disposableRoot();
    const target = path.join(root, "real.toml");
    await fs.writeFile(target, "[unrelated]\nfoo = 1\n", { mode: 0o600 });
    const configPath = path.join(root, "config.toml");
    await fs.symlink(target, configPath);

    expect(
      (await previewFarolModelConfigBlock(configPath, envKeySpec)).status,
    ).toBe("symlink");
    expect(
      (await applyFarolModelConfigBlock(configPath, envKeySpec)).status,
    ).toBe("symlink");
    expect(
      (await previewFarolModelProviderSelection(configPath, selection)).status,
    ).toBe("symlink");
    expect(
      (await applyFarolModelProviderSelection(configPath, selection)).status,
    ).toBe("symlink");
    expect((await rollbackFarolModelConfigBlock(configPath)).status).toBe(
      "symlink",
    );
    expect((await rollbackFarolModelProviderSelection(configPath)).status).toBe(
      "symlink",
    );
    expect((await fs.lstat(configPath)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(target, "utf8")).toBe("[unrelated]\nfoo = 1\n");
  });

  it("writes the backup atomically and never through a symlink planted at the backup path", async () => {
    const root = await disposableRoot();
    const victim = path.join(root, "victim");
    await fs.writeFile(victim, "do not touch", { mode: 0o600 });
    const configPath = path.join(root, "config.toml");
    await fs.writeFile(configPath, "[unrelated]\nfoo = 1\n", { mode: 0o644 });
    await fs.symlink(victim, `${configPath}.farol-backup`);

    const result = await applyFarolModelConfigBlock(configPath, envKeySpec);
    expect(result.status).toBe("applied");
    expect(await fs.readFile(victim, "utf8")).toBe("do not touch");
    const backup = await fs.lstat(`${configPath}.farol-backup`);
    expect(backup.isSymbolicLink()).toBe(false);
    expect(backup.isFile()).toBe(true);
    expect(backup.mode & 0o777).toBe(0o600);
    expect(await fs.readFile(`${configPath}.farol-backup`, "utf8")).toBe(
      "[unrelated]\nfoo = 1\n",
    );
    // No stray temporary file is left behind.
    const leftovers = (await fs.readdir(root)).filter((name) =>
      name.endsWith(".tmp"),
    );
    expect(leftovers).toEqual([]);
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
    const configPath = path.join(await disposableRoot(), "config.toml");

    await applyFarolModelConfigBlock(configPath, envKeySpec);
    expect(await exists(configPath)).toBe(true);

    await rollbackFarolModelConfigBlock(configPath);
    await expect(fs.stat(configPath)).rejects.toThrow();
  });

  it("rollback removes exactly the managed region and keeps what the owner added afterwards (P2-3)", async () => {
    const before = "[unrelated]\nfoo = 1\n";
    const configPath = await disposableConfig(before);
    await applyFarolModelConfigBlock(configPath, envKeySpec);
    const ownerAddition = '[mcp_servers.x]\ncommand = "y"\n';
    await fs.appendFile(configPath, ownerAddition);

    const rollback = await rollbackFarolModelConfigBlock(configPath);
    expect(rollback.status).toBe("restored");
    expect(await fs.readFile(configPath, "utf8")).toBe(
      `${before}${ownerAddition}`,
    );
  });

  it("apply(A) then apply(B) then rollback equals the pre-Farol bytes (P2-3)", async () => {
    const before = "[unrelated]\nfoo = 1\n";
    const configPath = await disposableConfig(before);
    await applyFarolModelConfigBlock(configPath, envKeySpec);
    await applyFarolModelConfigBlock(configPath, {
      ...envKeySpec,
      baseUrl: "http://127.0.0.1:9999",
    });
    expect(await fs.readFile(configPath, "utf8")).toContain("9999");

    const rollback = await rollbackFarolModelConfigBlock(configPath);
    expect(rollback.status).toBe("restored");
    expect(await fs.readFile(configPath, "utf8")).toBe(before);
  });

  it("rollback never restores from the backup: a tampered backup changes nothing about the result (P2-3)", async () => {
    const before = "[unrelated]\nfoo = 1\n";
    const configPath = await disposableConfig(before);
    await applyFarolModelConfigBlock(configPath, envKeySpec);
    await fs.writeFile(`${configPath}.farol-backup`, "[tampered]\nx = 1\n", {
      mode: 0o600,
    });

    const rollback = await rollbackFarolModelConfigBlock(configPath);
    expect(rollback.status).toBe("restored");
    expect(await fs.readFile(configPath, "utf8")).toBe(before);
  });

  it("refuses to roll back when the END marker is missing, leaving the file unchanged (P2-3)", async () => {
    const configPath = await disposableConfig("[unrelated]\nfoo = 1\n");
    await applyFarolModelConfigBlock(configPath, envKeySpec);
    const torn = (await fs.readFile(configPath, "utf8")).replace(
      `${BLOCK_END}\n`,
      "",
    );
    await fs.writeFile(configPath, torn);

    const rollback = await rollbackFarolModelConfigBlock(configPath);
    expect(rollback.status).toBe("malformed");
    expect(await fs.readFile(configPath, "utf8")).toBe(torn);

    // Neither preview nor apply will touch a torn region either.
    expect(
      (await previewFarolModelConfigBlock(configPath, envKeySpec)).status,
    ).toBe("malformed");
    expect(
      (await applyFarolModelConfigBlock(configPath, envKeySpec)).status,
    ).toBe("malformed");
    expect(await fs.readFile(configPath, "utf8")).toBe(torn);
  });

  it("refuses a marker that was moved off its own line or duplicated", async () => {
    const configPath = await disposableConfig("[unrelated]\nfoo = 1\n");
    await applyFarolModelConfigBlock(configPath, envKeySpec);
    const applied = await fs.readFile(configPath, "utf8");

    await fs.writeFile(
      configPath,
      applied.replace(`\n${BLOCK_BEGIN}`, ` ${BLOCK_BEGIN}`),
    );
    expect((await rollbackFarolModelConfigBlock(configPath)).status).toBe(
      "malformed",
    );

    await fs.writeFile(configPath, `${applied}${BLOCK_BEGIN}\n`);
    expect((await rollbackFarolModelConfigBlock(configPath)).status).toBe(
      "malformed",
    );
  });

  it("reports not_present when nothing has been applied yet", async () => {
    const configPath = await disposableConfig("[unrelated]\nfoo = 1\n");
    const rollback = await rollbackFarolModelConfigBlock(configPath);
    expect(rollback.status).toBe("not_present");
    expect(await fs.readFile(configPath, "utf8")).toBe(
      "[unrelated]\nfoo = 1\n",
    );
  });
});

describe("Farol Model provider selection (separate consent)", () => {
  it("is not written unless applied separately, even after the provider block is installed", async () => {
    const configPath = await disposableConfig("[unrelated]\nfoo = 1\n");
    await applyFarolModelConfigBlock(configPath, envKeySpec);
    const contents = await fs.readFile(configPath, "utf8");
    expect(contents).not.toContain("model_provider =");
    expect(contents).not.toMatch(/^model = /mu);
  });

  it("writes both model_provider and model inside one consented region, before the first table header (P1-1)", async () => {
    const configPath = await disposableConfig("[unrelated]\nfoo = 1\n");
    await applyFarolModelConfigBlock(configPath, envKeySpec);

    const preview = await previewFarolModelProviderSelection(
      configPath,
      selection,
    );
    expect(preview.status).toBe("install");
    if (preview.status === "install") {
      expect(preview.diff).toContain('+model_provider = "farol"');
      expect(preview.diff).toContain(`+model = "${MODEL}"`);
    }

    const applied = await applyFarolModelProviderSelection(
      configPath,
      selection,
    );
    expect(applied.status).toBe("applied");

    const contents = await fs.readFile(configPath, "utf8");
    expect(contents).toBe(
      `${selectionFor(selection)}\n[unrelated]\nfoo = 1\n\n${blockFor(envKeySpec)}\n`,
    );
    const region = contents.slice(
      contents.indexOf(SELECTION_BEGIN),
      contents.indexOf(SELECTION_END),
    );
    expect(region.split("\n")).toContain('model_provider = "farol"');
    expect(region.split("\n")).toContain(`model = "${MODEL}"`);
    expect(contents.indexOf("model_provider =")).toBeLessThan(
      contents.indexOf("["),
    );
  });

  it("goes in front of the provider block, never inside it, when the block is the first table in the file", async () => {
    const configPath = path.join(await disposableRoot(), "config.toml");
    await applyFarolModelConfigBlock(configPath, envKeySpec);
    const applied = await applyFarolModelProviderSelection(
      configPath,
      selection,
    );
    expect(applied.status).toBe("applied");

    const contents = await fs.readFile(configPath, "utf8");
    // At offset 0 a region owns no leading separator, so the two regions
    // stand back to back; each is still exactly removable on its own.
    expect(contents).toBe(
      `${selectionFor(selection)}\n${blockFor(envKeySpec)}\n`,
    );
    expect(contents.indexOf(SELECTION_END)).toBeLessThan(
      contents.indexOf(BLOCK_BEGIN),
    );

    // A block re-apply (a port change) leaves the selection where it is.
    await applyFarolModelConfigBlock(configPath, {
      ...envKeySpec,
      baseUrl: "http://127.0.0.1:9999",
    });
    const rewritten = await fs.readFile(configPath, "utf8");
    expect(
      rewritten.startsWith(`${selectionFor(selection)}\n${BLOCK_BEGIN}`),
    ).toBe(true);
    expect(rewritten).toContain("9999");
  });

  it("is idempotent, and updates in place when the model changes", async () => {
    const configPath = await disposableConfig("[unrelated]\nfoo = 1\n");
    await applyFarolModelConfigBlock(configPath, envKeySpec);
    await applyFarolModelProviderSelection(configPath, selection);
    const afterFirst = await fs.readFile(configPath, "utf8");

    const second = await applyFarolModelProviderSelection(
      configPath,
      selection,
    );
    expect(second.status).toBe("noop");
    expect(await fs.readFile(configPath, "utf8")).toBe(afterFirst);

    const changed = { ...selection, model: "farol-next/other" };
    const preview = await previewFarolModelProviderSelection(
      configPath,
      changed,
    );
    expect(preview.status).toBe("update");
    await applyFarolModelProviderSelection(configPath, changed);
    const contents = await fs.readFile(configPath, "utf8");
    expect(contents).toBe(
      `${selectionFor(changed)}\n[unrelated]\nfoo = 1\n\n${blockFor(envKeySpec)}\n`,
    );
    expect(
      contents.match(/BEGIN FAROL MANAGED MODEL_PROVIDER SELECTION/gu)?.length,
    ).toBe(1);
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
      selection,
    );
    expect(preview.status).toBe("conflict");

    const result = await applyFarolModelProviderSelection(
      configPath,
      selection,
    );
    expect(result.status).toBe("conflict");
    expect(await fs.readFile(configPath, "utf8")).toBe(foreign);
  });

  describe("detects every spelling of a foreign root-table model_provider or model key (P2-2)", () => {
    it.each([
      ["bare model_provider", 'model_provider = "openai"\n[t]\nk = 1\n'],
      ["bare model", 'model = "gpt-5"\n[t]\nk = 1\n'],
      ["quoted model_provider", '"model_provider" = "openai"\n'],
      ["literal-quoted model", "'model' = \"gpt-5\"\n"],
      ["no spaces and a trailing comment", 'model_provider="openai" # mine\n'],
      ["dotted model key", "model.name = 1\n"],
    ])("%s", async (_name, foreign) => {
      const configPath = await disposableConfig(foreign);
      const preview = await previewFarolModelProviderSelection(
        configPath,
        selection,
      );
      expect(preview.status).toBe("conflict");
      const result = await applyFarolModelProviderSelection(
        configPath,
        selection,
      );
      expect(result.status).toBe("conflict");
      expect(await fs.readFile(configPath)).toEqual(Buffer.from(foreign));
    });

    it.each([
      ["model inside a profile table", '[profiles.work]\nmodel = "gpt-5"\n'],
      ["model_provider inside a table", '[t]\nmodel_provider = "openai"\n'],
      [
        "a key that merely shares the prefix",
        'model_reasoning_effort = "high"\n',
      ],
    ])("does not mistake %s for a conflict", async (_name, benign) => {
      const configPath = await disposableConfig(benign);
      const preview = await previewFarolModelProviderSelection(
        configPath,
        selection,
      );
      expect(preview.status).toBe("install");
    });
  });

  it("rollback removes exactly the selection region without touching the provider block", async () => {
    const configPath = await disposableConfig("[unrelated]\nfoo = 1\n");
    await applyFarolModelConfigBlock(configPath, envKeySpec);
    const withBlockOnly = await fs.readFile(configPath, "utf8");

    await applyFarolModelProviderSelection(configPath, selection);
    expect(await fs.readFile(configPath, "utf8")).not.toBe(withBlockOnly);

    const rollback = await rollbackFarolModelProviderSelection(configPath);
    expect(rollback.status).toBe("restored");
    expect(await fs.readFile(configPath, "utf8")).toBe(withBlockOnly);
    expect(await fs.readFile(configPath, "utf8")).toContain(
      "[model_providers.farol]",
    );
  });

  it("both regions roll back to the exact pre-Farol bytes in either order, or to no file at all", async () => {
    const before = "[unrelated]\nfoo = 1\n";
    for (const selectionFirst of [true, false]) {
      const configPath = await disposableConfig(before);
      await applyFarolModelConfigBlock(configPath, envKeySpec);
      await applyFarolModelProviderSelection(configPath, selection);
      if (selectionFirst) {
        await rollbackFarolModelProviderSelection(configPath);
        await rollbackFarolModelConfigBlock(configPath);
      } else {
        await rollbackFarolModelConfigBlock(configPath);
        await rollbackFarolModelProviderSelection(configPath);
      }
      expect(await fs.readFile(configPath, "utf8")).toBe(before);
    }

    const created = path.join(await disposableRoot(), "config.toml");
    await applyFarolModelConfigBlock(created, envKeySpec);
    await applyFarolModelProviderSelection(created, selection);
    await rollbackFarolModelProviderSelection(created);
    await rollbackFarolModelConfigBlock(created);
    expect(await exists(created)).toBe(false);
  });

  it("lifts a selection an earlier build nested inside the provider block back out on the next block apply", async () => {
    // The layout HEAD's insert-before-first-table produced for a fresh
    // file: the selection landed between the block's BEGIN marker and its
    // own table header.
    const block = blockFor(envKeySpec).split("\n");
    const legacy = [
      block[0],
      "",
      selectionFor(selection),
      "",
      ...block.slice(1),
      "",
    ].join("\n");
    const configPath = await disposableConfig(legacy);

    const applied = await applyFarolModelConfigBlock(configPath, envKeySpec);
    expect(applied.status).toBe("applied");
    const contents = await fs.readFile(configPath, "utf8");
    expect(contents).toBe(
      `${selectionFor(selection)}\n${blockFor(envKeySpec)}\n`,
    );

    // Each region is now independently removable, in either order.
    expect((await rollbackFarolModelProviderSelection(configPath)).status).toBe(
      "restored",
    );
    expect(await fs.readFile(configPath, "utf8")).toBe(
      `${blockFor(envKeySpec)}\n`,
    );
  });

  it("reports not_present when nothing has been applied yet", async () => {
    const configPath = await disposableConfig("[unrelated]\nfoo = 1\n");
    const rollback = await rollbackFarolModelProviderSelection(configPath);
    expect(rollback.status).toBe("not_present");
  });
});
