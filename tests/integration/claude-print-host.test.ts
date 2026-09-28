import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { SandboxedClaudePrintHost } from "../../src/modules/chat/infra/native/sandboxed-claude-print-host";
import type { ClaudeRequest } from "../../src/modules/chat/app/port/claude-handoff";
const request: ClaudeRequest = {
  key: "019b0000-0000-4000-8000-000000000020",
  workspaceId: "writer",
  projectId: "project",
  message: "Fixture only",
  modelBinding: {
    selection: {
      harness: "claude-code",
      modelAlias: "small",
      model: "fixture-model",
      effort: "medium",
    },
    configSha256: "a".repeat(64),
  },
};
it("trusted fixed CLI arguments use the existing sandbox port; no bare/bg/bypass/fallback", async () => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "farol-claude-host-")),
  );
  try {
    const file = path.join(root, "fixture-host");
    const source = "#!/bin/sh\nexit 0\n";
    await fs.writeFile(file, source, { mode: 0o700 });
    let seen: unknown;
    const selection = {
      qualification: "fixture-only" as const,
      executablePath: file,
      executableSha256: createHash("sha256").update(source).digest("hex"),
      models: [{ model: "fixture-model", efforts: ["medium"] }],
    };
    const runner = {
      async start(value: unknown) {
        seen = value;
        return "owned";
      },
      async read() {
        return {
          state: "running" as const,
          stdout: "",
          exitCode: null,
          exitSignal: null,
          groupCleanup: "pending" as const,
          truncated: false,
          interrupted: false,
        };
      },
    };
    const host = new SandboxedClaudePrintHost(selection, runner, 100, () => 1);
    expect(await host.supports(request.modelBinding)).toBe(true);
    expect(await host.start(request, {} as never)).toBe("owned");
    expect(seen).toMatchObject({
      stdin: "Fixture only\n",
      deadlineAt: 100,
      command: expect.stringContaining("'--session-id' '" + request.key + "'"),
    });
    const command = (seen as { command: string }).command;
    expect(command).toContain("'--permission-prompts' 'none'");
    for (const forbidden of [
      "--bg",
      "--bare",
      "--resume",
      "--fallback-model",
      "bypassPermissions",
    ])
      expect(command).not.toContain(forbidden);
    expect(await host.read("owned")).toMatchObject({ state: "running" });
    expect(
      await host.supports({
        ...request.modelBinding,
        selection: { ...request.modelBinding.selection, model: "unsupported" },
      }),
    ).toBe(false);
    expect(
      await host.supports({
        ...request.modelBinding,
        selection: { ...request.modelBinding.selection, effort: "unsupported" },
      }),
    ).toBe(false);
    await fs.writeFile(file, source + "# replaced\n");
    expect(await host.supports(request.modelBinding)).toBe(false);
    await expect(host.start(request, {} as never)).rejects.toThrow();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
