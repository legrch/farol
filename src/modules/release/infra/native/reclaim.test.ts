import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createLeaseWriter,
  LEASE_FILE,
  readProcessIdentity,
  LEASE_SCHEMA,
  type ProcessRead,
} from "./lease";
import { captureInstalledProcessStart } from "./installed-update-helper";
import { reclaimExtractions } from "./reclaim";
import { createUpdatePackageVerifier } from "./update-package-verifier";
import type { ReleaseManifest } from "../../domain/github-release-contract";

// Real directories in a disposable home; the process table is scripted, so no
// `ps` runs. Each pid maps to what `ps -p <pid> -o lstart=` would answer.
const manifest: ReleaseManifest = {
  schema: "farol.github-release/1",
  repository: "legrch/farol",
  channel: "owner-beta",
  product: "Farol",
  bundleId: "io.github.legrch.farol",
  version: "0.1.1-owner.beta.1",
  buildVersion: "2",
  sourceCommit: "a".repeat(40),
  sourceTreeDigest: "b".repeat(64),
  buildId: "c".repeat(64),
  artifactSha256: "d".repeat(64),
  archiveSha256: "e".repeat(64),
  archiveName: "Farol-0.1.1-owner.beta.1-darwin-arm64.zip",
  archiveSize: 1024,
  platform: "darwin",
  arch: "arm64",
  signing: "unsigned",
  notarized: false,
  sourceDirty: false,
};
const OWNER_START = "Fri Nov 20 10:00:00 2026";
const LATER_START = "Fri Nov 20 11:00:00 2026";
const EARLIER_START = "Fri Nov 20 09:00:00 2026";
const NOW = Date.UTC(2026, 10, 26, 12, 0, 0);
const HOUR = 3_600_000;
type Probe = string | "absent" | "failed";
let home: string;
let root: string;
let table: Map<number, Probe>;
let removed: string[];
let logs: string[];
const read: ProcessRead = async (pid) => {
  const probe = table.get(pid) ?? "absent";
  if (probe === "failed") throw new Error("ps unavailable");
  if (probe === "absent")
    throw Object.assign(new Error("exit 1"), {
      code: 1,
      stdout: "",
      stderr: "",
    });
  return { stdout: `${probe}\n`, stderr: "" };
};
function ports(
  overrides: Partial<Parameters<typeof reclaimExtractions>[0]> = {},
) {
  return {
    root,
    uid: process.getuid?.(),
    read,
    removeDirectory: async (directory: string, force: boolean) => {
      removed.push(directory);
      await fs.rm(directory, { recursive: true, force });
    },
    now: () => NOW,
    log: (message: string) => logs.push(message),
    zone: null,
    ...overrides,
  };
}
type Child = {
  pid: number;
  processStart: string | null;
  startedAtMs: number | null;
};
const child = (
  pid: number,
  processStart: string | null = OWNER_START,
): Child => ({
  pid,
  processStart,
  startedAtMs: processStart === null ? null : Date.parse(processStart),
});
type LeaseInput = Partial<{
  ownerPid: number;
  ownerProcessStart: string;
  phase: "created" | "spawning" | "spawned";
  updatedAt: number;
  createdAt: number;
  handle: string;
  ownerStartedAtMs: number | null;
  zone: string | null;
  children: Child[];
}>;
const HANDLE = () => path.join(root, "github-updates/archive.zip");
function leaseContent(patch: LeaseInput & Record<string, unknown> = {}) {
  const updatedAt = patch.updatedAt ?? NOW - HOUR;
  return {
    schema: LEASE_SCHEMA,
    ownerPid: 5000,
    ownerProcessStart: OWNER_START,
    ownerStartedAtMs: Date.parse(OWNER_START),
    handle: HANDLE(),
    zone: null,
    phase: "created",
    createdAt: Math.min(NOW - 2 * HOUR, updatedAt),
    updatedAt,
    children: [],
    ...patch,
  };
}
async function extraction(
  parent: string,
  name: string,
  options: {
    lease?: LeaseInput | "none" | "corrupt";
    mode?: number;
    age?: number;
  } = {},
): Promise<string> {
  const directory = path.join(parent, `farol-update-verify-${name}`);
  await fs.mkdir(directory, { mode: options.mode ?? 0o700 });
  await fs.chmod(directory, options.mode ?? 0o700);
  await fs.mkdir(path.join(directory, "Farol.app/Contents"), {
    recursive: true,
  });
  await fs.writeFile(path.join(directory, "Farol.app/Contents/payload"), "x");
  await fs.writeFile(path.join(directory, ".update_archive.py"), "x", {
    mode: 0o700,
  });
  const lease = options.lease ?? {};
  if (lease === "corrupt")
    await fs.writeFile(path.join(directory, LEASE_FILE), "{ not json", {
      mode: 0o600,
    });
  else if (lease !== "none")
    await fs.writeFile(
      path.join(directory, LEASE_FILE),
      JSON.stringify(leaseContent(lease)),
      { mode: 0o600 },
    );
  if (options.age !== undefined) {
    const when = new Date(NOW - options.age);
    await fs.utimes(directory, when, when);
  }
  return directory;
}
const exists = (file: string) =>
  fs.lstat(file).then(
    () => true,
    () => false,
  );
beforeEach(async () => {
  home = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "farol-reclaim-")),
  );
  root = path.join(home, "installed-updates");
  await fs.mkdir(root, { mode: 0o700 });
  await fs.chmod(root, 0o700);
  table = new Map();
  removed = [];
  logs = [];
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(home, { recursive: true, force: true });
});

