import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import * as desktop from "../../src/apps/desktop/promotion-lease.ts";
import * as tooling from "../../tooling/promotion-lease.mjs";
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

it.each([
  ["desktop", desktop],
  ["tooling", tooling],
])(
  "%s transfers the held inode once while the acknowledged child keeps exclusion",
  async (_name, api) => {
    const root = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "farol-transfer-lease-"),
    );
    let lease;
    let child;
    let completion;
    try {
      lease = await api.acquirePromotionLease(
        root,
        "closed-predecessor-fixture",
        "promotion",
      );
      expect(lease).not.toBeNull();
      const transfer = await api.createPromotionLeaseTransfer(lease);
      const record = await fs.readFile(lease.file, "utf8");
      child = spawn(
        process.execPath,
        [
          "-e",
          "const fs=require('node:fs');const s=fs.fstatSync(6,{bigint:true});process.stdout.write(s.dev+':'+s.ino+'\\n');process.stdin.resume();",
        ],
        {
          stdio: [
            "pipe",
            "pipe",
            "pipe",
            "ignore",
            "ignore",
            "ignore",
            transfer.descriptor,
          ],
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
      expect(identity).toBe(
        `${transfer.identity.device}:${transfer.identity.inode}`,
      );
      expect(await transfer.verify()).toBe(true);
      await transfer.release();
      expect(await transfer.verify()).toBe(false);
      await expect(transfer.release()).rejects.toThrow("ALREADY_RELEASED");
      await api.releasePromotionLease(lease);
      expect(await fs.readFile(lease.file, "utf8")).toBe(record);
      expect(
        await api.acquirePromotionLease(root, "competing-fixture", "admission"),
      ).toBeNull();
      child.stdin.end();
      expect(await completion).toEqual({ code: 0, signal: null });
      child = null;
      lease = await api.acquirePromotionLease(
        root,
        "after-helper-exit",
        "promotion",
      );
      expect(lease).not.toBeNull();
    } finally {
      if (child) {
        child.kill("SIGKILL");
        await completion;
      }
      if (lease) await api.releasePromotionLease(lease);
      await fs.rm(root, { recursive: true, force: true });
    }
  },
  10000,
);
