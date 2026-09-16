import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { launchCodexAppServer } from "../../src/apps/desktop/codex-app-server-process";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("Codex App Server process", () => {
  it("launches the selected executable with a minimal environment and initializes stdio", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-codex-process-"),
    );
    roots.push(root);
    const executablePath = path.join(root, "codex-fixture");
    await fs.writeFile(
      executablePath,
      `#!${process.execPath}
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ id: message.id, result: { userAgent: "codex-fixture/1" } }) + "\\n");
  } else if (message.method === "model/list") {
    process.stdout.write(JSON.stringify({ id: message.id, result: { data: [{ id: "gpt-6-astra" }], inheritedApiKey: Object.hasOwn(process.env, "OPENAI_API_KEY") } }) + "\\n");
  }
});
`,
      { mode: 0o700 },
    );

    const client = await launchCodexAppServer({
      executablePath,
      cwd: root,
      homePath: root,
      tempPath: os.tmpdir(),
      clientVersion: "0.1.0-preview.0",
    });
    await expect(client.request("model/list", {})).resolves.toEqual({
      data: [{ id: "gpt-6-astra" }],
      inheritedApiKey: false,
    });
    await client.close();
  });
});