describe("leaked verifier extraction reclaim: containment", () => {
  it("refuses a symlink and leaves its target alone", async () => {
    const outside = path.join(home, "outside");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "precious"), "keep");
    await fs.symlink(outside, path.join(root, "farol-update-verify-link"));
    const report = await reclaimExtractions(ports());
    expect(report.complete).toBe(false);
    expect(report.kept).toEqual([
      expect.objectContaining({ reason: "identity mismatch" }),
    ]);
    expect(await exists(path.join(outside, "precious"))).toBe(true);
    expect(removed).toEqual([]);
  });
  it("touches nothing when the directories belong to another user", async () => {
    const directory = await extraction(root, "a");
    const report = await reclaimExtractions(
      ports({ uid: (process.getuid?.() ?? 0) + 1 }),
    );
    // The staging root itself fails the owner check, so no entry is scanned.
    expect(report.unscanned).toEqual([root]);
    expect(report.complete).toBe(false);
    expect(await exists(directory)).toBe(true);
    expect(removed).toEqual([]);
  });
  it("refuses an entry owned by an unknown user (no uid on this platform)", async () => {
    const directory = await extraction(root, "a");
    const report = await reclaimExtractions(ports({ uid: undefined }));
    expect(report.complete).toBe(false);
    expect(await exists(directory)).toBe(true);
  });
  it("refuses an entry whose mode is not 0700", async () => {
    const directory = await extraction(root, "a", { mode: 0o755 });
    const report = await reclaimExtractions(ports());
    expect(report.kept).toEqual([
      expect.objectContaining({ reason: "identity mismatch" }),
    ]);
    expect(await exists(directory)).toBe(true);
  });
  it("refuses a regular file with the extraction name", async () => {
    const file = path.join(root, "farol-update-verify-file");
    await fs.writeFile(file, "x");
    const report = await reclaimExtractions(ports());
    expect(report.kept).toHaveLength(1);
    expect(await exists(file)).toBe(true);
  });
  it("never descends into a directory that is not a staging parent", async () => {
    const nested = await extraction(root, "outer");
    // A symlinked download directory and an extraction that is not a direct
    // child of a staging parent are never scanned.
    const stray = path.join(home, "stray");
    await fs.mkdir(stray, { mode: 0o700 });
    const inner = await extraction(stray, "inner");
    await fs.symlink(stray, path.join(root, `download-${"a".repeat(32)}`));
    const report = await reclaimExtractions(ports());
    expect(await exists(inner)).toBe(true);
    expect(await exists(nested)).toBe(false);
    // The unscannable staging parent leaves the outcome unknown.
    expect(report.complete).toBe(false);
  });
  it("scans only root and download-<32 hex> directories", async () => {
    const download = path.join(
      root,
      `download-${"0123456789abcdef".repeat(2)}`,
    );
    await fs.mkdir(download, { mode: 0o700 });
    await fs.chmod(download, 0o700);
    const other = path.join(root, "download-not-hex");
    await fs.mkdir(other, { mode: 0o700 });
    const inDownload = await extraction(download, "a");
    const inOther = await extraction(other, "b");
    const operation = path.join(root, "f".repeat(32));
    await fs.mkdir(operation, { mode: 0o700 });
    const inOperation = await extraction(operation, "c");
    const report = await reclaimExtractions(ports());
    expect(report.complete).toBe(true);
    expect(await exists(inDownload)).toBe(false);
    expect(await exists(inOther)).toBe(true);
    expect(await exists(inOperation)).toBe(true);
  });
  it("refuses a download directory it does not own", async () => {
    const download = path.join(root, `download-${"a".repeat(32)}`);
    await fs.mkdir(download, { mode: 0o700 });
    const inside = await extraction(download, "a");
    const report = await reclaimExtractions(
      ports({ uid: (process.getuid?.() ?? 0) + 1 }),
    );
    expect(report.complete).toBe(false);
    expect(await exists(inside)).toBe(true);
  });
});

