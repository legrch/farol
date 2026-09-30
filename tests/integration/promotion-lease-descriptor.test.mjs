import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import {
  acquirePromotionLease,
  promotionLeaseDescriptor,
  releasePromotionLease,
} from "../../tooling/promotion-lease.mjs";

it("keeps the exact inherited kernel lease held after the launcher releases its descriptor", async () => {
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "farol-inherited-lease-"),
  );
  let lease;
  let child;
  let completion;
  try {
    lease = await acquirePromotionLease(root, "repair-fixture", "promotion");
    expect(lease).not.toBeNull();
    const fd = promotionLeaseDescriptor(lease);
    const opened = await fs.stat(lease.file);
    child = spawn(
      "/usr/bin/python3",
      [
        "-I",
        "-S",
        "-B",
        "-c",
        "import os,sys\ns=os.fstat(6)\nprint(str(s.st_dev)+':'+str(s.st_ino),flush=True)\nsys.stdin.buffer.read()",
      ],
      {
        stdio: ["pipe", "pipe", "pipe", "ignore", "ignore", "ignore", fd],
      },
    );
    completion = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    const identity = await new Promise((resolve, reject) => {
      child.stdout.once("data", (data) => resolve(data.toString().trim()));
      child.once("error", reject);
    });
    expect(identity).toBe(`${opened.dev}:${opened.ino}`);
    await releasePromotionLease(lease);
    expect(() => promotionLeaseDescriptor(lease)).toThrow(
      "PROMOTION_LEASE_NOT_HELD",
    );
    expect(
      await acquirePromotionLease(root, "competing-fixture", "admission"),
    ).toBeNull();
    child.stdin.end();
    expect(await completion).toEqual({ code: 0, signal: null });
    child = null;
    lease = await acquirePromotionLease(root, "after-helper-exit", "promotion");
    expect(lease).not.toBeNull();
  } finally {
    if (child) {
      child.kill("SIGKILL");
      await completion;
    }
    if (lease) await releasePromotionLease(lease);
    await fs.rm(root, { recursive: true, force: true });
  }
}, 10000);
