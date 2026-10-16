import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { pollingTunnelStore } from "../e2e/lib/polling-tunnel-store.mjs";

// Actual disposable Node child/HTTP only: no Electron, Go, provider or MCP call.
it("observes and controls the original fixture in the runtime's nested state store", async () => {
  const connector = await fs.mkdtemp(
    path.join(os.tmpdir(), "farol-polling-fixture-"),
  );
  const store = pollingTunnelStore(connector);
  await fs.mkdir(store.root, { mode: 0o700 });
  const health = path.join(connector, "health-url.txt");
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(
        new URL("../e2e/connector-polling-tunnel.fixture.cjs", import.meta.url),
      ),
      "run",
      "--health.listen-addr",
      "127.0.0.1:0",
      "--health.url-file",
      health,
      "--pid.file",
      path.join(connector, "pid"),
    ],
    { env: { TUNNEL_CLIENT_STATE_DIR: store.root }, stdio: "ignore" },
  );
  const ended = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  let quitRequested = false;
  try {
    let url;
    const until = Date.now() + 5000;
    while (!url && Date.now() < until) {
      try {
        url = (await fs.readFile(health, "utf8")).trim();
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (!url) await delay(10);
    }
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:[1-9][0-9]*\/$/u);
    expect(
      (await fetch(url + "readyz", { signal: AbortSignal.timeout(2000) }))
        .status,
    ).toBe(200);
    let count = 0;
    for (const mode of [
      "recent",
      "stale",
      "no_success",
      "missing",
      "http503",
      "http504",
    ]) {
      await store.control(mode);
      const response = await fetch(url + "metrics", {
        signal: AbortSignal.timeout(2000),
      });
      const text = await response.text();
      expect(response.status).toBe(
        mode.startsWith("http") ? Number(mode.slice(4)) : 200,
      );
      if (mode === "no_success")
        expect(text).toContain(
          "commands_poll_last_successful_timestamp_seconds 0\n",
        );
      if (mode === "missing") expect(text).toBe("unrelated_metric 1\n");
      const records = await store.receipts();
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        pid: child.pid,
        phase: "running",
        readyRequests: 1,
        metricsRequests: ++count,
        lastMode: mode,
      });
    }
    await store.control("hold");
    const pending = fetch(url + "metrics", {
      signal: AbortSignal.timeout(200),
    }).then(
      () => "unexpected-response",
      () => "aborted",
    );
    expect(await pending).toBe("aborted");
    expect((await store.receipts())[0]).toMatchObject({
      metricsRequests: 7,
      lastMode: "hold",
    });
    quitRequested = true;
    expect(child.kill("SIGTERM")).toBe(true);
    expect(await ended).toEqual({ code: 0, signal: null });
    expect((await store.receipts())[0]).toMatchObject({
      pid: child.pid,
      phase: "exited",
      exitCode: 0,
    });
    expect(
      (await fs.readdir(connector)).some((name) => name.startsWith("polling-")),
    ).toBe(false);
  } finally {
    if (
      !quitRequested &&
      child.exitCode === null &&
      child.signalCode === null
    ) {
      child.kill("SIGTERM");
      await ended;
    }
  }
}, 15000);