describe("leaked verifier extraction reclaim: liveness", () => {
  it("reclaims an extraction whose owner and children have ended", async () => {
    const directory = await extraction(root, "a", {
      lease: {
        phase: "spawned",
        children: [child(6000)],
      },
    });
    const report = await reclaimExtractions(ports());
    expect(report).toMatchObject({ complete: true, kept: [] });
    expect(report.reclaimed).toEqual([directory]);
    expect(await exists(directory)).toBe(false);
  });
  it("keeps an extraction whose owner is still running", async () => {
    table.set(5000, OWNER_START);
    const directory = await extraction(root, "a");
    const report = await reclaimExtractions(ports());
    expect(report.complete).toBe(false);
    expect(report.kept).toEqual([{ entry: directory, reason: "live owner" }]);
    expect(await exists(directory)).toBe(true);
  });
  it("keeps an extraction whose extractor child is still running", async () => {
    table.set(6000, OWNER_START);
    const directory = await extraction(root, "a", {
      lease: {
        phase: "spawned",
        children: [child(6000)],
      },
    });
    const report = await reclaimExtractions(ports());
    expect(report.kept).toEqual([{ entry: directory, reason: "live child" }]);
    expect(await exists(directory)).toBe(true);
  });
  it("keeps an extraction when the process table cannot be read", async () => {
    table.set(5000, "failed");
    const directory = await extraction(root, "a");
    const report = await reclaimExtractions(ports());
    expect(report.kept).toEqual([
      { entry: directory, reason: "unknown liveness" },
    ]);
    expect(await exists(directory)).toBe(true);
  });
  it("keeps an extraction whose child start was never recorded while its pid runs", async () => {
    table.set(6000, LATER_START);
    const directory = await extraction(root, "a", {
      lease: {
        phase: "spawned",
        children: [child(6000, null)],
      },
    });
    const report = await reclaimExtractions(ports());
    expect(report.kept).toEqual([
      { entry: directory, reason: "unknown liveness" },
    ]);
  });
  it("reclaims once a child whose start was never recorded has exited", async () => {
    const directory = await extraction(root, "a", {
      lease: {
        phase: "spawned",
        children: [child(6000, null)],
      },
    });
    await reclaimExtractions(ports());
    expect(await exists(directory)).toBe(false);
  });
  it("treats a pid reused by a later process as ended", async () => {
    table.set(5000, LATER_START);
    const directory = await extraction(root, "a");
    await reclaimExtractions(ports());
    expect(await exists(directory)).toBe(false);
  });
  it("does not treat a different start that is not later as ended", async () => {
    table.set(5000, EARLIER_START);
    const directory = await extraction(root, "a");
    const report = await reclaimExtractions(ports());
    expect(report.kept).toEqual([
      { entry: directory, reason: "unknown liveness" },
    ]);
  });
  it("never reclaims a spawning lease on elapsed time alone", async () => {
    // Its owner has ended, but a child it started may be alive and unlisted,
    // and that child's own timeout died with the owner.
    const minutes = await extraction(root, "minutes", {
      lease: { phase: "spawning", updatedAt: NOW - 20 * 60_000 },
    });
    const hours = await extraction(root, "hours", {
      lease: { phase: "spawning", updatedAt: NOW - 23 * HOUR },
    });
    const future = await extraction(root, "future", {
      lease: { phase: "spawning", updatedAt: NOW + 60_000 },
    });
    const report = await reclaimExtractions(ports());
    expect(report.kept).toEqual(
      expect.arrayContaining([
        { entry: minutes, reason: "spawning window" },
        { entry: hours, reason: "spawning window" },
        { entry: future, reason: "spawning window" },
      ]),
    );
    for (const entry of [minutes, hours, future])
      expect(await exists(entry)).toBe(true);
  });
  it.each([
    ["25 hours", 25 * HOUR],
    ["3 days", 3 * 24 * HOUR],
    ["5 days", 5 * 24 * HOUR],
  ])(
    "keeps a spawning lease whose owner ended, however old: %s",
    async (_name, age) => {
      // The owner died after spawning a child and before recording its pid,
      // and the machine slept: no age shows the unlisted child exited.
      const old = await extraction(root, "old", {
        lease: {
          phase: "spawning",
          createdAt: NOW - age - HOUR,
          updatedAt: NOW - age,
        },
      });
      const report = await reclaimExtractions(ports());
      expect(report.reclaimed).toEqual([]);
      expect(report.kept).toEqual([{ entry: old, reason: "spawning window" }]);
      expect(report.complete).toBe(false);
      expect(await exists(old)).toBe(true);
    },
  );
  it("still reclaims a lease that names every child it spawned once each exited", async () => {
    // Named and exited children: the owner and both children are gone.
    const done = await extraction(root, "done", {
      lease: {
        phase: "spawned",
        updatedAt: NOW - 25 * HOUR,
        children: [child(6000, LATER_START), child(6001, LATER_START)],
      },
    });
    const report = await reclaimExtractions(ports());
    expect(report.reclaimed).toEqual([done]);
    expect(await exists(done)).toBe(false);
  });
  it("keeps an aged spawning lease while its owner still runs", async () => {
    table.set(5000, OWNER_START);
    const old = await extraction(root, "old", {
      lease: { phase: "spawning", updatedAt: NOW - 25 * HOUR },
    });
    const report = await reclaimExtractions(ports());
    expect(report.kept).toEqual([{ entry: old, reason: "live owner" }]);
  });
  it("keeps an extraction whose live child was recorded without its start", async () => {
    table.set(6000, LATER_START);
    const directory = await extraction(root, "a", {
      lease: {
        phase: "spawned",
        updatedAt: NOW - 30 * HOUR,
        children: [child(6000, null)],
      },
    });
    const report = await reclaimExtractions(ports());
    expect(report.kept).toEqual([
      { entry: directory, reason: "unknown liveness" },
    ]);
  });
  it("keeps a spawning lease with a live owner as a live owner", async () => {
    table.set(5000, OWNER_START);
    const directory = await extraction(root, "a", {
      lease: { phase: "spawning", updatedAt: NOW - HOUR },
    });
    const report = await reclaimExtractions(ports());
    expect(report.kept).toEqual([{ entry: directory, reason: "live owner" }]);
  });
  it.skipIf(process.platform !== "darwin")(
    "keeps a real extraction leased by this live process",
    async () => {
      const directory = await extraction(root, "real", { lease: "none" });
      const processTable: ProcessRead = async (pid) => ({
        stdout: await captureInstalledProcessStart(pid),
        stderr: "",
      });
      const owner = await readProcessIdentity(process.pid, processTable);
      expect(owner).not.toBeNull();
      await createLeaseWriter({
        directory,
        ownerPid: process.pid,
        owner: owner!,
        handle: HANDLE(),
        zone: process.env["TZ"] ?? null,
        now: () => Date.now(),
      }).create();
      const report = await reclaimExtractions({
        root,
        uid: process.getuid?.(),
        read: processTable,
        removeDirectory: async (target, force) =>
          fs.rm(target, { recursive: true, force }),
        now: () => Date.now(),
        log: () => undefined,
      });
      expect(report.kept).toEqual([{ entry: directory, reason: "live owner" }]);
      expect(await exists(directory)).toBe(true);
    },
  );
});

