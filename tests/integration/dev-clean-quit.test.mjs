import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  captureDevQuit,
  confirmedDevQuit,
} from "../../tooling/dev-clean-quit.mjs";
const roots = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => fs.rmSync(root, { recursive: true, force: true })),
);
function fixture() {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "farol-clean-quit-")),
  );
  roots.push(root);
  const now = Date.now(),
    pid = process.pid;
  const marker = {
    schema: 1,
    pid,
    startedAt: new Date(now - 1000).toISOString(),
    bootTime: null,
    processStart: null,
  };
  const quit = (at, drained = true, unconfirmed = []) =>
    fs.writeFileSync(
      path.join(root, "last-quit.json"),
      JSON.stringify({
        schema: 1,
        at: new Date(at).toISOString(),
        drained,
        unconfirmed,
      }),
      { mode: 0o600 },
    );
  fs.writeFileSync(path.join(root, "running.json"), JSON.stringify(marker), {
    mode: 0o600,
  });
  quit(now - 2000);
  return { root, now, pid, quit };
}
const terminal = { status: 0, signal: null };
it("accepts only actual zero close with a fresh drained receipt and removed original marker", () => {
  const f = fixture(),
    request = captureDevQuit(f.root, f.pid, f.now);
  f.quit(f.now + 1);
  expect(confirmedDevQuit(request, terminal, false, f.now + 2)).toBe(false);
  fs.unlinkSync(path.join(f.root, "running.json"));
  expect(confirmedDevQuit(request, terminal, false, f.now + 2)).toBe(true);
});
it.each([
  "old",
  "unconfirmed",
  "signal",
  "error",
  "escalated",
  "future",
  "root-changed",
  "receipt-link",
  "wrong-pid",
])("refuses %s without treating absence as clean Quit", (kind) => {
  const f = fixture(),
    request = captureDevQuit(
      f.root,
      kind === "wrong-pid" ? f.pid + 1 : f.pid,
      f.now,
    );
  fs.unlinkSync(path.join(f.root, "running.json"));
  if (kind !== "old")
    f.quit(
      kind === "future" ? f.now + 100 : f.now + 1,
      kind !== "unconfirmed",
      kind === "unconfirmed" ? ["go-core"] : [],
    );
  if (kind === "root-changed") {
    fs.renameSync(f.root, f.root + "-old");
    roots.push(f.root + "-old");
    fs.mkdirSync(f.root);
    f.quit(f.now + 1);
  }
  if (kind === "receipt-link") {
    fs.renameSync(
      path.join(f.root, "last-quit.json"),
      path.join(f.root, "other"),
    );
    fs.symlinkSync(
      path.join(f.root, "other"),
      path.join(f.root, "last-quit.json"),
    );
  }
  expect(
    confirmedDevQuit(
      request,
      kind === "signal"
        ? { status: null, signal: "SIGKILL" }
        : kind === "error"
          ? { ...terminal, error: Error("failed") }
          : terminal,
      kind === "escalated",
      f.now + 2,
    ),
  ).toBe(false);
});
