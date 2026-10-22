import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { parse } from "@babel/parser";
import { expect, it } from "vitest";

// Execute the actual case loop, cleanup, private reader and report writer with
// controlled lifecycle failures. No Electron, signal or native process is run.
const source = await fs.readFile(
  new URL("../e2e/connector-daily-lifecycle.e2e.mjs", import.meta.url),
  "utf8",
);
const tree = parse(source, { sourceType: "module" });
const definitions = tree.program.body
  .filter(
    (node) =>
      (node.type === "FunctionDeclaration" &&
        ["bounded", "privateJson", "collectTunnelTraces", "dispose"].includes(
          node.id.name,
        )) ||
      (node.type === "VariableDeclaration" &&
        node.declarations.some(
          (declaration) => declaration.id.name === "failure",
        )),
  )
  .map((node) => source.slice(node.start, node.end))
  .join("\n");
const finalLoop = tree.program.body.find(
  (node) =>
    node.type === "VariableDeclaration" &&
    node.declarations.some((declaration) => declaration.id.name === "primary"),
);
const program = `(async () => { ${definitions}\n${source.slice(finalLoop.start)} })()`;
const id = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const events = [
  "started",
  "term-received",
  "exit-started",
  "exit-receipt-write-started",
  "exit-receipt-written",
].map((event) => ({ event, at: "2026-10-22T12:00:00.000Z", monotonicNs: "1" }));

it.each(["recovery-timeout", "quit-process-absence", "quit-receipt"])(
  "writes available traces into the actual report after %s",
  async (point) => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "daily-trace-report-"),
    );
    try {
      const state = path.join(root, "connector/state");
      await fs.mkdir(state, { recursive: true, mode: 0o700 });
      await fs.writeFile(
        path.join(state, `daily-tunnel-${id}.json.trace.json`),
        JSON.stringify(events),
        { mode: 0o600 },
      );
      // An invalid receipt cannot gate independent trace discovery. The second
      // trace also fails: it must not erase the first journal or primary error.
      await fs.writeFile(
        path.join(state, `daily-tunnel-${id}.json`),
        "invalid",
      );
      await fs.writeFile(
        path.join(state, `daily-tunnel-${otherId}.json.trace.json`),
        "invalid",
        { mode: 0o600 },
      );
      const report = { cases: [] };
      const destination = path.join(root, "report.json");
      const original = new Error(
        point === "recovery-timeout"
          ? "DAILY_ORIGINAL_TUNNEL_EXIT_TIMEOUT"
          : point === "quit-process-absence"
            ? "DAILY_PROCESS_STILL_PRESENT"
            : "DAILY_QUIT_RECEIPT_INVALID",
      );
      let cases = 0;
      const run = {
        connectorRoot: path.dirname(state),
        peers: [],
        // Trace discovery also works before ownTunnel records any receipt.
        tunnels: [],
        application: {},
        isolated: true,
        quitAttempted: false,
        evidence: { disposal: [], observations: [] },
      };
      let cleanupQuit = false;
      await expect(
        runInNewContext(program, {
          fs,
          path,
          assert,
          constants,
          Buffer,
          process,
          setTimeout,
          clearTimeout,
          report,
          destination,
          console: { log() {} },
          fresh: async () => {
            cases++;
            report.cases.push(run.evidence);
            return run;
          },
          launch: async () => {},
          setup: async () => {},
          exercise: async () => {
            if (point === "recovery-timeout") throw original;
          },
          normalQuit: async () => {
            cleanupQuit = Boolean(run.evidence.failure);
            run.quitAttempted = true;
            throw cleanupQuit
              ? new Error("DAILY_NORMAL_QUIT_TIMEOUT")
              : original;
          },
          originalClose: async () => {
            throw new Error("DAILY_ORIGINAL_CLOSE_TIMEOUT");
          },
        }),
      ).rejects.toBe(original);
      const saved = JSON.parse(await fs.readFile(destination, "utf8"));
      expect(cases).toBe(1);
      expect(cleanupQuit).toBe(point === "recovery-timeout");
      expect(saved.status).toBe("failed");
      expect(saved.failure.code).toBe(original.message);
      expect(saved.cases[0]).toMatchObject({
        status: "failed",
        failure: { code: original.message },
        tunnelTraces: [events],
        tunnelTraceFailures: [
          { file: `daily-tunnel-${otherId}.json.trace.json` },
        ],
        cleanupFailures: expect.arrayContaining([
          { name: "Error", code: "DAILY_TUNNEL_TRACES_UNCONFIRMED" },
        ]),
      });
      // Failed evidence remains available, never removed as a successful run.
      expect(
        await fs.readFile(path.join(state, `daily-tunnel-${id}.json`), "utf8"),
      ).toBe("invalid");
    } finally {
      await fs.rm(root, { recursive: true });
    }
  },
);