describe("leaked verifier extraction reclaim: leaseless legacy entries", () => {
  it("reclaims a leaseless entry older than 24 hours", async () => {
    const directory = await extraction(root, "a", {
      lease: "none",
      age: 25 * HOUR,
    });
    const report = await reclaimExtractions(ports());
    expect(report.complete).toBe(true);
    expect(await exists(directory)).toBe(false);
  });
  it("keeps a leaseless entry younger than 24 hours", async () => {
    const directory = await extraction(root, "a", {
      lease: "none",
      age: 23 * HOUR,
    });
    const report = await reclaimExtractions(ports());
    expect(report.kept).toEqual([
      { entry: directory, reason: "legacy entry too recent" },
    ]);
    expect(await exists(directory)).toBe(true);
  });
  it("keeps an old leaseless entry beside a live lease-bearing owner", async () => {
    table.set(5000, OWNER_START);
    const live = await extraction(root, "live");
    const legacy = await extraction(root, "legacy", {
      lease: "none",
      age: 48 * HOUR,
    });
    const report = await reclaimExtractions(ports());
    expect(report.kept).toEqual(
      expect.arrayContaining([
        { entry: live, reason: "live owner" },
        { entry: legacy, reason: "live owner in parent" },
      ]),
    );
    expect(await exists(legacy)).toBe(true);
  });
  it("keeps an old leaseless entry beside an owner whose liveness is unknown", async () => {
    table.set(5000, "failed");
    await extraction(root, "unknown");
    const legacy = await extraction(root, "legacy", {
      lease: "none",
      age: 48 * HOUR,
    });
    await reclaimExtractions(ports());
    expect(await exists(legacy)).toBe(true);
  });
  it("is not held back by a live owner in another staging parent", async () => {
    table.set(5000, OWNER_START);
    const download = path.join(root, `download-${"b".repeat(32)}`);
    await fs.mkdir(download, { mode: 0o700 });
    await fs.chmod(download, 0o700);
    await extraction(download, "live");
    const legacy = await extraction(root, "legacy", {
      lease: "none",
      age: 48 * HOUR,
    });
    await reclaimExtractions(ports());
    expect(await exists(legacy)).toBe(false);
  });
  it("keeps an entry whose lease is present but unreadable, however old", async () => {
    const corrupt = await extraction(root, "corrupt", {
      lease: "corrupt",
      age: 48 * HOUR,
    });
    const report = await reclaimExtractions(ports());
    expect(report.kept).toEqual([
      { entry: corrupt, reason: "lease unreadable" },
    ]);
    expect(await exists(corrupt)).toBe(true);
  });
  it.each([
    [
      "a lease from a newer schema",
      { schema: "farol.update-extraction-lease/2" },
    ],
    ["a lease with an unknown field", { extra: true }],
  ])("keeps an entry with %s", async (_name, patch) => {
    const directory = await extraction(root, "a", { age: 48 * HOUR });
    const file = path.join(directory, LEASE_FILE);
    await fs.writeFile(
      file,
      JSON.stringify({
        ...JSON.parse(await fs.readFile(file, "utf8")),
        ...patch,
      }),
    );
    const report = await reclaimExtractions(ports());
    expect(report.kept).toEqual([
      { entry: directory, reason: "lease unreadable" },
    ]);
  });
  it("keeps an entry whose lease is not a regular file", async () => {
    const directory = await extraction(root, "a", { lease: "none" });
    await fs.mkdir(path.join(directory, LEASE_FILE));
    const report = await reclaimExtractions(ports());
    expect(report.kept).toEqual([
      { entry: directory, reason: "lease unreadable" },
    ]);
  });
  it("does not let an unreadable lease's neighbour be judged legacy", async () => {
    await extraction(root, "corrupt", { lease: "corrupt" });
    const legacy = await extraction(root, "legacy", {
      lease: "none",
      age: 48 * HOUR,
    });
    await reclaimExtractions(ports());
    expect(await exists(legacy)).toBe(true);
  });
});

