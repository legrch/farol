import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";

async function fixture() {
  const files = new Map();
  const process = Object.assign(new EventEmitter(), {
    argv: ["node", "fixture.cjs", "run"],
    env: { TUNNEL_CLIENT_STATE_DIR: "/owned/state" },
    pid: 43,
    ppid: 42,
    hrtime: { bigint: () => 1n },
    exit: (code) => {
      process.emit("exit", code);
    },
  });
  runInNewContext(
    await fs.readFile(
      new URL("../e2e/connector-daily-tunnel.fixture.cjs", import.meta.url),
      "utf8",
    ),
    {
      process,
      require: (name) => {
        if (name === "node:fs")
          return {
            writeFileSync: (file, bytes) => files.set(file, bytes),
            renameSync: (from, to) => {
              files.set(to, files.get(from));
              files.delete(from);
            },
          };
        if (name === "node:path") return path;
        if (name === "node:crypto") return { randomUUID: () => "owned-id" };
        if (name === "node:http") return { createServer: () => {} };
        if (name === "./tunnel-client.fixture.cjs") return {};
        throw new Error(name);
      },
    },
  );
  return {
    process,
    receipt: () =>
      JSON.parse(files.get("/owned/state/daily-tunnel-owned-id.json")),
    trace: () =>
      JSON.parse(
        files.get("/owned/state/daily-tunnel-owned-id.json.trace.json"),
      ),
  };
}

it("journals TERM delivery separately from the synchronous terminal receipt", async () => {
  const f = await fixture();
  f.process.emit("SIGTERM");
  expect(f.receipt()).toMatchObject({ phase: "running", exitCode: null });
  expect(f.trace().map((x) => x.event)).toEqual(["started", "term-received"]);
  f.process.emit("exit", 0);
  expect(f.receipt()).toMatchObject({
    phase: "exited",
    exitCode: 0,
    termRequested: true,
  });
  expect(f.trace().map((x) => x.event)).toEqual([
    "started",
    "term-received",
    "exit-started",
    "exit-receipt-write-started",
    "exit-receipt-written",
  ]);
});

it("does not manufacture a clean terminal receipt without the original exit", async () => {
  const f = await fixture();
  expect(f.receipt()).toMatchObject({
    phase: "running",
    exitCode: null,
    termRequested: false,
  });
  expect(f.trace().map((x) => x.event)).toEqual(["started"]);
  f.process.emit("exit", 65);
  expect(f.receipt()).toMatchObject({ phase: "exited", exitCode: 65 });
});
