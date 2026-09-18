import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ROUTE_B_CHECK_PROMPT,
  runRouteBHostCheck,
} from "../../src/apps/desktop/route-b-host-check";

let root = "";

afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
});

async function runtimeRoot(): Promise<string> {
  root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "farol-next-route-b-check-")),
  );
  return root;
}

const endpoint = {
  baseUrl: "http://127.0.0.1:43111/v1",
  token: "route-b-token-that-is-long-enough",
};

describe("Route B host check", () => {
  it("launches an isolated host on the Route B endpoint and runs one harmless turn", async () => {
    const runtime = await runtimeRoot();
    const close = vi.fn(async () => undefined);
    const launch = vi.fn(async () => ({ close }));
    const route = vi.fn(async () => ({
      threadId: "thread-check",
      turnId: "turn-check",
      deltaCount: 1,
      observedCharacters: 5,
    }));

    await expect(
      runRouteBHostCheck(
        {
          executablePath: "/usr/local/bin/codex",
          runtimeRoot: runtime,
          homePath: "/Users/example",
          tempPath: os.tmpdir(),
          clientVersion: "0.1.0-preview.0",
          endpoint,
        },
        { launch, route },
      ),
    ).resolves.toEqual({
      status: "completed",
      deltaCount: 1,
      observedCharacters: 5,
    });
    // The host's Codex home is Next's private directory, never the owner's.
    expect(launch).toHaveBeenCalledWith({
      executablePath: "/usr/local/bin/codex",
      cwd: runtime,
      homePath: "/Users/example",
      tempPath: os.tmpdir(),
      clientVersion: "0.1.0-preview.0",
      codexHomePath: path.join(runtime, "route-b-codex-home"),
      providerRoute: endpoint,
    });
    expect(
      (await fs.stat(path.join(runtime, "route-b-codex-home"))).mode & 0o777,
    ).toBe(0o700);
    expect(route).toHaveBeenCalledWith(expect.anything(), {
      model: "farol-next/mind",
      cwd: runtime,
      prompt: ROUTE_B_CHECK_PROMPT,
      timeoutMs: 120_000,
    });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("reports a start failure as not run and a later failure as unknown, never retrying", async () => {
    const runtime = await runtimeRoot();
    const input = {
      executablePath: "/usr/local/bin/codex",
      runtimeRoot: runtime,
      homePath: "/Users/example",
      tempPath: os.tmpdir(),
      clientVersion: "0.1.0-preview.0",
      endpoint,
    };

    await expect(
      runRouteBHostCheck(input, {
        launch: async () => {
          throw new Error("CODEX_APP_SERVER_START_FAILED");
        },
        route: vi.fn(),
      }),
    ).resolves.toEqual({ status: "failed", code: "ROUTE_B_HOST_START_FAILED" });

    const close = vi.fn(async () => undefined);
    const route = vi.fn(async () => {
      throw new Error("CODEX_CHATGPT_TURN_TIMEOUT");
    });
    await expect(
      runRouteBHostCheck(input, { launch: async () => ({ close }), route }),
    ).resolves.toEqual({
      status: "outcome_unknown",
      code: "CODEX_CHATGPT_TURN_TIMEOUT",
    });
    expect(route).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