describe("leaked verifier extraction reclaim: removal", () => {
  it("removes the lease last and the directory itself at the end", async () => {
    const directory = await extraction(root, "a");
    await reclaimExtractions(ports());
    const order = removed.filter((entry) => entry.startsWith(directory));
    expect(order.at(-2)).toBe(path.join(directory, LEASE_FILE));
    expect(order.at(-1)).toBe(directory);
    expect(order.indexOf(path.join(directory, LEASE_FILE))).toBeGreaterThan(
      order.indexOf(path.join(directory, "Farol.app")),
    );
  });
  it("keeps the entry, its lease and the outcome when removal fails partway", async () => {
    const directory = await extraction(root, "a");
    const report = await reclaimExtractions(
      ports({
        removeDirectory: async (target, force) => {
          if (target.endsWith("Farol.app")) throw new Error("EBUSY");
          await fs.rm(target, { recursive: true, force });
        },
      }),
    );
    expect(report.complete).toBe(false);
    expect(report.kept).toEqual([
      { entry: directory, reason: "removal failed" },
    ]);
    expect(await exists(path.join(directory, LEASE_FILE))).toBe(true);
    expect(await exists(directory)).toBe(true);
  });
  it("stops, and removes nothing else, when the directory is replaced mid-removal", async () => {
    const directory = await extraction(root, "a");
    let swapped = false;
    const report = await reclaimExtractions(
      ports({
        removeDirectory: async (target, force) => {
          if (!swapped) {
            swapped = true;
            await fs.rename(directory, `${directory}.moved`);
            await fs.mkdir(directory, { mode: 0o700 });
            await fs.writeFile(path.join(directory, "replacement"), "keep");
          }
          await fs.rm(target, { recursive: true, force });
        },
      }),
    );
    // The extraction is a link in the chain: its swap abandons the parent.
    expect(report.kept).toEqual([]);
    expect(report.unscanned).toEqual([root]);
    expect(report.complete).toBe(false);
    expect(logs.join("\n")).toContain("parent identity changed");
    expect(await exists(path.join(directory, "replacement"))).toBe(true);
  });
  it("refuses to follow a symlink swapped in between two removal steps", async () => {
    const directory = await extraction(root, "a");
    const outside = path.join(home, "outside");
    await fs.mkdir(path.join(outside, "Farol.app"), { recursive: true });
    await fs.writeFile(path.join(outside, ".update_archive.py"), "keep");
    await fs.writeFile(path.join(outside, LEASE_FILE), "keep");
    let calls = 0;
    const report = await reclaimExtractions(
      ports({
        removeDirectory: async (target, force) => {
          await fs.rm(target, { recursive: true, force });
          if (++calls === 1) {
            await fs.rename(directory, `${directory}.moved`);
            await fs.symlink(outside, directory);
          }
        },
      }),
    );
    expect(calls).toBe(1);
    // The extraction is a link in the chain: its swap abandons the parent.
    expect(report.kept).toEqual([]);
    expect(report.unscanned).toEqual([root]);
    expect(report.complete).toBe(false);
    expect(logs.join("\n")).toContain("parent identity changed");
    expect(await fs.readdir(outside)).toEqual(
      expect.arrayContaining([".update_archive.py", LEASE_FILE, "Farol.app"]),
    );
  });
  it("refuses a directory replaced by another real directory between steps", async () => {
    const directory = await extraction(root, "a");
    let calls = 0;
    const report = await reclaimExtractions(
      ports({
        removeDirectory: async (target, force) => {
          await fs.rm(target, { recursive: true, force });
          if (++calls === 1) {
            await fs.rename(directory, `${directory}.moved`);
            await fs.mkdir(path.join(directory, "Farol.app"), {
              recursive: true,
              mode: 0o700,
            });
          }
        },
      }),
    );
    expect(calls).toBe(1);
    // The extraction is a link in the chain: its swap abandons the parent.
    expect(report.kept).toEqual([]);
    expect(report.unscanned).toEqual([root]);
    expect(report.complete).toBe(false);
    expect(logs.join("\n")).toContain("parent identity changed");
    expect(await exists(path.join(directory, "Farol.app"))).toBe(true);
  });
  it("continues with the other entries after one removal fails", async () => {
    const failing = await extraction(root, "a");
    const fine = await extraction(root, "b");
    const report = await reclaimExtractions(
      ports({
        removeDirectory: async (target, force) => {
          if (target.startsWith(failing) && target.endsWith("Farol.app"))
            throw new Error("EBUSY");
          await fs.rm(target, { recursive: true, force });
        },
      }),
    );
    expect(report.reclaimed).toEqual([fine]);
    expect(await exists(failing)).toBe(true);
  });
  it("logs every kept entry with its reason", async () => {
    table.set(5000, OWNER_START);
    const live = await extraction(root, "live");
    await reclaimExtractions(ports());
    expect(logs).toEqual([expect.stringContaining("live owner")]);
    expect(logs[0]).toContain(live);
  });
  it("reports complete for an empty staging root", async () => {
    expect(await reclaimExtractions(ports())).toEqual({
      complete: true,
      reclaimed: [],
      kept: [],
      unscanned: [],
      scanned: [expect.objectContaining({ path: root })],
      root: expect.anything(),
      incomplete: false,
      errors: [],
    });
  });
  it("reports an unreadable staging root as incomplete", async () => {
    const report = await reclaimExtractions(
      ports({ root: path.join(home, "missing") }),
    );
    expect(report.complete).toBe(false);
    expect(report.unscanned).toEqual([path.join(home, "missing")]);
  });
});

