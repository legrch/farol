import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { SecureMcpConnectorRuntime } from "../../src/apps/desktop/secure-mcp-connector-runtime";

const execute = promisify(execFile);

it.skipIf(process.platform !== "darwin")(
  "keeps one owned connector outside the terminal foreground process group",
  async () => {
    // Local signal/file fixture only: no sockets, accounts or live tunnel client.
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "farol-connector-group-")),
    );
    const executable = path.join(root, "local-child.cjs");
    await fs.writeFile(
      executable,
      `#!${process.execPath}\n` +
        'const fs = require("node:fs");\n' +
        "const option = (name) => process.argv[process.argv.indexOf(name) + 1];\n" +
        'fs.writeFileSync(option("--pid.file"), String(process.pid));\n' +
        'fs.writeFileSync(option("--health.url-file"), "http://127.0.0.1:41329\\n");\n' +
        'process.on("SIGTERM", () => process.exit(0));\n' +
        "setInterval(() => {}, 1000);\n",
      { mode: 0o700 },
    );
    const runtimeRoot = path.join(root, "connector");
    const runtime = new SecureMcpConnectorRuntime(
      { root: runtimeRoot, homePath: root, tempPath: root },
      { get: async () => true },
    );
    let stopAttempted = false;
    let stopped = false;
    try {
      const result = await runtime.start({
        executablePath: executable,
        executableSha256: "a".repeat(64),
        connectorGeneration: 1,
        computerGeneration: 1,
        buildId: "b".repeat(64),
        launchContractSha256: "c".repeat(64),
      });
      expect(result.state).toBe("ready");
      const pid = Number(
        await fs.readFile(
          path.join(runtimeRoot, "runtime/tunnel-client.pid"),
          "utf8",
        ),
      );
      expect(Number.isSafeInteger(pid) && pid > 1).toBe(true);
      const group = async (selected: number) =>
        Number(
          (
            await execute("/bin/ps", ["-p", String(selected), "-o", "pgid="])
          ).stdout.trim(),
        );
      expect(await group(pid)).toBe(pid);
      expect(await group(pid)).not.toBe(await group(process.pid));
      // Direct stop is still tracked through the same ChildProcess terminal event.
      stopAttempted = true;
      await runtime.stop();
      stopped = true;
      expect(runtime.isRunning()).toBe(false);
    } finally {
      if (!stopAttempted) {
        stopAttempted = true;
        await runtime.stop();
        stopped = true;
      }
      if (stopped) await fs.rm(root, { recursive: true, force: true });
    }
  },
);