describe("leaked verifier extraction reclaim: the identity of every directory on the way", () => {
  const downloadName = `download-${"a".repeat(32)}`;
  async function downloadParent() {
    const parent = path.join(root, downloadName);
    await fs.mkdir(parent, { mode: 0o700 });
    await fs.chmod(parent, 0o700);
    return parent;
  }
  async function outsideTree() {
    const outside = path.join(home, "outside");
    await fs.mkdir(outside, { mode: 0o700 });
    await fs.chmod(outside, 0o700);
    const stray = await extraction(outside, "stray");
    return { outside, stray };
  }
  it("abandons a download parent that became a symlink after discovery", async () => {
    const parent = await downloadParent();
    await extraction(parent, "inside");
    const { outside, stray } = await outsideTree();
    const report = await reclaimExtractions(
      ports({
        afterDiscovery: async (candidate) => {
          if (candidate !== parent) return;
          await fs.rename(parent, `${parent}.moved`);
          await fs.symlink(outside, parent);
        },
      }),
    );
    expect(report.complete).toBe(false);
    expect(report.unscanned).toEqual([parent]);
    expect(logs.join("\n")).toContain("parent identity changed");
    expect(await exists(stray)).toBe(true);
    expect(await exists(path.join(stray, LEASE_FILE))).toBe(true);
    expect(removed).toEqual([]);
  });
  it("abandons a parent replaced by another real directory after discovery", async () => {
    const parent = await downloadParent();
    const inside = await extraction(parent, "inside");
    const report = await reclaimExtractions(
      ports({
        afterDiscovery: async (candidate) => {
          if (candidate !== parent) return;
          await fs.rename(parent, `${parent}.moved`);
          await fs.mkdir(parent, { mode: 0o700 });
          await fs.chmod(parent, 0o700);
          await extraction(parent, "impostor");
        },
      }),
    );
    expect(report.unscanned).toEqual([parent]);
    expect(
      await exists(path.join(parent, "farol-update-verify-impostor")),
    ).toBe(true);
    expect(await exists(`${inside}`)).toBe(false);
    expect(removed).toEqual([]);
  });
  it("abandons everything when the update root itself is swapped after discovery", async () => {
    await extraction(root, "inside");
    const { outside, stray } = await outsideTree();
    const moved = `${root}.moved`;
    const report = await reclaimExtractions(
      ports({
        afterDiscovery: async (candidate) => {
          if (candidate !== root) return;
          await fs.rename(root, moved);
          await fs.symlink(outside, root);
        },
      }),
    );
    expect(report.unscanned).toEqual([root]);
    expect(await exists(stray)).toBe(true);
    expect(removed).toEqual([]);
    await fs.rm(root);
    await fs.rename(moved, root);
  });
  it("abandons a parent swapped for a symlink between two extractions", async () => {
    const parent = await downloadParent();
    const entries = [
      await extraction(parent, "a"),
      await extraction(parent, "b"),
    ];
    const { stray } = await outsideTree();
    const { outside } = { outside: path.dirname(stray) };
    let swapped = false;
    const report = await reclaimExtractions(
      ports({
        removeDirectory: async (target, force) => {
          await fs.rm(target, { recursive: true, force });
          // The first extraction is gone once its own directory is removed.
          if (!swapped && entries.includes(target)) {
            swapped = true;
            await fs.rename(parent, `${parent}.moved`);
            await fs.symlink(outside, parent);
          }
        },
      }),
    );
    expect(report.reclaimed).toHaveLength(1);
    expect(report.unscanned).toEqual([parent]);
    expect(await exists(stray)).toBe(true);
    const remaining = entries.find((entry) => entry !== report.reclaimed[0])!;
    expect(
      await exists(path.join(`${parent}.moved`, path.basename(remaining))),
    ).toBe(true);
  });
  it("refuses a root reached through a symlinked ancestor", async () => {
    const alias = path.join(home, "alias");
    await fs.symlink(home, alias);
    const through = path.join(alias, "installed-updates");
    const inside = await extraction(root, "a");
    const report = await reclaimExtractions(ports({ root: through }));
    expect(report.unscanned).toEqual([through]);
    expect(await exists(inside)).toBe(true);
    expect(removed).toEqual([]);
  });
});

describe("leaked verifier extraction reclaim: the lease belongs to the inspected inode", () => {
  it("abandons the parent when the extraction is swapped while its lease is read", async () => {
    const directory = await extraction(root, "a");
    const other = await extraction(root, "b");
    const open = fs.open.bind(fs);
    let swapped = false;
    vi.spyOn(fs, "open").mockImplementation(async (file, ...rest) => {
      if (!swapped && String(file) === path.join(directory, LEASE_FILE)) {
        swapped = true;
        await fs.rename(directory, `${directory}.moved`);
        await fs.mkdir(directory, { mode: 0o700 });
        await fs.writeFile(path.join(directory, LEASE_FILE), "{}", {
          mode: 0o600,
        });
      }
      return open(file, ...rest);
    });
    const report = await reclaimExtractions(ports());
    expect(swapped).toBe(true);
    expect(report.unscanned).toEqual([root]);
    expect(report.reclaimed).toEqual([]);
    expect(report.complete).toBe(false);
    expect(removed).toEqual([]);
    expect(await exists(other)).toBe(true);
    expect(await exists(path.join(`${directory}.moved`, "Farol.app"))).toBe(
      true,
    );
  });
});

describe("leaked verifier extraction reclaim: a TZ override", () => {
  it("does not read a later start as a reused pid under another TZ", async () => {
    table.set(5000, LATER_START);
    const directory = await extraction(root, "a", {
      lease: { zone: "America/New_York" },
    });
    const report = await reclaimExtractions(ports({ zone: null }));
    expect(report.kept).toEqual([
      { entry: directory, reason: "unknown liveness" },
    ]);
    expect(await exists(directory)).toBe(true);
  });
  it("still reads a later start as a reused pid under the same TZ", async () => {
    table.set(5000, LATER_START);
    const directory = await extraction(root, "a", {
      lease: { zone: "America/New_York" },
    });
    await reclaimExtractions(ports({ zone: "America/New_York" }));
    expect(await exists(directory)).toBe(false);
  });
  it("still keeps a live process under another TZ", async () => {
    table.set(5000, OWNER_START);
    const directory = await extraction(root, "a", { lease: { zone: "UTC" } });
    const report = await reclaimExtractions(ports());
    expect(report.kept).toEqual([{ entry: directory, reason: "live owner" }]);
  });
  it("reports the update root it scanned", async () => {
    const report = await reclaimExtractions(ports());
    const stat = await fs.lstat(root, { bigint: true });
    expect(report.root).toEqual({ dev: stat.dev, ino: stat.ino });
  });
});

describe("leaked verifier extraction reclaim: untrusted and uninspectable entries", () => {
  const legacy = () =>
    extraction(root, "legacy", { lease: "none", age: 48 * HOUR });
  it("lets an extraction that cannot be inspected protect its leaseless neighbours", async () => {
    await extraction(root, "odd", { mode: 0o755 });
    const old = await legacy();
    await reclaimExtractions(ports());
    expect(await exists(old)).toBe(true);
    expect(logs.join("\n")).toContain("live owner in parent");
  });
  it.each([
    ["a handle outside the update root", { handle: "/elsewhere/archive.zip" }],
    ["a relative handle", { handle: "archive.zip" }],
    [
      "a handle that climbs out of the root",
      () => ({ handle: `${root}/../archive.zip` }),
    ],
    ["children listed in the created phase", { children: [child(6000)] }],
    ["the spawned phase with no child listed", { phase: "spawned" }],
    ["an update earlier than its creation", { createdAt: NOW - HOUR + 1_000 }],
    ["an update in the future", { updatedAt: NOW + 10 * 60_000 }],
    [
      "an owner that started after the lease was updated",
      { ownerStartedAtMs: NOW },
    ],
    [
      "a child that started after the lease was updated",
      {
        phase: "spawned",
        children: [{ pid: 6000, processStart: OWNER_START, startedAtMs: NOW }],
      },
    ],
  ] as [string, LeaseInput | (() => LeaseInput)][])(
    "keeps an entry whose lease has %s, and protects leaseless neighbours",
    async (_name, patch) => {
      const directory = await extraction(root, "a", {
        lease: typeof patch === "function" ? patch() : patch,
      });
      const old = await legacy();
      const report = await reclaimExtractions(ports());
      expect(report.kept).toEqual(
        expect.arrayContaining([
          { entry: directory, reason: "lease untrusted" },
        ]),
      );
      expect(await exists(directory)).toBe(true);
      expect(await exists(old)).toBe(true);
      expect(report.complete).toBe(false);
    },
  );
  it("keeps an entry whose child started before its owner", async () => {
    const directory = await extraction(root, "a", {
      lease: {
        phase: "spawned",
        children: [
          {
            pid: 6000,
            processStart: EARLIER_START,
            startedAtMs: Date.parse(EARLIER_START),
          },
        ],
      },
    });
    const report = await reclaimExtractions(ports());
    expect(report.kept).toEqual([
      { entry: directory, reason: "lease untrusted" },
    ]);
  });
  it("accepts a lease that holds together", async () => {
    const directory = await extraction(root, "a", {
      lease: {
        phase: "spawned",
        children: [child(6000)],
        updatedAt: NOW - 60_000,
      },
    });
    await reclaimExtractions(ports());
    expect(await exists(directory)).toBe(false);
  });
});

describe("leaked verifier extraction reclaim: capacity", () => {
  it("no longer reaches the verifier's capacity limit after a reclaim", async () => {
    await extraction(root, "a");
    await extraction(root, "b");
    const verifier = createUpdatePackageVerifier({
      stagingParent: root,
      extractorPath: path.join(home, "missing-extractor"),
      verifierPath: path.join(home, "missing-verifier"),
      archivePathForHandle: async (handle) => handle,
      processTable: async () => ({ stdout: `${OWNER_START}\n`, stderr: "" }),
    });
    await expect(
      verifier.verifyPackage("/archive.zip", manifest),
    ).rejects.toMatchObject({ code: "stage_capacity" });
    const report = await reclaimExtractions(ports());
    expect(report.complete).toBe(true);
    // Past the capacity scan, the missing pinned extractor is the next refusal.
    await expect(
      verifier.verifyPackage("/archive.zip", manifest),
    ).rejects.toMatchObject({ code: "invalid_stage" });
  });
});

describe("leaked verifier extraction reclaim: which parents the report says were scanned", () => {
  const name = `download-${"a".repeat(32)}`;
  async function parentDirectory(directoryName = name) {
    const parent = path.join(root, directoryName);
    await fs.mkdir(parent, { mode: 0o700 });
    await fs.chmod(parent, 0o700);
    return parent;
  }
  const identityOf = async (directory: string) => {
    const stat = await fs.lstat(directory, { bigint: true });
    return { path: directory, dev: stat.dev, ino: stat.ino };
  };

  it("lists the root and each download parent with the identity it captured", async () => {
    const parent = await parentDirectory();
    const second = await parentDirectory(`download-${"b".repeat(32)}`);
    const report = await reclaimExtractions(ports());
    expect(report.complete).toBe(true);
    expect(report.scanned).toHaveLength(3);
    expect(report.scanned).toEqual(
      expect.arrayContaining([
        await identityOf(root),
        await identityOf(parent),
        await identityOf(second),
      ]),
    );
  });
  it("does not list a parent the pass abandoned after discovery", async () => {
    const parent = await parentDirectory();
    const report = await reclaimExtractions(
      ports({
        afterDiscovery: async (candidate) => {
          if (candidate !== parent) return;
          await fs.rename(parent, `${parent}.moved`);
          await fs.mkdir(parent, { mode: 0o700 });
          await fs.chmod(parent, 0o700);
        },
      }),
    );
    expect(report.unscanned).toEqual([parent]);
    expect(report.scanned.map((item) => item.path)).toEqual([root]);
  });
  it("neither lists nor skips a parent that was absent at discovery and returned before the pass ended", async () => {
    // Renamed away before the pass reads the root, and back once the root's
    // names are already read: the pass never saw it, and says so by omission.
    const parent = await parentDirectory();
    await extraction(parent, "unseen");
    await fs.rename(parent, `${parent}.away`);
    const report = await reclaimExtractions(
      ports({
        afterDiscovery: async (candidate) => {
          if (candidate === root) await fs.rename(`${parent}.away`, parent);
        },
      }),
    );
    expect(await exists(path.join(parent, "farol-update-verify-unseen"))).toBe(
      true,
    );
    expect(report.unscanned).toEqual([]);
    expect(report.kept).toEqual([]);
    expect(report.scanned.map((item) => item.path)).toEqual([root]);
  });
});

describe("leaked verifier extraction reclaim: a stage's tombstone is the same stage", () => {
  const stageName = `download-${"a".repeat(32)}`;
  async function tombstone() {
    const directory = path.join(root, `${stageName}.removing`);
    await fs.mkdir(directory, { mode: 0o700 });
    await fs.chmod(directory, 0o700);
    return directory;
  }

  it("scans it as a staging parent and lists it with its identity", async () => {
    const directory = await tombstone();
    const stat = await fs.lstat(directory, { bigint: true });
    const report = await reclaimExtractions(ports());
    expect(report.scanned).toEqual(
      expect.arrayContaining([
        { path: directory, dev: stat.dev, ino: stat.ino },
      ]),
    );
  });
  it("reclaims an extraction in it by the same lease rules", async () => {
    const directory = await tombstone();
    const gone = await extraction(directory, "gone");
    const report = await reclaimExtractions(ports());
    expect(report.reclaimed).toEqual([gone]);
  });
  it("keeps a spawning lease in it, however old", async () => {
    const directory = await tombstone();
    const stuck = await extraction(directory, "stuck", {
      lease: { phase: "spawning", updatedAt: NOW - 3 * 24 * HOUR },
    });
    const report = await reclaimExtractions(ports());
    expect(report.kept).toEqual([{ entry: stuck, reason: "spawning window" }]);
    expect(await exists(stuck)).toBe(true);
  });
  it.each(["download-short.removing", `download-${"a".repeat(32)}.removing.x`])(
    "does not take %s for a staging parent",
    async (name) => {
      const other = path.join(root, name);
      await fs.mkdir(other, { mode: 0o700 });
      const report = await reclaimExtractions(ports());
      expect(report.scanned.map((item) => item.path)).toEqual([root]);
    },
  );
});

describe("leaked verifier extraction reclaim: an error on one entry", () => {
  const download = (letter: string) =>
    path.join(root, `download-${letter.repeat(32)}`);
  const parentOf = async (letter: string) => {
    await fs.mkdir(download(letter), { mode: 0o700 });
    await fs.chmod(download(letter), 0o700);
    return download(letter);
  };
  // The second `lstat` of one extraction is the one that confirms the lease
  // was read from the inode that was inspected.
  const failSecondLstat = (target: string, code = "EIO") => {
    const lstat = fs.lstat.bind(fs) as (...a: unknown[]) => Promise<unknown>;
    let seen = 0;
    vi.spyOn(fs, "lstat").mockImplementation((async (
      file: unknown,
      ...rest: unknown[]
    ) => {
      if (file === target && ++seen === 2)
        throw Object.assign(new Error(code), { code });
      return lstat(file, ...rest);
    }) as typeof fs.lstat);
  };

  it("returns a partial report that keeps what an earlier parent already judged", async () => {
    const first = await parentOf("a");
    const second = await parentOf("b");
    const spawning = await extraction(first, "kept", {
      lease: { phase: "spawning" },
    });
    const broken = await extraction(second, "broken");
    failSecondLstat(broken);
    const report = await reclaimExtractions(ports());
    expect(report.incomplete).toBe(true);
    expect(report.complete).toBe(false);
    expect(report.errors).toEqual([{ entry: broken, code: "EIO" }]);
    expect(report.kept).toEqual(
      expect.arrayContaining([
        { entry: spawning, reason: "spawning window" },
        { entry: broken, reason: "inspection failed" },
      ]),
    );
    expect(await exists(spawning)).toBe(true);
    expect(await exists(broken)).toBe(true);
  });
  it("never removes the entry it could not inspect, whatever its lease says", async () => {
    const broken = await extraction(root, "broken");
    failSecondLstat(broken);
    const report = await reclaimExtractions(ports());
    expect(report.reclaimed).toEqual([]);
    expect(removed).toEqual([]);
    expect(await exists(broken)).toBe(true);
  });
  it("keeps judging its neighbours, and shields a leaseless one from removal", async () => {
    const broken = await extraction(root, "broken");
    const abandoned = await extraction(root, "abandoned");
    const legacy = await extraction(root, "legacy", {
      lease: "none",
      age: 48 * HOUR,
    });
    failSecondLstat(broken);
    const report = await reclaimExtractions(ports());
    expect(report.reclaimed).toEqual([abandoned]);
    expect(report.kept).toEqual(
      expect.arrayContaining([
        { entry: broken, reason: "inspection failed" },
        { entry: legacy, reason: "live owner in parent" },
      ]),
    );
    expect(await exists(legacy)).toBe(true);
  });
  it("records an error that is not one entry's against its staging parent, unscanned", async () => {
    const first = await parentOf("a");
    const second = await parentOf("b");
    const spawning = await extraction(first, "kept", {
      lease: { phase: "spawning" },
    });
    const report = await reclaimExtractions(
      ports({
        afterDiscovery: async (parent) => {
          if (parent === second)
            throw Object.assign(new Error("EIO"), { code: "EIO" });
        },
      }),
    );
    expect(report.incomplete).toBe(true);
    expect(report.errors).toEqual([{ entry: second, code: "EIO" }]);
    expect(report.unscanned).toEqual([second]);
    expect(report.scanned.map((parent) => parent.path)).not.toContain(second);
    expect(report.kept).toEqual([
      { entry: spawning, reason: "spawning window" },
    ]);
  });
  it("is not incomplete when a parent merely changed under the scan", async () => {
    const directory = await extraction(root, "a");
    const open = fs.open.bind(fs);
    let swapped = false;
    vi.spyOn(fs, "open").mockImplementation(async (file, ...rest) => {
      if (!swapped && String(file) === path.join(directory, LEASE_FILE)) {
        swapped = true;
        await fs.rename(directory, `${directory}.moved`);
        await fs.mkdir(directory, { mode: 0o700 });
      }
      return open(file, ...rest);
    });
    const report = await reclaimExtractions(ports());
    expect(report.unscanned).toEqual([root]);
    expect(report.incomplete).toBe(false);
    expect(report.errors).toEqual([]);
  });
});
